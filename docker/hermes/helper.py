#!/opt/hermes/.venv/bin/python
"""ClawHuddle's helper inside a Hermes instance.

Run by the API with `docker exec --user hermes`; every command ends with one
JSON object on stdout (`{"error": ...}` when it could not do what was asked). Only aggregates and status leave the container: never session
titles, message content, tokens or OAuth codes.

  usage <startDate> <endDate> <timeZone>   token/cost aggregates from state.db
  pairing-list <platform>                  pending pairing requests
  google-start                             {"auth_url": ...}
  google-finish <file> [email]             pasted redirect address read from <file>;
                                           [email] labels the account if Google won't say
  google-revoke                            disconnect the Google account
"""
import contextlib
import io
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or "/opt/data")
HERMES_ROOT = "/opt/hermes"
GOOGLE_SCRIPTS = f"{HERMES_ROOT}/skills/productivity/google-workspace/scripts"
# Written by google-finish so the Home card can name the connected account.
GOOGLE_LABEL = HERMES_HOME / ".clawhuddle-google.json"
CHANNEL_SOURCES = ("slack", "telegram", "discord")


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write("\n")


def fail(message):
    # Exit 0: the API reads the error from the JSON, and a non-zero exit would
    # make it prefer whatever a library printed on stderr.
    emit({"error": str(message)[:500]})
    sys.exit(0)


# --------------------------------------------------------------------------- usage

def _zero():
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "totalCost": 0.0, "missingCostEntries": 0}


def _add(total, inp, out, cread, cwrite, cost):
    inp, out, cread, cwrite = (int(v or 0) for v in (inp, out, cread, cwrite))
    total["input"] += inp
    total["output"] += out
    total["cacheRead"] += cread
    total["cacheWrite"] += cwrite
    total["totalTokens"] += inp + out + cread + cwrite
    if cost is None:
        if inp + out + cread + cwrite > 0:
            total["missingCostEntries"] += 1
    else:
        total["totalCost"] += float(cost)


def _tables(db):
    return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _columns(db, table):
    return {r[1] for r in db.execute(f"PRAGMA table_info({table})")}


def _cost(estimated, actual, status):
    """Hermes's cost for one row, or None when it had no price for the model.

    `actual_cost_usd` is 0.0, not NULL, when the provider reported no bill, and
    an unpriced model is stored as an estimate of 0.0 with status `unknown`.
    """
    if actual:
        return float(actual)
    if estimated is None or status == "unknown":
        return None
    return float(estimated)


def usage(start_date, end_date, tz_name):
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(tz_name)
    start = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=tz)
    end = datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=tz) + timedelta(days=1)
    result = {
        "totals": _zero(),
        "sessions": 0,
        "messages": {"user": 0, "assistant": 0, "toolCalls": 0, "errors": 0},
        "byModel": [],
        "byChannel": [],
        "daily": [],
    }
    path = HERMES_HOME / "state.db"
    if not path.exists():
        return result

    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=15)
    try:
        tables = _tables(db)
        if "sessions" not in tables:
            return result
        cols = _columns(db, "sessions")

        def col(name, fallback="NULL"):
            return name if name in cols else fallback

        rows = db.execute(
            f"""SELECT id, {col('source')}, {col('model')}, started_at, {col('tool_call_count', '0')},
                       {col('input_tokens', '0')}, {col('output_tokens', '0')},
                       {col('cache_read_tokens', '0')}, {col('cache_write_tokens', '0')},
                       {col('billing_provider')}, {col('estimated_cost_usd')}, {col('actual_cost_usd')},
                       {col('api_call_count', '0')}, {col('billing_base_url')}, {col('cost_status')}
                FROM sessions WHERE started_at >= ? AND started_at < ?""",
            (start.timestamp(), end.timestamp()),
        ).fetchall()
        if not rows:
            return result

        per_model = {}
        if "session_model_usage" in tables:
            for r in db.execute(
                """SELECT u.session_id, u.model, u.billing_provider, u.api_call_count,
                          u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
                          u.estimated_cost_usd, u.actual_cost_usd, u.billing_base_url, u.cost_status
                   FROM session_model_usage u JOIN sessions s ON s.id = u.session_id
                   WHERE s.started_at >= ? AND s.started_at < ?""",
                (start.timestamp(), end.timestamp()),
            ):
                per_model.setdefault(r[0], []).append(r[1:])

        models, channels, days = {}, {}, {}

        def day_of(ts):
            return datetime.fromtimestamp(ts, tz).strftime("%Y-%m-%d")

        for sid, source, model, started_at, tool_calls, inp, out, cread, cwrite, provider, est, actual, calls, base_url, status in rows:
            result["sessions"] += 1
            result["messages"]["toolCalls"] += int(tool_calls or 0)
            parts = per_model.get(sid)
            if not parts:
                parts = [(model, provider, calls, inp, out, cread, cwrite, est, actual, base_url, status)]
            day = days.setdefault(day_of(started_at), {"tokens": 0, "cost": 0.0, "messages": 0, "errors": 0})
            channel = source if source in CHANNEL_SOURCES else None
            for p_model, p_provider, p_calls, p_in, p_out, p_cread, p_cwrite, p_est, p_actual, p_base_url, p_status in parts:
                cost = _cost(p_est, p_actual, p_status)
                tokens = sum(int(v or 0) for v in (p_in, p_out, p_cread, p_cwrite))
                _add(result["totals"], p_in, p_out, p_cread, p_cwrite, cost)
                key = (p_provider or "", p_model or "unknown", p_base_url or "")
                entry = models.setdefault(
                    key, {"provider": key[0], "model": key[1], "baseUrl": key[2], "calls": 0, "totals": _zero()}
                )
                entry["calls"] += int(p_calls or 0)
                _add(entry["totals"], p_in, p_out, p_cread, p_cwrite, cost)
                day["tokens"] += tokens
                day["cost"] += float(cost or 0)
                if channel:
                    c = channels.setdefault(channel, {"channel": channel, "tokens": 0, "cost": 0.0})
                    c["tokens"] += tokens
                    c["cost"] += float(cost or 0)

        if "messages" in tables:
            for role, started_at, count in db.execute(
                """SELECT m.role, s.started_at, COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id
                   WHERE s.started_at >= ? AND s.started_at < ? AND m.role IN ('user', 'assistant')
                   GROUP BY m.role, m.session_id""",
                (start.timestamp(), end.timestamp()),
            ):
                result["messages"][role] += count
                days.setdefault(day_of(started_at), {"tokens": 0, "cost": 0.0, "messages": 0, "errors": 0})["messages"] += count

        result["byModel"] = list(models.values())
        result["byChannel"] = list(channels.values())
        result["daily"] = [{"date": d, **v} for d, v in sorted(days.items())]
        return result
    finally:
        db.close()


# ------------------------------------------------------------------------- pairing

def pairing_list(platform):
    sys.path.insert(0, HERMES_ROOT)
    with contextlib.redirect_stdout(io.StringIO()):
        from gateway.pairing import PairingStore

        pending = PairingStore().list_pending(platform)
    return {
        "pending": [
            {
                "request_id": str(p.get("request_id") or ""),
                "user_id": str(p.get("user_id") or ""),
                "user_name": str(p.get("user_name") or ""),
                "age_minutes": int(p.get("age_minutes") or 0),
            }
            for p in pending
        ]
    }


# -------------------------------------------------------------------------- google

def _google_setup():
    """The bundled skill's setup module, plus a runner that captures what it prints."""
    sys.path.insert(0, HERMES_ROOT)
    sys.path.insert(0, GOOGLE_SCRIPTS)
    import importlib.util

    spec = importlib.util.spec_from_file_location("clawhuddle_google_setup", f"{GOOGLE_SCRIPTS}/setup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def run(fn, *args):
        out = io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out):
            try:
                fn(*args)
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue().strip()

    return module, run


def _first_error(text):
    for line in text.splitlines():
        if line.startswith("ERROR:"):
            return line[len("ERROR:"):].strip()
    return text.splitlines()[0] if text else "Google sign-in failed"


def _connected_email(module):
    """The address of the account the stored token belongs to, or ''."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials.from_authorized_user_file(str(module.TOKEN_PATH), module.SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
        profile = build("gmail", "v1", credentials=creds, cache_discovery=False).users().getProfile(userId="me").execute()
        return str(profile.get("emailAddress") or "")
    except Exception:
        return ""


def google_start():
    module, run = _google_setup()
    code, out = run(module.get_auth_url)
    url = next((l.strip() for l in out.splitlines() if l.strip().startswith("https://")), "")
    if code != 0 or not url:
        fail(_first_error(out))
    return {"auth_url": url}


def google_finish(path, fallback_email=""):
    module, run = _google_setup()
    redirect = Path(path).read_text(encoding="utf-8").strip()
    code, out = run(module.exchange_auth_code, redirect)
    if code != 0 or not module.TOKEN_PATH.exists():
        fail(_first_error(out))
    email = _connected_email(module) or fallback_email
    fd = os.open(str(GOOGLE_LABEL), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"email": email}, handle)
    return {"email": email}


def google_revoke():
    module, run = _google_setup()
    run(module.revoke)
    GOOGLE_LABEL.unlink(missing_ok=True)
    return {"revoked": not module.TOKEN_PATH.exists()}


def main(argv):
    if len(argv) < 2:
        fail("no command")
    command, args = argv[1], argv[2:]
    try:
        if command == "usage" and len(args) == 3:
            emit(usage(*args))
        elif command == "pairing-list" and len(args) == 1:
            emit(pairing_list(args[0]))
        elif command == "google-start" and not args:
            emit(google_start())
        elif command == "google-finish" and len(args) in (1, 2):
            emit(google_finish(*args))
        elif command == "google-revoke" and not args:
            emit(google_revoke())
        else:
            fail(f"unknown command: {command}")
    except SystemExit:
        raise
    except Exception as exc:  # one JSON line either way; the API shows the message
        fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main(sys.argv)

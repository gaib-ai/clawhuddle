#!/bin/sh
# OpenClaw 2026.2.19+ blocks ws:// to non-loopback addresses.
# Gateway binds to loopback (127.0.0.1:6100) to pass the security check.
# socat bridges external Docker network traffic (0.0.0.0:6101) to loopback.
socat TCP-LISTEN:6101,fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:6100 &

# Auto-fix legacy config keys (e.g. tools.web.search → plugins.entries.*.config.webSearch)
openclaw doctor --fix 2>/dev/null || true

# Pre-install enabled channel plugins that don't ship inside OpenClaw (discord,
# slack) and accept their declared capabilities.
#
# Since 2026.8.x the gateway auto-installs any enabled-but-missing plugin on
# startup, but that path cannot grant capability consent, so it stops with
# 'Plugin "discord" requires capability consent' and refuses to report ready.
# The only sanctioned way to consent is `openclaw plugins install/enable
# --accept-capabilities`, and consent lives in the mounted per-user state
# (~/.openclaw/state/openclaw.sqlite) — so it cannot be baked into the image and
# has to be done once per gateway. This is a no-op once the plugin is installed.
#
# Candidates come from `config validate`, which names every configured plugin
# that is not installed; we only act on entries the platform actually enabled
# (msteams/imessage are configured but force-disabled, and must stay untouched).
OPENCLAW_VERSION=$(openclaw --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -n1)
ENABLED_PLUGINS=$(node -e '
  try {
    const cfg = JSON.parse(require("fs").readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"));
    for (const [id, entry] of Object.entries(cfg.plugins?.entries ?? {})) {
      if (entry && entry.enabled === true) console.log(id);
    }
  } catch {}
' 2>/dev/null)
MISSING_PLUGINS=$(openclaw config validate 2>&1 | grep -oE 'plugin not installed: [a-z0-9-]+' | awk '{print $4}' | sort -u)
for plugin in $MISSING_PLUGINS; do
  echo "$ENABLED_PLUGINS" | grep -qx "$plugin" || continue
  spec="@openclaw/${plugin}"
  [ -n "$OPENCLAW_VERSION" ] && spec="${spec}@${OPENCLAW_VERSION}"
  echo "[entrypoint] installing missing plugin ${spec} (accepting capabilities)"
  timeout 300 openclaw plugins install "$spec" --accept-capabilities \
    || echo "[entrypoint] WARN: failed to install ${spec}; gateway startup may fail"
done

# Bring official npm plugins level with the core after an OpenClaw upgrade.
# An @openclaw/* plugin built for an older core may fail to load on a newer one
# ("cannot import openclaw/plugin-sdk/...; built with OpenClaw X; running core Y")
# and the gateway then starts without that channel. Reinstalling pinned to the
# core version is deterministic (`plugins update` would pull whatever is latest,
# which can be newer than the core). Only enabled, trusted official installs
# whose version differs from the core are touched; on a normal boot this is a
# no-op.
if [ -n "$OPENCLAW_VERSION" ]; then
  STALE_PLUGINS=$(openclaw plugins list --json 2>/dev/null | node -e '
    let d = "";
    process.stdin.on("data", c => d += c).on("end", () => {
      try {
        const core = process.argv[1];
        for (const p of JSON.parse(d).plugins ?? []) {
          if (!p.enabled || p.origin === "bundled" || !p.trustedOfficialInstall) continue;
          if (typeof p.version === "string" && p.version !== core) console.log(p.id);
        }
      } catch {}
    });
  ' "$OPENCLAW_VERSION" 2>/dev/null)
  for plugin in $STALE_PLUGINS; do
    spec="@openclaw/${plugin}@${OPENCLAW_VERSION}"
    echo "[entrypoint] updating plugin ${plugin} to core version (${spec})"
    timeout 300 openclaw plugins install "$spec" --accept-capabilities --force \
      || echo "[entrypoint] WARN: failed to update ${spec}; that channel may not load"
  done
fi

# Per-member environment. Anything in the mounted state dir's `env` file is
# exported into the gateway process (and so into every command the agent
# runs). Lets tools that need runtime env (e.g. gog's keyring password) be
# configured per gateway without platform env support, and survive redeploys.
# Format: KEY=value lines, no quotes needed; keep it chmod 600.
if [ -f /root/.openclaw/env ]; then
  set -a
  . /root/.openclaw/env
  set +a
  echo "[entrypoint] loaded per-member env from /root/.openclaw/env"
fi

# Start gateway in background so we can run the auto-approve loop.
openclaw gateway &
GATEWAY_PID=$!

# Wait for gateway to be ready (up to 60s).
for i in $(seq 1 60); do
  if curl -sf -o /dev/null http://127.0.0.1:6100/ 2>/dev/null; then
    break
  fi
  sleep 1
done

# Auto-approve all pending device pairings every 5 seconds.
# This removes the need for manual approval when users open
# the Control UI from a new browser or device.
# `approve --latest` only previews — we must list pending requests and
# approve each by id. Can be removed once OpenClaw releases
# skipDevicePairingForTrustedProxy.
while true; do
  ids=$(openclaw devices list --json 2>/dev/null | node -e '
    let d="";
    process.stdin.on("data", c => d += c).on("end", () => {
      try { JSON.parse(d).pending.forEach(p => console.log(p.requestId)); } catch {}
    });
  ' 2>/dev/null)
  for id in $ids; do
    openclaw devices approve "$id" >/dev/null 2>&1 || true
  done
  sleep 5
done &

wait $GATEWAY_PID

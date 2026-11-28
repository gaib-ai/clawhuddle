#!/bin/sh
# clawhuddle-recover-lock: clears the state lock a killed gateway left behind.
#
# Since OpenClaw 2026.11.5 a gateway (and every CLI command that needs the
# state) refuses for good when the lock's recorded owner lives in a PID
# namespace it cannot look into ("cannot verify Gateway ownership from this
# process … an unverifiable owner will not be reclaimed automatically"); before,
# such a lock simply expired 90 s after its last heartbeat. Every container
# start is a new PID namespace, so a gateway that was killed rather than shut
# down (docker's SIGKILL after the stop grace period, an OOM kill, a crash)
# would keep its replacement from ever starting.
#
# OpenClaw's answer is `openclaw gateway recover-lock`: inspect, then confirm
# the exact records inspected, once the operator knows the owner has stopped.
# Call this only where that is known: at container boot before anything else
# has started (one container per state dir), or from the platform's throwaway
# container while the instance's own container is down. OpenClaw still refuses
# an owner it can see alive, and a record that changed since the inspection.
#
# Silent when there is nothing to recover or the command does not exist (an
# image older than 2026.11.5). Exit 1 only when a lock is there and stays.
fingerprint=$(openclaw gateway recover-lock --json 2>/dev/null | node -e '
  let d = "";
  process.stdin.on("data", c => d += c).on("end", () => {
    try {
      const j = JSON.parse(d);
      if (j.present === true && /^[0-9a-f]{64}$/.test(j.confirmation)) console.log(j.confirmation);
    } catch {}
  });
' 2>/dev/null)
[ -n "$fingerprint" ] || exit 0
if openclaw gateway recover-lock --confirm "$fingerprint" >/dev/null 2>&1; then
  echo "[clawhuddle] recovered the state lock left by a gateway that was killed"
  exit 0
fi
echo "[clawhuddle] WARN: a stopped gateway's state lock could not be recovered; run 'openclaw gateway recover-lock' in this container"
exit 1

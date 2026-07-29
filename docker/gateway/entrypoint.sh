#!/bin/sh
# OpenClaw 2026.2.19+ blocks ws:// to non-loopback addresses.
# Gateway binds to loopback (127.0.0.1:6100) to pass the security check.
# socat bridges external Docker network traffic (0.0.0.0:6101) to loopback.
socat TCP-LISTEN:6101,fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:6100 &

# Auto-fix legacy config keys (e.g. tools.web.search → plugins.entries.*.config.webSearch)
openclaw doctor --fix 2>/dev/null || true

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

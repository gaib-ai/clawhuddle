#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Prints how many device pairing requests are waiting, reading OpenClaw's state
// database directly. `openclaw devices list` costs ~4.5 CPU-seconds a run, which
// is about half a core per idle gateway when polled; this costs ~0.1 s, so the
// polling callers ask here first and only run the CLI when there is something to
// act on.
//
// This reads an OpenClaw internal, so it must fail loudly rather than guess: any
// error (schema changed, database missing) exits non-zero with no output, and
// callers treat that as "unknown" and fall back to the CLI. Printing 0 by mistake
// would silently stop approvals.
const { DatabaseSync } = require('node:sqlite');

// Mirrors DEVICE_PAIRING_PENDING_TTL_MS. Expired rows stay in the table until the
// next pairing write, and the CLI hides them, so counting one would keep every
// caller on the expensive path for nothing. If OpenClaw lengthens this, requests
// past 5 minutes go unseen here; the loop approves within seconds, so that is moot.
const PENDING_TTL_MS = 300000;

const db = new DatabaseSync(`${process.env.HOME}/.openclaw/state/openclaw.sqlite`, {
  readOnly: true,
  timeout: 1000,
});
const { pending } = db
  .prepare('SELECT count(*) AS pending FROM device_pairing_pending WHERE coalesce(refreshed_at_ms, ts) >= ?')
  .get(Date.now() - PENDING_TTL_MS);
console.log(pending);

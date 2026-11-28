import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DASHBOARD_OPEN_PATH } from '@clawhuddle/shared';

/**
 * One-click sign-in for a Hermes dashboard, which has a sign-in page and no
 * token link. Traefik sends `<instance host>/_clawhuddle/open` here (a router
 * on each Hermes container, see `createTraefikLabels`), so the page runs on
 * the instance's own origin and can make the same sign-in call the dashboard's
 * own form makes. The web app opens it as `…/open#u=<username>&p=<password>`.
 *
 * The page is static and holds no secret. The credentials are in the URL
 * fragment, which the browser never sends to a server (so they are in no
 * access log, here or at Cloudflare), and the page drops the fragment from the
 * address bar and the history entry before doing anything else.
 */
const STYLE = `
  html { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 14px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { padding: 24px; text-align: center; max-width: 28rem; }
  a { color: LinkText; }
`;

const SCRIPT = `
(function () {
  var params = new URLSearchParams(window.location.hash.slice(1));
  try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
  var username = params.get('u');
  var password = params.get('p');
  var msg = document.getElementById('msg');
  var manual = document.getElementById('manual');
  function fail(text) { msg.textContent = text; manual.hidden = false; }
  if (!username || !password) { window.location.replace('/'); return; }
  fetch('/auth/password-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ provider: 'basic', username: username, password: password, next: '/' })
  }).then(function (resp) {
    if (resp.ok) { window.location.replace('/'); return; }
    fail(resp.status === 429
      ? 'Too many sign-in attempts. Wait a minute, then open the instance again.'
      : 'Could not sign in automatically.');
  }).catch(function () {
    fail('Could not reach the instance. It may still be starting.');
  });
})();
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Signing in…</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <p id="msg">Signing in…</p>
  <p id="manual" hidden><a href="/">Sign in by hand</a> with the username and password shown in ClawHuddle.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

const hash = (text: string) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;

/** The page and the headers it is served with. Only the two inline blocks above may run or apply. */
export function dashboardOpenPage(): { html: string; headers: Record<string, string> } {
  return {
    html: HTML,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': [
        "default-src 'none'",
        `script-src ${hash(SCRIPT)}`,
        `style-src ${hash(STYLE)}`,
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  };
}

export async function dashboardOpenRoutes(app: FastifyInstance) {
  // Public on purpose: there is nothing to protect on the page itself.
  app.get(DASHBOARD_OPEN_PATH, { logLevel: 'warn' }, async (_request, reply) => {
    const page = dashboardOpenPage();
    return reply.headers(page.headers).send(page.html);
  });
}

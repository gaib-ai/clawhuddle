import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { DASHBOARD_OPEN_PATH } from '@clawhuddle/shared';
import { dashboardOpenPage, dashboardOpenRoutes } from './dashboard-open.js';

const sha = (text: string) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;

describe('dashboard open page', () => {
  it('is served without a token, uncached and unframeable', async () => {
    const app = Fastify();
    await app.register(dashboardOpenRoutes);
    const res = await app.inject({ method: 'GET', url: DASHBOARD_OPEN_PATH, headers: { host: 'claw-abc12345.example.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.body).toBe(dashboardOpenPage().html);
  });

  it('allows exactly its own script and style', () => {
    const { html, headers } = dashboardOpenPage();
    const csp = headers['content-security-policy'];
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    expect(csp).toContain(`script-src ${sha(script)};`);
    expect(csp).toContain(`style-src ${sha(style)};`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('unsafe');
  });

  it('signs in on its own origin and drops the credentials from the address first', () => {
    const { html } = dashboardOpenPage();
    expect(html).toContain("fetch('/auth/password-login'");
    expect(html.indexOf('replaceState')).toBeGreaterThan(0);
    expect(html.indexOf('replaceState')).toBeLessThan(html.indexOf("fetch('/auth/password-login'"));
    // Nothing leaves the instance's origin and nothing is loaded from elsewhere.
    expect(html).not.toMatch(/https?:\/\//);
  });
});

import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Root cause of "signed in, then reload logs me out" in LOCAL development (2026-10-15 report): `localhost` and
 * `127.0.0.1` are different sites, so a console page on one calling the API on the other never stores the development
 * session cookie. The probe server below issues `crewflow_session` with the server's exact development attributes
 * (rab-server web-session-cookie.constants.ts: HttpOnly; SameSite=Lax; Path=/rest/v1; host-only; not Secure) and real
 * Chromium decides what happens. No Crewflow data is involved.
 *
 * The last test needs the isolated Vite instance from playwright.isolated.config.ts (API host 127.0.0.1).
 */
let api: http.Server;
let pages: http.Server;
let apiPort = 0;
let pagePort = 0;

test.beforeAll(async () => {
  api = http.createServer((req, res) => {
    const origin = req.headers.origin ?? '';
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.url === '/rest/v1/auth/login' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'crewflow_session=crewflow_sess_probe; Max-Age=3600; Path=/rest/v1; HttpOnly; SameSite=Lax');
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }
    if (req.url === '/rest/v1/auth/me') {
      const signedIn = /(?:^|;\s*)crewflow_session=crewflow_sess_probe/.test(req.headers.cookie ?? '');
      return res.writeHead(signedIn ? 200 : 401, { 'content-type': 'application/json' }).end(signedIn ? '{"id":"probe"}' : '{"message":"Missing credentials"}');
    }
    res.writeHead(404).end();
  });
  pages = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>probe</title>'));
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => pages.listen(0, '127.0.0.1', r));
  apiPort = (api.address() as AddressInfo).port;
  pagePort = (pages.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise((r) => api.close(r));
  await new Promise((r) => pages.close(r));
});

async function signInThenReload(page: import('@playwright/test').Page, pageHost: string) {
  const apiBase = `http://127.0.0.1:${apiPort}/rest/v1`;
  await page.goto(`http://${pageHost}:${pagePort}/`);
  await page.evaluate((base) => fetch(`${base}/auth/login`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }), apiBase);
  await page.reload();
  return page.evaluate((base) => fetch(`${base}/auth/me`, { credentials: 'include' }).then((r) => r.status), apiBase);
}

test('console on 127.0.0.1 + API on 127.0.0.1: the session cookie survives a reload', async ({ page }) => {
  expect(await signInThenReload(page, '127.0.0.1')).toBe(200);
});

test('console on localhost + API on 127.0.0.1: the SameSite=Lax cookie is never stored, so the reload is signed out', async ({ page, context }) => {
  expect(await signInThenReload(page, 'localhost')).toBe(401);
  expect((await context.cookies(`http://127.0.0.1:${apiPort}/rest/v1`)).find((c) => c.name === 'crewflow_session')).toBeUndefined();
});

test('the dev console opened on localhost moves itself onto the API host before booting (fix)', async ({ page }) => {
  await page.goto('http://localhost:5174/login?from=activation');
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:5174\/login\?from=activation$/);
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');
});

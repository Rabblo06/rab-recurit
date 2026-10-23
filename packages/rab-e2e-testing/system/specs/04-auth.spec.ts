import { expect, test, type Page } from '@playwright/test';

import { managerFor, staffMobile } from '../lib/actors';
import { sql } from '../lib/db';
import { DEFAULT_HOST, DEFAULT_ORIGIN, RUN_ID, SYNTHETIC_PASSWORD, workspaceHost, workspaceOrigin } from '../lib/env';
import { ApiClient, expectStatus } from '../lib/http';
import { recreate } from '../lib/stack';
import { loadState, updateState } from '../lib/state';
import { secretFromOtpauth, totp, waitNextStep } from '../lib/totp';
import { settle, shot, uiLogin } from '../lib/ui';

/**
 * Scenario 4 — authentication across hosts: login handoff default host → *.localhost workspace host, logout isolation
 * between browser contexts, MFA enrol → logout → challenge → recovery code, the (email, IP) attempt limiter, and turning
 * password sign-in off for one organisation.
 */
const tag = RUN_ID.toLowerCase();
const results: Record<string, unknown> = {};

function cookieClient(host: string, origin: string, cookies: { name: string; value: string; domain: string }[], domainPart: string): ApiClient {
  const c = new ApiClient({ host, origin });
  for (const k of cookies.filter((x) => x.domain.includes(domainPart))) c.cookies.set(k.name, k.value);
  return c;
}

/** Same-origin fetch from inside the page (the browser resolves *.localhost; Node's resolver does not). */
async function pageFetch(page: Page, method: string, path: string): Promise<number> {
  return page.evaluate(async ([m, p]) => (await fetch(p, { method: m, credentials: 'include', headers: m === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' })).status, [method, path] as const);
}

async function passwordStep(page: Page, origin: string, email: string): Promise<number> {
  await page.goto(`${origin}/login`);
  await page.locator('button.auth-email-start').click();
  await page.locator('#email').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#password').fill(SYNTHETIC_PASSWORD);
  for (let i = 0; i < 4; i++) {
    const resP = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/auth/login', { timeout: 120_000 });
    await page.getByRole('button', { name: /^(Sign in|Try again)$/ }).click();
    const res = await resP;
    if (res.status() !== 429) return res.status();
    await page.waitForTimeout(Number((await res.allHeaders())['retry-after'] ?? 60) * 1000 + 1000);
    await page.getByRole('button', { name: /^(Sign in|Try again)$/ }).waitFor({ timeout: 120_000 });
  }
  return 429;
}

test.describe.serial('S4 authentication', () => {
  test.afterAll(() => {
    updateState((s) => {
      s.notes.auth = { ...(s.notes.auth as object), ...results };
    });
  });

  test('4.1 login handoff: sign in on the default host → session moves to the workspace host (*.localhost)', async ({ browser }) => {
    const s = loadState();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const urls: string[] = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) urls.push(f.url().replace(/#.*$/, '#<fragment>')); });
    // Slow the exchange by 1.5 s (behaviour unchanged) so the landing page can be photographed.
    let landingShot = false;
    await page.route('**/rest/v1/auth/login-handoff/exchange', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    page.on('framenavigated', async (f) => {
      if (!landingShot && f === page.mainFrame() && f.url().includes('/auth/handoff')) {
        landingShot = true;
        await page.waitForTimeout(400);
        await shot(page, '04-handoff-landing').catch(() => undefined);
      }
    });
    const handoffCreate = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/auth/login-handoff' && r.request().method() === 'POST', { timeout: 120_000 });
    const exchange = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/auth/login-handoff/exchange', { timeout: 120_000 });
    await uiLogin(page, DEFAULT_ORIGIN, s.A.imEmail!, SYNTHETIC_PASSWORD);
    const created = await handoffCreate;
    const exchanged = await exchange;
    await settle(page);
    const landed = new URL(page.url());
    await shot(page, '04-handoff-landed-workspace-a');
    const cookies = await ctx.cookies();
    const wsCookies = cookies.filter((c) => c.domain.includes(s.A.label!));
    const defaultCookies = cookies.filter((c) => c.domain === '127.0.0.1');
    // The default-host session ended; the workspace-host session works; cookies are host-only.
    const onDefault = cookieClient(DEFAULT_HOST, DEFAULT_ORIGIN, cookies, '127.0.0.1');
    const onWs = cookieClient(workspaceHost(s.A.label!), workspaceOrigin(s.A.label!), cookies, s.A.label!);
    const meDefault = await onDefault.get('/rest/v1/auth/me');
    const meWs = await onWs.get('/rest/v1/auth/me');
    results.handoff = {
      createStatus: created.status(), exchangeStatus: exchanged.status(), landedHost: landed.host, urls,
      wsCookies: wsCookies.map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, sameSite: c.sameSite })),
      defaultCookies: defaultCookies.map((c) => c.name), meDefault: meDefault.status, meWs: meWs.status, landingShot,
    };
    expect(created.status()).toBe(200);
    expect(exchanged.status()).toBe(200);
    expect(landed.host).toBe(workspaceHost(s.A.label!));
    expect(urls.some((u) => u.includes('/auth/handoff'))).toBe(true);
    expect(meWs.status).toBe(200);
    expect(meDefault.status).toBe(401);
    expect(wsCookies.every((c) => !c.domain.startsWith('.') && c.httpOnly)).toBe(true);
    await ctx.close();
  });

  test('4.2 logout in one browser context does not sign out another', async ({ browser }) => {
    const s = loadState();
    const origin = workspaceOrigin(s.A.label!);
    const c1 = await browser.newContext();
    const c2 = await browser.newContext();
    const p1 = await c1.newPage();
    const p2 = await c2.newPage();
    await uiLogin(p1, origin, s.A.imEmail!, SYNTHETIC_PASSWORD);
    await uiLogin(p2, origin, s.A.imEmail!, SYNTHETIC_PASSWORD);
    expect(await pageFetch(p1, 'GET', '/rest/v1/auth/me')).toBe(200);
    expect(await pageFetch(p2, 'GET', '/rest/v1/auth/me')).toBe(200);
    const logout = await pageFetch(p1, 'POST', '/rest/v1/auth/logout');
    const after1 = await pageFetch(p1, 'GET', '/rest/v1/auth/me');
    await p2.reload();
    await settle(p2);
    const after2 = await pageFetch(p2, 'GET', '/rest/v1/auth/me');
    await shot(p2, '04-other-context-still-signed-in');
    results.logoutIsolation = { logout, context1After: after1, context2After: after2, context2Url: p2.url() };
    expect(logout).toBe(204);
    expect(after1).toBe(401);
    expect(after2).toBe(200);
    await c1.close();
    await c2.close();
  });

  test('4.3 MFA: enrol (password + TOTP) → logout → challenge in the UI → handoff; recovery code works once', async ({ browser }) => {
    const s = loadState();
    const ceoLabel = `alpha-hq-${tag}`;
    const ceo = new ApiClient({ host: workspaceHost(ceoLabel), origin: workspaceOrigin(ceoLabel), label: 'ceoA' });
    expectStatus(await ceo.login(s.A.ceoEmail!, SYNTHETIC_PASSWORD), 200, 'CEO A login');
    const before = expectStatus(await ceo.get('/rest/v1/auth/mfa'), 200, 'mfa status').body;
    const wrongPw = await ceo.post('/rest/v1/auth/mfa/enrolment', { currentPassword: 'definitely-wrong-password' });
    const start = expectStatus(await ceo.post('/rest/v1/auth/mfa/enrolment', { currentPassword: SYNTHETIC_PASSWORD }), 200, 'enrolment start').body;
    const uri = start.otpauthUri ?? start.otpauthUrl ?? start.uri;
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    const secret = secretFromOtpauth(uri);
    const wrongCode = await ceo.post('/rest/v1/auth/mfa/enrolment/confirm', { code: totp(secret) === '000000' ? '111111' : '000000' });
    const confirmCode = totp(secret);
    const confirmed = expectStatus(await ceo.post('/rest/v1/auth/mfa/enrolment/confirm', { code: confirmCode }), 200, 'enrolment confirm').body;
    const recovery: string[] = confirmed.recoveryCodes;
    expect(recovery.length).toBeGreaterThanOrEqual(8);
    const replayConfirm = await ceo.post('/rest/v1/auth/mfa/enrolment/confirm', { code: confirmCode });
    await ceo.post('/rest/v1/auth/logout', {});
    const meAfterLogout = await ceo.get('/rest/v1/auth/me');

    // UI: password → challenge screen → current code → handoff to the CEO's workspace host.
    await waitNextStep();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pw = await passwordStep(page, DEFAULT_ORIGIN, s.A.ceoEmail!);
    await page.locator('#mfa-code').waitFor({ state: 'visible', timeout: 30_000 });
    await shot(page, '04-mfa-challenge');
    const verifyP = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/auth/mfa/challenge/verify', { timeout: 60_000 });
    await page.locator('#mfa-code').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    const verify = await verifyP;
    await page.waitForURL((u) => u.host === workspaceHost(ceoLabel), { timeout: 60_000 });
    await settle(page);
    await shot(page, '04-mfa-after-challenge-workspace-host');
    await ctx.close();

    // API: a new sign-in needs the second factor; a recovery code works exactly once.
    const api2 = new ApiClient({ host: DEFAULT_HOST, origin: DEFAULT_ORIGIN, label: 'ceoA-2' });
    const needs = await api2.login(s.A.ceoEmail!, SYNTHETIC_PASSWORD);
    expect(needs.status).toBe(409);
    expect(needs.body.code).toBe('SECOND_FACTOR_REQUIRED');
    expect(api2.cookies.size).toBe(0);
    const challengeToken = needs.body.challengeToken;
    const viaRecovery = await api2.post('/rest/v1/auth/mfa/challenge/verify', { challengeToken, code: recovery[0] });
    const challengeReuse = await api2.post('/rest/v1/auth/mfa/challenge/verify', { challengeToken, code: recovery[1] });
    const api3 = new ApiClient({ host: DEFAULT_HOST, origin: DEFAULT_ORIGIN, label: 'ceoA-3' });
    const needs3 = await api3.login(s.A.ceoEmail!, SYNTHETIC_PASSWORD);
    const recoveryReuse = await api3.post('/rest/v1/auth/mfa/challenge/verify', { challengeToken: needs3.body.challengeToken, code: recovery[0] });
    const status = expectStatus(await api2.get('/rest/v1/auth/mfa'), 200, 'mfa status after').body;
    results.mfa = {
      before, wrongPassword: wrongPw.status, wrongCode: wrongCode.status, recoveryCodes: recovery.length, replayConfirm: replayConfirm.status,
      meAfterLogout: meAfterLogout.status, uiPasswordStep: pw, uiVerify: verify.status(), apiSecondFactor: needs.status,
      viaRecovery: viaRecovery.status, challengeReuse: challengeReuse.status, recoveryReuse: recoveryReuse.status, statusAfter: status,
    };
    expect(wrongPw.status).toBe(403);
    expect(wrongCode.status).toBe(401);
    expect(pw).toBe(409);
    expect(verify.status()).toBe(200);
    expect(viaRecovery.status).toBe(200);
    expect(challengeReuse.status).toBe(401);
    expect(recoveryReuse.status).toBe(401);
    updateState((st) => { st.notes.mfaUser = s.A.ceoEmail; });
  });

  test('4.4 limiter: repeated bad passwords for a synthetic email are slowed; a real account from the same IP still signs in', async () => {
    const email = `nobody.${tag}.${Date.now().toString(36)}@limiter-e2e.test`;
    const c = new ApiClient({ label: 'limiter', honour429: false });
    const seq: { status: number; retryAfter?: string; code?: string; kind: string; t: number }[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) {
      const r = await c.post('/rest/v1/auth/login', { email, password: `wrong-${i}-password` });
      const kind = r.status === 429 ? (typeof r.body === 'object' && r.body?.retryAfter !== undefined ? 'limiter' : 'ip-throttle') : 'answer';
      seq.push({ status: r.status, retryAfter: r.headers['retry-after'] as string | undefined, code: r.body?.code, kind, t: Math.round((Date.now() - t0) / 1000) });
      if (kind === 'limiter') break;
      if (kind === 'ip-throttle') {
        await new Promise((res) => setTimeout(res, (Number(r.headers['retry-after'] ?? 60) + 1) * 1000));
        i--;
        continue;
      }
      await new Promise((res) => setTimeout(res, 13_000)); // stay under the per-IP 5/min route throttle
    }
    const s = loadState();
    const real = new ApiClient({ host: workspaceHost(s.A.label!), origin: workspaceOrigin(s.A.label!) });
    const ok = await real.login(s.A.imEmail!, SYNTHETIC_PASSWORD);
    results.limiter = { seq, realAccountAfter: ok.status };
    const answers = seq.filter((x) => x.kind === 'answer');
    expect(answers.every((x) => x.status === 401)).toBe(true);
    expect(seq.some((x) => x.kind === 'limiter')).toBe(true);
    expect(ok.status).toBe(200);
  });

  test('4.5 password sign-in off for organisation B: refused while it would lock everyone out; with SSO available it revokes B password sessions only', async () => {
    const s = loadState();
    let mB = await managerFor('B');
    const mA = await managerFor('A');
    const staffB = await staffMobile(s.B.staffEmail!);
    // Organisation sign-in methods are the CEO's setting (settings.edit); the Initial Manager is refused.
    const ceoB = new ApiClient({ label: 'ceoB' });
    expectStatus(await ceoB.login(s.B.ceoEmail!, SYNTHETIC_PASSWORD), 200, 'CEO B login');
    const imRefused = await mB.patch('/rest/v1/workspace/security', { passwordAuthEnabled: false });
    const ceoRefused = await ceoB.patch('/rest/v1/workspace/security', { passwordAuthEnabled: false });
    // FINDING W6-E2E-04: no system role (CEO, Manager, Venue Manager, Staff) holds settings.view/settings.edit and they are
    // not member-assignable, so no account made through the product can reach Settings → Security. To exercise the
    // revocation itself, the CEO gets a user_permission_override grant (superuser fixture on the disposable DB).
    expect(imRefused.status).toBe(403);
    expect(ceoRefused.status).toBe(403);
    const ceoId = (await sql(`select id from core."user" where email = $1`, [s.B.ceoEmail]))[0].id;
    await sql(`insert into core.user_permission_override (user_id, permission_id, organisation_id, effect)
      select $1, p.id, $2, 'grant' from core.permission p where p.key in ('settings.view', 'settings.edit') on conflict do nothing`, [ceoId, s.B.orgId]);
    let lockout = await ceoB.patch('/rest/v1/workspace/security', { passwordAuthEnabled: false });
    for (let i = 0; i < 20 && lockout.status === 403; i++) {
      await new Promise((r) => setTimeout(r, 3000)); // permission cache TTL
      lockout = await ceoB.patch('/rest/v1/workspace/security', { passwordAuthEnabled: false });
    }
    expect(lockout.status).toBe(400);

    // Make an SSO provider available system-wide (placeholder Google config) — this restarts the API and the worker.
    const restartMs = await recreate(['server', 'worker'], { E2E_GOOGLE_ENABLED: 'true' });
    // Sessions survive an API restart (they live in Postgres/Redis, not in process memory).
    const survives = await mB.get('/rest/v1/auth/me');
    const providers = expectStatus(await ceoB.get('/rest/v1/workspace/security'), 200, 'security get').body;
    const off = await ceoB.patch('/rest/v1/workspace/security', { passwordAuthEnabled: false, googleAuthEnabled: true });
    const bWeb = await mB.get('/rest/v1/auth/me');
    const ceoAfter = await ceoB.get('/rest/v1/auth/me');
    const bStaff = await staffB.get('/rest/v1/offers/mine');
    const aWeb = await mA.get('/rest/v1/auth/me');
    const bLogin = await new ApiClient({ host: workspaceHost(s.B.label!), origin: workspaceOrigin(s.B.label!) }).login(s.B.imEmail!, SYNTHETIC_PASSWORD);
    const aLogin = await new ApiClient({ host: workspaceHost(s.A.label!), origin: workspaceOrigin(s.A.label!) }).login(s.A.imEmail!, SYNTHETIC_PASSWORD);
    const audit = await sql(`select metadata from core.audit_log where organisation_id = $1 and action like '%auth_providers%' order by created_at desc limit 1`, [s.B.orgId]);
    results.passwordOff = {
      imRefused: imRefused.status, ceoRefused: ceoRefused.status, lockoutRefusal: [lockout.status, lockout.body?.message], restartMs, sessionSurvivesRestart: survives.status, providersBefore: providers,
      disable: off.status, offBody: off.body, bWebAfter: bWeb.status, ceoBAfter: ceoAfter.status, bStaffMobileAfter: bStaff.status, aWebAfter: aWeb.status, bPasswordLogin: bLogin.status, aPasswordLogin: aLogin.status,
      audit: audit[0]?.metadata,
    };
    expect(survives.status).toBe(200);
    expect(off.status).toBe(200);
    expect(bWeb.status).toBe(401);
    expect(aWeb.status).toBe(200);
    expect(bLogin.status).toBe(401);
    expect(aLogin.status).toBe(200);

    // Fixture restore: no real Google account exists on this stack, so nobody in B could switch password back on through
    // the product. Restored with one superuser UPDATE on the disposable DB (documented in the report), then verified.
    await sql(`update core.organisation set password_auth_enabled = true where id = $1`, [s.B.orgId]);
    await sql(`delete from core.user_permission_override where user_id = $1`, [ceoId]);
    mB = new ApiClient({ host: workspaceHost(s.B.label!), origin: workspaceOrigin(s.B.label!) });
    const back = await mB.login(s.B.imEmail!, SYNTHETIC_PASSWORD);
    (results.passwordOff as any).bLoginAfterRestore = back.status;
    expect(back.status).toBe(200);
  });
});

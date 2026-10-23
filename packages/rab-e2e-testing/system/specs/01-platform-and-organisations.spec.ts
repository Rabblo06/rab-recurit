import { expect, test } from '@playwright/test';

import { ApiClient, expectStatus, rows } from '../lib/http';
import { ADMIN_EMAIL, DEFAULT_ORIGIN, RUN_ID, SYNTHETIC_PASSWORD, workspaceHost, workspaceOrigin } from '../lib/env';
import { tokenFrom, waitForLink } from '../lib/mail';
import { sql } from '../lib/db';
import { loadState, updateState } from '../lib/state';
import { shot, uiLogin, uiOnboard } from '../lib/ui';

const WS_SQL = `select w.id, w.subdomain, r.schema_name, w.schema_status, w.status, r.module_version, r.status as reg_status, r.created_at as reg_created, r.ready_at
  from core.manager_workspace w join core."user" u on u.id = w.owner_user_id left join core.workspace_schema_registry r on r.workspace_id = w.id where u.email = $1`;

/**
 * Scenario 1 — a platform admin activates (link from the worker's email log), creates two organisations, each CEO invites
 * an Initial Manager, and each Initial Manager creates a workspace with a chosen subdomain that reaches READY through
 * server-path provisioning. A runs through the real web UI; B through the same API the UI calls.
 */
const tag = RUN_ID.toLowerCase();

test.describe.serial('S1 platform admin, two organisations, two workspaces', () => {
  test('1.1 platform admin activates from the worker email log (UI)', async ({ page }) => {
    const before = await sql(`select status, password_hash is not null as has_pw from core."user" where email = $1`, [ADMIN_EMAIL]);
    expect(before).toHaveLength(1);
    test.skip(before[0].has_pw, 'already activated by an earlier run of this stack');
    const { link } = await waitForLink(ADMIN_EMAIL, /activate-account\?token=/);
    expect(new URL(link).origin).toBe(DEFAULT_ORIGIN);
    await page.goto(link);
    await page.locator('#password').fill(SYNTHETIC_PASSWORD);
    await page.locator('#confirm').fill(SYNTHETIC_PASSWORD);
    await shot(page, '01-admin-activation-form');
    const activated = page.waitForResponse((r) => r.url().includes('/rest/v1/auth/activate-account'));
    await page.locator('button[type=submit]').click();
    expect((await activated).status()).toBe(200);
    await expect(page.getByText('Your account setup is complete')).toBeVisible();
    await shot(page, '01-admin-activation-done');
    // Activation stores the password; the account stays INVITED until its first sign-in (AuthService.login's
    // `ACTIVE || (INVITED && passwordHash)` gate).
    const u = await sql(`select status, password_hash is not null as has_pw from core."user" where email = $1`, [ADMIN_EMAIL]);
    expect(u[0]).toMatchObject({ status: 'invited', has_pw: true });
    updateState((s) => {
      s.runId = RUN_ID;
      s.adminEmail = ADMIN_EMAIL;
    });
  });

  test('1.2 admin onboards (CEO-shaped operational role) and creates organisation A in the admin panel (UI), B over the API', async ({ page }) => {
    await uiLogin(page, DEFAULT_ORIGIN, ADMIN_EMAIL, SYNTHETIC_PASSWORD);
    if (page.url().includes('/onboarding')) {
      const ob = await uiOnboard(page, { name: `Crewflow Platform ${tag}`, label: `platform-${tag}`, first: 'Wave', last: 'Admin', shotPrefix: '01-admin' });
      updateState((st) => { st.notes.adminOnboarding = ob; });
    }
    // With a workspace, sign-in on the default host hands the session off to the workspace host (login handoff ON).
    const adminOrigin = new URL(page.url()).origin;
    updateState((st) => { st.notes.adminLandedOrigin = adminOrigin; });
    await page.goto(`${adminOrigin}/settings/admin`);
    await page.getByRole('button', { name: 'Organisations' }).click();
    // BUG W6-E2E-01 probe: the admin panel's "+ New Organisation" drawer renders inside the block-level .settings-page
    // (not the flex .app-layout the dock is designed for), so the dock has height 0 and overflow:hidden — invisible and
    // unclickable. Recorded, then the same form is used through Settings → Members → Add (inline variant).
    await page.getByRole('button', { name: /new organisation/i }).first().click();
    await page.waitForTimeout(1200);
    const dock = await page.locator('.side-panel-dock').evaluate((d) => ({ h: Math.round(d.getBoundingClientRect().height), w: Math.round(d.getBoundingClientRect().width), parent: d.parentElement?.className ?? '' })).catch(() => null);
    const submitHit = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Create Organisation & Invite CEO'));
      if (!btn) return 'absent';
      const r = btn.getBoundingClientRect();
      return btn.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) ? 'clickable' : 'covered';
    });
    await shot(page, '01-bug-admin-new-organisation-drawer-invisible');
    updateState((st) => { st.notes.bugAdminDrawer = { dock, submitHit }; });
    test.info().annotations.push({ type: 'bug', description: `W6-E2E-01 admin New Organisation drawer: dock=${JSON.stringify(dock)} submit=${submitHit}` });
    await page.keyboard.press('Escape');

    await page.goto(`${adminOrigin}/settings/workspace/members?tab=invite&mode=add`);
    const orgA = `Alpha Staffing ${tag}`;
    const ceoA = `ceo.a.${tag}@alpha-e2e.test`;
    await page.locator('#org-name').fill(orgA);
    await page.locator('#org-ceo-email').fill(ceoA);
    await page.locator('#org-ceo-first').fill('Ada');
    await page.locator('#org-ceo-last').fill('Alpha');
    await shot(page, '01-admin-new-organisation');
    const createdOrg = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/admin/organisations' && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create Organisation & Invite CEO' }).click();
    expect([200, 201]).toContain((await createdOrg).status());
    await expect(page.getByText('Organisation created.')).toBeVisible();
    await shot(page, '01-admin-organisation-created');

    const admin = new ApiClient({ label: 'admin' });
    expectStatus(await admin.login(ADMIN_EMAIL, SYNTHETIC_PASSWORD), 200, 'admin login');
    const orgB = `Bravo Crew ${tag}`;
    const ceoB = `ceo.b.${tag}@bravo-e2e.test`;
    const created = expectStatus(await admin.post('/rest/v1/admin/organisations', { name: orgB, ceoEmail: ceoB, ceoFirstName: 'Bo', ceoLastName: 'Bravo' }), [200, 201], 'create org B');
    const list = rows(expectStatus(await admin.get('/rest/v1/admin/organisations'), 200, 'list orgs').body);
    const a = list.find((o) => o.name === orgA);
    const b = list.find((o) => o.name === orgB) ?? created.body;
    expect(a?.id).toBeTruthy();
    expect(b?.id ?? b?.organisationId).toBeTruthy();
    updateState((s) => {
      s.A = { ...s.A, orgId: a.id, orgName: orgA, ceoEmail: ceoA };
      s.B = { ...s.B, orgId: b.id ?? b.organisationId, orgName: orgB, ceoEmail: ceoB };
    });
  });

  test('1.3 CEO A activates, onboards and invites Initial Manager A (UI); CEO B does the same over the API', async ({ page }) => {
    const s = loadState();
    const imA = `im.a.${tag}@alpha-e2e.test`;
    const imB = `im.b.${tag}@bravo-e2e.test`;
    const { link } = await waitForLink(s.A.ceoEmail!, /activate-account\?token=/);
    await page.goto(link);
    await page.locator('#password').fill(SYNTHETIC_PASSWORD);
    await page.locator('#confirm').fill(SYNTHETIC_PASSWORD);
    await page.locator('button[type=submit]').click();
    await expect(page.getByText('Your account setup is complete')).toBeVisible();
    await uiLogin(page, DEFAULT_ORIGIN, s.A.ceoEmail!, SYNTHETIC_PASSWORD);
    if (page.url().includes('/onboarding')) {
      const ob = await uiOnboard(page, { name: `Alpha HQ ${tag}`, label: `alpha-hq-${tag}`, first: 'Ada', last: 'Alpha' });
      updateState((st) => { st.notes.ceoAOnboarding = ob; });
    }
    await page.goto(`${new URL(page.url()).origin}/settings/workspace/team`);
    await page.locator('#im-email').fill(imA);
    await page.locator('#im-first').fill('Ivy');
    await page.locator('#im-last').fill('Alpha');
    await shot(page, '01-ceo-invite-initial-manager');
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(page.getByText(`Invitation created for ${imA}`)).toBeVisible();

    const ceoB = new ApiClient({ label: 'ceoB' });
    const { link: linkB } = await waitForLink(s.B.ceoEmail!, /activate-account\?token=/);
    expectStatus(await ceoB.post('/rest/v1/auth/activate-account', { token: tokenFrom(linkB), newPassword: SYNTHETIC_PASSWORD }), 200, 'activate CEO B');
    expectStatus(await ceoB.login(s.B.ceoEmail!, SYNTHETIC_PASSWORD), 200, 'CEO B login');
    expectStatus(await ceoB.post('/rest/v1/managers/initial-manager-invite', { email: imB, firstName: 'Ike', lastName: 'Bravo' }), [200, 201], 'invite IM B');
    updateState((st) => {
      st.A.imEmail = imA;
      st.B.imEmail = imB;
    });
  });

  test('1.4 Initial Manager A: activation, subdomain suggestions, workspace READY through real stages (UI)', async ({ page }) => {
    const s = loadState();
    const { link } = await waitForLink(s.A.imEmail!, /activate-account\?token=/);
    await page.goto(link);
    await page.locator('#password').fill(SYNTHETIC_PASSWORD);
    await page.locator('#confirm').fill(SYNTHETIC_PASSWORD);
    await page.locator('button[type=submit]').click();
    await expect(page.getByText('Your account setup is complete')).toBeVisible();
    await uiLogin(page, DEFAULT_ORIGIN, s.A.imEmail!, SYNTHETIC_PASSWORD);
    const label = `alpha-${tag}`.replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const ob = await uiOnboard(page, { name: `Alpha Ops ${tag}`, label, first: 'Ivy', last: 'Alpha', shotPrefix: '01-im-a' });
    expect(ob.suggestions.length).toBeGreaterThan(0);
    expect([200, 201]).toContain(ob.createStatus);
    await shot(page, '01-im-a-landed');
    const ws = await sql(WS_SQL, [s.A.imEmail]);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ schema_status: 'READY', subdomain: label });
    updateState((st) => {
      st.A.label = label;
      st.A.workspaceId = ws[0].id;
      st.A.schema = ws[0].schema_name;
      st.notes.imAOnboarding = ob;
      st.notes.imARegistry = ws[0];
    });
    await page.goto(`${workspaceOrigin(label)}/login`);
    await expect(page.getByText(new RegExp(`Alpha Ops ${tag}`, 'i')).first()).toBeVisible();
    await shot(page, '01-workspace-host-a-login');
    expect(workspaceHost(label)).toContain(label);
  });

  test('1.5 Initial Manager B over the API: suggestions, create with a subdomain, READY', async () => {
    const s = loadState();
    const { link } = await waitForLink(s.B.imEmail!, /activate-account\?token=/);
    const im = new ApiClient({ label: 'imB' });
    expectStatus(await im.post('/rest/v1/auth/activate-account', { token: tokenFrom(link), newPassword: SYNTHETIC_PASSWORD }), 200, 'activate IM B');
    expectStatus(await im.login(s.B.imEmail!, SYNTHETIC_PASSWORD), 200, 'IM B login');
    const sugg = expectStatus(await im.post('/rest/v1/manager-workspaces/subdomain/suggestions', { name: `Bravo Ops ${tag}` }), 200, 'suggestions');
    expect(sugg.body.suggestions.length).toBeGreaterThan(0);
    const label = `bravo-${tag}`.replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const check = expectStatus(await im.post('/rest/v1/manager-workspaces/subdomain/check', { candidate: label }), [200, 201], 'check');
    expect(check.body.available).toBe(true);
    const t0 = Date.now();
    const created = expectStatus(await im.post('/rest/v1/manager-workspaces', { name: `Bravo Ops ${tag}`, subdomain: label }), [200, 201], 'create workspace B');
    let mine = created.body;
    while ((mine.schemaStatus ?? mine.status) !== 'READY' && Date.now() - t0 < 120_000) {
      await new Promise((r) => setTimeout(r, 1000));
      mine = expectStatus(await im.get('/rest/v1/manager-workspaces/me?fresh=1'), 200, 'me').body;
    }
    const elapsed = Date.now() - t0;
    const ws = await sql(WS_SQL, [s.B.imEmail]);
    expect(ws[0].schema_status).toBe('READY');
    updateState((st) => {
      st.B.label = label;
      st.B.workspaceId = ws[0].id;
      st.B.schema = ws[0].schema_name;
      st.notes.imBSuggestions = sugg.body.suggestions;
      st.notes.workspaceBCreateMs = elapsed;
      st.notes.workspaceBCreateResponse = created.body;
    });
  });
});

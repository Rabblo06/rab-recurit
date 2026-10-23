import { expect, test } from '@playwright/test';

import { ApiClient, expectStatus } from '../lib/http';
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

  test('1.2 admin onboards; Admin Panel has no organisation creation; CEO A is invited from Members → Add with the email only (UI), CEO B over the API', async ({ page }) => {
    await uiLogin(page, DEFAULT_ORIGIN, ADMIN_EMAIL, SYNTHETIC_PASSWORD);
    if (page.url().includes('/onboarding')) {
      const ob = await uiOnboard(page, { name: `Crewflow Platform ${tag}`, label: `platform-${tag}`, first: 'Wave', last: 'Admin', shotPrefix: '01-admin' });
      updateState((st) => { st.notes.adminOnboarding = ob; });
    }
    // With a workspace, sign-in on the default host hands the session off to the workspace host (login handoff ON).
    const adminOrigin = new URL(page.url()).origin;
    updateState((st) => { st.notes.adminLandedOrigin = adminOrigin; });

    // Owner correction 2026-10-23: the Admin Panel is General | Config | Health — no Organisations tab, no "+ New Organisation".
    await page.goto(`${adminOrigin}/settings/admin`);
    await expect(page.getByRole('button', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Config' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Health' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Organisations' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /new organisation/i })).toHaveCount(0);
    await shot(page, '01-admin-panel-without-organisations');
    for (const tab of ['Config', 'Health']) {
      await page.getByRole('button', { name: tab }).click();
      await page.waitForTimeout(400);
    }

    // Members: Team | Add | Roles. Add = the CEO email only, role fixed to CEO (Organisation).
    await page.goto(`${adminOrigin}/settings/workspace/members?tab=team`);
    const tabs = page.getByRole('navigation', { name: 'Members sections' }).getByRole('button');
    await expect(tabs).toHaveText(['Team', 'Add', 'Roles']);
    await shot(page, '01-members-team-add-roles');
    await tabs.filter({ hasText: 'Add' }).click();
    await expect(page.getByRole('heading', { name: 'Add organisation' })).toBeVisible();
    await expect(page.getByText("Invite an organisation's CEO to complete their account and workspace setup.")).toBeVisible();
    for (const label of ['Organisation name', 'CEO first name', 'CEO last name']) await expect(page.getByLabel(label)).toHaveCount(0);
    const ceoA = `ceo.a.${tag}@alpha-e2e.test`;
    await page.getByLabel('CEO email').fill(ceoA);
    await shot(page, '01-members-add-form');
    const sent = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/admin/organisation-invitations' && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    const sentRes = await sent;
    expect(sentRes.status()).toBe(200);
    expect((await sentRes.json()).outcome).toBe('invited');
    await expect(page.getByText(`Invitation sent to ${ceoA}`)).toBeVisible();
    await shot(page, '01-members-add-invitation-sent');
    // No organisation exists yet for the invited CEO.
    expect(await sql(`select 1 from core."user" where email = $1`, [ceoA])).toHaveLength(0);

    const admin = new ApiClient({ label: 'admin' });
    expectStatus(await admin.login(ADMIN_EMAIL, SYNTHETIC_PASSWORD), 200, 'admin login');
    const ceoB = `ceo.b.${tag}@bravo-e2e.test`;
    // Organisation/CEO names are refused at this step (the CEO supplies them).
    expectStatus(await admin.post('/rest/v1/admin/organisation-invitations', { email: ceoB, organisationName: 'Bravo' }), 400, 'org name refused');
    expectStatus(await admin.post('/rest/v1/admin/organisations', { name: 'Old', ceoEmail: ceoB, ceoFirstName: 'B', ceoLastName: 'O' }), 404, 'retired create route');
    expect(expectStatus(await admin.post('/rest/v1/admin/organisation-invitations', { email: ceoB }), 200, 'invite CEO B').body.outcome).toBe('invited');
    updateState((s) => {
      s.A = { ...s.A, orgName: `Alpha Staffing ${tag}`, ceoEmail: ceoA };
      s.B = { ...s.B, orgName: `Bravo Crew ${tag}`, ceoEmail: ceoB };
    });
  });

  test('1.3 CEO A activates, onboards and invites Initial Manager A (UI); CEO B does the same over the API', async ({ page }) => {
    const s = loadState();
    const imA = `im.a.${tag}@alpha-e2e.test`;
    const imB = `im.b.${tag}@bravo-e2e.test`;
    // The CEO opens the invitation (local LOGGER email sink) and enters their OWN names and organisation name.
    const { link } = await waitForLink(s.A.ceoEmail!, /accept-invitation\?token=/);
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Set up your organisation' })).toBeVisible();
    await page.locator('#invite-first').fill('Ada');
    await page.locator('#invite-last').fill('Alpha');
    await page.locator('#invite-organisation').fill(s.A.orgName!);
    await page.locator('#invite-password').fill(SYNTHETIC_PASSWORD);
    await page.locator('#invite-confirm').fill(SYNTHETIC_PASSWORD);
    await shot(page, '01-ceo-a-accept-invitation');
    const acceptedA = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/invitations/accept');
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    expect((await acceptedA).status()).toBe(200);
    await page.waitForTimeout(800);
    await shot(page, '01-ceo-a-accepted');
    // Only now does the organisation exist — named by the CEO, with the CEO bound to it.
    const orgA = (await sql(`select o.id from core.organisation o join core."user" u on u.organisation_id = o.id where u.email = $1 and o.name = $2`, [s.A.ceoEmail, s.A.orgName]))[0];
    expect(orgA?.id).toBeTruthy();
    updateState((st) => { st.A = { ...st.A, orgId: orgA.id }; });
    await uiLogin(page, DEFAULT_ORIGIN, s.A.ceoEmail!, SYNTHETIC_PASSWORD);
    if (page.url().includes('/onboarding')) {
      // Workspace setup through the existing secure server path (name, subdomain, profile).
      const ob = await uiOnboard(page, { name: `Alpha HQ ${tag}`, label: `alpha-hq-${tag}`, first: 'Ada', last: 'Alpha', shotPrefix: '01-ceo-a-onboarding' });
      updateState((st) => { st.notes.ceoAOnboarding = ob; });
    }
    await shot(page, '01-ceo-a-landed');
    await page.goto(`${new URL(page.url()).origin}/settings/workspace/team`);
    await page.locator('#im-email').fill(imA);
    await page.locator('#im-first').fill('Ivy');
    await page.locator('#im-last').fill('Alpha');
    await shot(page, '01-ceo-invite-initial-manager');
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(page.getByText(`Invitation created for ${imA}`)).toBeVisible();

    const ceoB = new ApiClient({ label: 'ceoB' });
    const { link: linkB } = await waitForLink(s.B.ceoEmail!, /accept-invitation\?token=/);
    const tokenB = tokenFrom(linkB);
    expect(expectStatus(await ceoB.post('/rest/v1/invitations/resolve', { token: tokenB }), 200, 'resolve CEO B').body.kind).toBe('organisation');
    expectStatus(await ceoB.post('/rest/v1/invitations/accept', { token: tokenB, firstName: 'Bo', lastName: 'Bravo', organisationName: s.B.orgName, newPassword: SYNTHETIC_PASSWORD }), 200, 'accept CEO B');
    // Replay of the same link never creates a second organisation.
    expectStatus(await ceoB.post('/rest/v1/invitations/accept', { token: tokenB, firstName: 'Bo', lastName: 'Bravo', organisationName: `${s.B.orgName} again`, newPassword: SYNTHETIC_PASSWORD }), 400, 'replay refused');
    const orgB = (await sql(`select o.id from core.organisation o join core."user" u on u.organisation_id = o.id where u.email = $1`, [s.B.ceoEmail]))[0];
    expect((await sql(`select count(*)::int as n from core.organisation where name like $1`, [`${s.B.orgName}%`]))[0].n).toBe(1);
    updateState((st) => { st.B = { ...st.B, orgId: orgB.id }; });
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

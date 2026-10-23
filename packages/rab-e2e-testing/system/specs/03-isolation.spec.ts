import { expect, test } from '@playwright/test';

import { sql } from '../lib/db';
import { RUN_ID, SYNTHETIC_PASSWORD, workspaceHost, workspaceOrigin } from '../lib/env';
import { ApiClient, expectStatus, rows } from '../lib/http';
import { tokenFrom, waitForLink } from '../lib/mail';
import { loadState, updateState } from '../lib/state';
import { shot, uiLogin } from '../lib/ui';
import { managerFor, staffMobile } from '../lib/actors';

/**
 * Scenario 3 — isolation between two organisations/workspaces on one stack: Manager B and B's staff must not see or
 * change A's data through the API (forged ids, forged headers, A's host, A's origin), search, timeline or CSV export;
 * archived items behave; pay fields are hidden from a role without payroll.view.
 */
const tag = RUN_ID.toLowerCase();
const uniq = Date.now().toString(36).slice(-5);
const NOT_FOUND = [404];

test.describe.serial('S3 isolation A ↔ B', () => {
  let mA: ApiClient;
  let mB: ApiClient;
  let staffB: ApiClient;
  const results: Record<string, unknown> = {};

  test.beforeAll(async () => {
    mA = await managerFor('A');
    mB = await managerFor('B');
  });

  test.afterAll(() => {
    updateState((s) => {
      s.notes.isolation = { ...(s.notes.isolation as object), ...results };
    });
  });

  test('3.1 B sets up its own staff member (mobile) for the cross-tenant probes', async () => {
    const s = loadState();
    const role = expectStatus(await mB.post('/rest/v1/job-roles', { name: `Runner ${tag} ${uniq}`, defaultRatePence: 1300 }), 201, 'B job role').body;
    const email = `staff.b1.${tag}.${uniq}@bravo-e2e.test`;
    expectStatus(await mB.post('/rest/v1/staff', { email, firstName: 'Bea', lastName: 'Bravo', jobRoleId: role.id }), 201, 'B staff');
    const { link } = await waitForLink(email, /activate-account\?token=/);
    const anon = new ApiClient({ host: '127.0.0.1:3300', origin: null, mobile: true });
    expectStatus(await anon.post('/rest/v1/auth/activate-account', { token: tokenFrom(link), newPassword: SYNTHETIC_PASSWORD }), 200, 'B staff activation');
    staffB = await staffMobile(email);
    updateState((st) => {
      st.B.staffEmail = email;
      st.B.jobRoleId = role.id;
    });
    expect(s.A.shiftId).toBeTruthy();
  });

  test('3.2 forged ids: every A record is 404 to Manager B (read and write), never 403/200', async () => {
    const s = loadState();
    const A = s.A;
    const probes: [string, string, unknown?][] = [
      ['GET', `/rest/v1/venues/${A.venueId}`],
      ['PATCH', `/rest/v1/venues/${A.venueId}`, { name: 'pwned' }],
      ['POST', `/rest/v1/venues/${A.venueId}/archive`, {}],
      ['GET', `/rest/v1/venues/${A.venueId}/role-rates`],
      ['GET', `/rest/v1/shifts/${A.shiftId}`],
      ['POST', `/rest/v1/shifts/${A.shiftId}/cancel`, { reason: 'x' }],
      ['POST', `/rest/v1/shifts/${A.shiftId}/archive`, {}],
      ['GET', `/rest/v1/shifts/${A.shiftId}/pipeline`],
      ['POST', `/rest/v1/shifts/${A.shiftId}/offers`, { staffProfileId: A.staffProfileId }],
      ['POST', `/rest/v1/offers/${A.offerId}/confirm`, {}],
      ['POST', `/rest/v1/offers/${A.offerId}/withdraw`, {}],
      ['GET', `/rest/v1/staff/${A.staffProfileId}`],
      ['PATCH', `/rest/v1/staff/${A.staffProfileId}`, { firstName: 'pwned' }],
      ['GET', `/rest/v1/staff/${A.staffProfileId}/timeline`],
      ['POST', `/rest/v1/attendance/${A.attendanceId}/correct`, { field: 'breakMinutes', newValue: '30', reason: 'cross-tenant probe' }],
      ['GET', `/rest/v1/attendance/report/shift/${A.shiftId}`],
      ['PATCH', `/rest/v1/attendance/report/shift/${A.shiftId}/finalise`, {}],
      ['POST', `/rest/v1/payroll/records/${A.payrollRecordId}/approve`, {}],
      ['POST', `/rest/v1/payroll/records/${A.payrollRecordId}/reject`, { reason: 'cross-tenant probe' }],
      ['GET', `/rest/v1/payroll/runs/${A.payrollRunId}`],
      ['GET', `/rest/v1/payroll/runs/${A.payrollRunId}/export`],
      ['POST', `/rest/v1/payroll/runs/${A.payrollRunId}/finalise`, {}],
      ['GET', `/rest/v1/timeline/shifts/${A.shiftId}`],
      ['GET', `/rest/v1/timeline/offers/${A.offerId}`],
      ['GET', `/rest/v1/timeline/staff/${A.staffProfileId}`],
      ['GET', `/rest/v1/timeline/attendance/${A.attendanceId}`],
      ['GET', `/rest/v1/timeline/payroll-records/${A.payrollRecordId}`],
    ];
    const got: Record<string, number> = {};
    for (const [method, path, body] of probes) {
      const r = await mB.req(method, path, body);
      got[`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`] = r.status;
    }
    results.forgedIds = got;
    const leaks = Object.entries(got).filter(([, st]) => !NOT_FOUND.includes(st));
    expect(leaks, `non-404 answers: ${JSON.stringify(leaks)}`).toEqual([]);
    // Nothing changed in A.
    const v = await sql(`select name, status from ${s.A.schema}.venue where id = $1`, [A.venueId]);
    expect(v[0].name).not.toBe('pwned');
    const pr = await sql(`select status from ${s.A.schema}.payroll_record where id = $1`, [A.payrollRecordId]);
    expect(pr[0].status).toBe('processing');
  });

  test('3.3 lists, search and CSV never carry A rows for B; A sees its own', async () => {
    const s = loadState();
    const venueA = (await sql(`select name from ${s.A.schema}.venue where id = $1`, [s.A.venueId]))[0].name as string;
    const listB = {
      venues: rows((await mB.get('/rest/v1/venues?includeArchived=true')).body),
      shifts: rows((await mB.get('/rest/v1/shifts?includeArchived=true')).body),
      staff: rows((await mB.get('/rest/v1/staff')).body),
      offers: rows((await mB.get('/rest/v1/offers')).body),
      attendance: rows((await mB.get('/rest/v1/attendance')).body),
      payroll: rows((await mB.get('/rest/v1/payroll/records')).body),
    };
    const aIds = new Set([s.A.venueId, s.A.shiftId, s.A.staffProfileId, s.A.offerId, s.A.attendanceId, s.A.payrollRecordId]);
    const leaked = Object.entries(listB).flatMap(([k, list]) => list.filter((r: any) => aIds.has(r.id)).map((r: any) => `${k}:${r.id}`));
    expect(leaked).toEqual([]);
    const searchB = expectStatus(await mB.get(`/rest/v1/search?q=${encodeURIComponent(venueA)}`), 200, 'search B');
    const searchA = expectStatus(await mA.get(`/rest/v1/search?q=${encodeURIComponent(venueA)}`), 200, 'search A');
    const flat = (b: any) => JSON.stringify(b);
    expect(flat(searchB.body)).not.toContain(s.A.venueId!);
    expect(flat(searchA.body)).toContain(s.A.venueId!);
    const csvB = await mB.get(`/rest/v1/payroll/runs/${s.A.payrollRunId}/export`);
    expect(csvB.status).toBe(404);
    expect(csvB.text).not.toContain('Shaker');
    results.lists = Object.fromEntries(Object.entries(listB).map(([k, v]) => [k, v.length]));
    results.search = { bHits: flat(searchB.body).length, aContainsVenue: true };
  });

  test('3.4 forged workspace/organisation headers and X-Forwarded-Host are ignored', async () => {
    const s = loadState();
    const forged = {
      'X-Workspace-Id': s.A.workspaceId!,
      'X-Organisation-Id': s.A.orgId!,
      'X-Forwarded-Host': workspaceHost(s.A.label!),
      'X-Original-Host': workspaceHost(s.A.label!),
    };
    const r1 = await mB.get(`/rest/v1/venues/${s.A.venueId}`, forged);
    const r2 = await mB.get('/rest/v1/venues', forged);
    expect(r1.status).toBe(404);
    expect(JSON.stringify(r2.body)).not.toContain(s.A.venueId!);
    // A body carrying organisationId is a validation failure, never a hint.
    const r3 = await mB.post('/rest/v1/venues', { name: `x ${uniq}`, type: 'hotel', organisationId: s.A.orgId });
    expect(r3.status).toBe(400);
    results.forgedHeaders = { byId: r1.status, list: r2.status, bodyOrgId: r3.status };
  });

  test("3.5 A's host with B's session → 404 WORKSPACE_HOST_MISMATCH; CORS/CSRF from A's origin with B's session", async () => {
    const s = loadState();
    const onA = mB.clone({ host: workspaceHost(s.A.label!), origin: workspaceOrigin(s.A.label!) });
    const me = await onA.get('/rest/v1/auth/me');
    const venues = await onA.get('/rest/v1/venues');
    expect(me.status).toBe(404);
    expect(venues.status).toBe(404);
    expect(me.text).toContain('WORKSPACE_HOST_MISMATCH');
    expect(me.text).not.toContain(s.A.label!);
    // B's own host, but the request comes from A's (trusted, registered) origin — the cross-subdomain CSRF shape.
    const fromA = mB.clone({ origin: workspaceOrigin(s.A.label!) });
    const csrfWrite = await fromA.post('/rest/v1/venues', { name: `csrf ${uniq}`, type: 'hotel' });
    const crossRead = await fromA.get('/rest/v1/venues');
    const preflight = await mB.req('OPTIONS', '/rest/v1/venues', undefined, {
      Origin: workspaceOrigin(s.A.label!), 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'content-type',
    });
    results.wrongHost = { me: me.status, venues: venues.status, code: me.body?.code ?? me.text.slice(0, 120) };
    results.crossOrigin = {
      csrfWriteStatus: csrfWrite.status,
      crossReadStatus: crossRead.status,
      crossReadAcao: crossRead.headers['access-control-allow-origin'] ?? null,
      crossReadAcac: crossRead.headers['access-control-allow-credentials'] ?? null,
      preflightStatus: preflight.status,
      preflightAcao: preflight.headers['access-control-allow-origin'] ?? null,
    };
    // Refused either way (the server answers 404 when the Origin is not the request host's own workspace origin).
    expect([403, 404]).toContain(csrfWrite.status);
    expect(crossRead.status).toBe(404);
    (results.crossOrigin as any).crossReadBody = crossRead.text.slice(0, 200);
    expect(JSON.stringify(crossRead.body)).not.toMatch(/venue|shift|staff/i);
    // W6-E2E-03 (fixed): A's origin may not read B's host at all (no ACAO on the response or the preflight), and the
    // cross-origin refusal names only the default URL, never the visitor's own workspace address.
    expect(crossRead.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(crossRead.text).not.toContain(s.B.label!);
    const created = await sql(`select count(*)::int as n from ${s.B.schema}.venue where name = $1`, [`csrf ${uniq}`]);
    expect(created[0].n).toBe(0);
  });

  test("3.6 B's staff cannot see or act on A's offers/shifts (mobile)", async () => {
    const s = loadState();
    staffB ??= await staffMobile(s.B.staffEmail!);
    const mine = rows(expectStatus(await staffB.get('/rest/v1/offers/mine'), 200, 'B offers/mine').body);
    expect(mine.some((o: any) => o.id === s.A.offerId)).toBe(false);
    const accept = await staffB.post(`/rest/v1/offers/${s.A.offerId}/accept`);
    const decline = await staffB.post(`/rest/v1/offers/${s.A.offerId}/decline`, {});
    const checkIn = await staffB.post('/rest/v1/attendance/check-in', { shiftId: s.A.shiftId });
    const team = await staffB.get(`/rest/v1/attendance/me/shift/${s.A.shiftId}/team`);
    results.staffB = { accept: accept.status, decline: decline.status, checkIn: checkIn.status, team: team.status };
    expect([accept.status, decline.status, checkIn.status, team.status].every((x) => x === 404)).toBe(true);
  });

  test('3.7 archive: archived venue leaves default lists, stays readable with includeArchived, blocks new shifts, restores', async () => {
    const s = loadState();
    const v = expectStatus(await mA.post('/rest/v1/venues', { name: `Archive Me ${tag} ${uniq}`, type: 'hotel' }), 201, 'venue to archive').body;
    const arch = await mA.post(`/rest/v1/venues/${v.id}/archive`, {});
    expect([200, 201]).toContain(arch.status);
    const def = rows((await mA.get('/rest/v1/venues')).body).some((x: any) => x.id === v.id);
    const inc = rows((await mA.get('/rest/v1/venues?includeArchived=true')).body).some((x: any) => x.id === v.id);
    const byId = await mA.get(`/rest/v1/venues/${v.id}`);
    const start = new Date(Date.now() + 48 * 3600_000);
    const shiftAtArchived = await mA.post('/rest/v1/shifts', { venueId: v.id, jobRoleId: s.A.jobRoleId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3600_000).toISOString(), requiredCount: 1 });
    const archAgain = await mA.post(`/rest/v1/venues/${v.id}/archive`, {});
    const bRestore = await mB.post(`/rest/v1/venues/${v.id}/restore`, {});
    const restore = await mA.post(`/rest/v1/venues/${v.id}/restore`, {});
    const after = rows((await mA.get('/rest/v1/venues')).body).some((x: any) => x.id === v.id);
    results.archive = { archive: arch.status, inDefaultList: def, inIncludeArchived: inc, byId: byId.status, byIdStatus: byId.body?.status, shiftAtArchived: [shiftAtArchived.status, shiftAtArchived.body?.code ?? shiftAtArchived.body?.message], archiveAgain: archAgain.status, bRestore: bRestore.status, restore: restore.status, inDefaultAfterRestore: after };
    expect(def).toBe(false);
    expect(inc).toBe(true);
    expect(shiftAtArchived.status).toBeGreaterThanOrEqual(400);
    expect(archAgain.status).toBe(409);
    expect(bRestore.status).toBe(404);
    expect([200, 201]).toContain(restore.status);
    expect(after).toBe(true);
    updateState((st) => { st.A.archivedVenueId = v.id; });
  });

  test('3.8 field permissions: a Venue Manager (attendance.view, no payroll.view) never receives pay fields', async () => {
    const s = loadState();
    const email = `vm.a1.${tag}.${uniq}@alpha-e2e.test`;
    const vm = expectStatus(await mA.post('/rest/v1/venue-managers', { email, firstName: 'Vic', lastName: 'Venue' }), [200, 201], 'create VM').body;
    const vmId = vm.id ?? vm.profileId ?? vm.managerProfileId;
    expectStatus(await mA.post(`/rest/v1/venue-managers/${vmId}/venues`, { venueId: s.A.venueId }), [200, 201, 204], 'assign VM venue');
    const { link } = await waitForLink(email, /activate-account\?token=/);
    const anon = new ApiClient({ host: '127.0.0.1:3300', origin: null, mobile: true });
    expectStatus(await anon.post('/rest/v1/auth/activate-account', { token: tokenFrom(link), newPassword: SYNTHETIC_PASSWORD }), 200, 'VM activation');
    const vmc = new ApiClient({ host: '127.0.0.1:3300', origin: null, mobile: true, label: 'vm' });
    expectStatus(await vmc.login(email, SYNTHETIC_PASSWORD, { applicationTarget: 'venue_manager_app' }), 200, 'VM login');
    const caps = expectStatus(await vmc.get('/rest/v1/auth/capabilities'), 200, 'caps').body;
    const report = await vmc.get(`/rest/v1/attendance/report/shift/${s.A.shiftId}`);
    const attendance = await vmc.get('/rest/v1/attendance');
    const payroll = await vmc.get('/rest/v1/payroll/records');
    const managerReport = expectStatus(await mA.get(`/rest/v1/attendance/report/shift/${s.A.shiftId}`), 200, 'manager report').body;
    const PAY = /"(earnedPence|payrollApprovedPence|payRatePence|payRateSnapshotPence|amountPence|grossPence)"/;
    results.fieldPolicy = {
      caps: { payrollView: caps['payroll.view'] ?? caps.PAYROLL_VIEW ?? caps, attendanceView: caps['attendance.view'] },
      vmReport: report.status, vmReportHasPay: PAY.test(report.text), vmAttendance: attendance.status, vmAttendanceHasPay: PAY.test(attendance.text),
      vmPayroll: payroll.status, managerReportHasPay: PAY.test(JSON.stringify(managerReport)),
    };
    expect(report.status).toBe(200);
    expect(PAY.test(report.text)).toBe(false);
    if (attendance.status === 200) expect(PAY.test(attendance.text)).toBe(false);
    expect(payroll.status).toBe(403);
    expect(PAY.test(JSON.stringify(managerReport))).toBe(true);
  });

  test("3.9 UI: B signs in on A's workspace host — refused with the wrong-workspace message, no session left behind", async ({ page }) => {
    const s = loadState();
    const origin = workspaceOrigin(s.A.label!);
    await page.goto(`${origin}/login`);
    await page.locator('button.auth-email-start').click();
    await shot(page, '03-workspace-host-a-login-page');
    await page.locator('#email').fill(s.B.imEmail!);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#password').fill(SYNTHETIC_PASSWORD);
    const meCalls: number[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname === '/rest/v1/auth/me') meCalls.push(r.status());
    });
    const loginP = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/auth/login', { timeout: 120_000 });
    await page.getByRole('button', { name: /^(Sign in|Try again)$/ }).click();
    let login = await loginP;
    if (login.status() === 429) {
      await page.waitForTimeout(Number((await login.allHeaders())['retry-after'] ?? 60) * 1000 + 1000);
      const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/auth/login', { timeout: 120_000 });
      await page.getByRole('button', { name: /^(Sign in|Try again)$/ }).click();
      login = await again;
    }
    const loginBody = await login.json().catch(() => null);
    await page.waitForTimeout(1500);
    await shot(page, '03-wrong-host-b-on-a');
    const bodyText = (await page.locator('body').innerText()).slice(0, 400);
    // W6-E2E-02 (fixed): no session on A's host — no cookie, and the cookie-less client is simply unauthenticated.
    const cookies = (await page.context().cookies()).filter((c) => c.domain.includes(s.A.label!) && /crewflow_session|rab_rt/.test(c.name));
    const leftover = new ApiClient({ host: workspaceHost(s.A.label!), origin });
    for (const c of cookies) leftover.cookies.set(c.name, c.value);
    const venues = await leftover.get('/rest/v1/venues');
    results.uiWrongHost = { login: login.status(), loginBody, meCalls, bodyText, leftoverCookies: cookies.map((c) => `${c.name}@${c.domain}`), leftoverVenues: venues.status };
    expect(login.status()).toBe(404);
    expect(loginBody?.code).toBe('WORKSPACE_HOST_SIGN_IN_REFUSED');
    expect(JSON.stringify(loginBody)).not.toContain(s.B.label!);
    expect(bodyText).toContain('This account belongs to a different workspace');
    expect(bodyText).not.toContain('Unable to reach the server');
    expect(await page.getByRole('link', { name: 'Go to the main sign-in page' }).count()).toBe(1);
    expect(cookies).toEqual([]);
    expect(venues.status).toBe(401);
    expect(meCalls.filter((x) => x === 200)).toEqual([]);
    const venueA = (await sql(`select name from ${s.A.schema}.venue where id = $1`, [s.A.venueId]))[0].name as string;
    expect(await page.getByText(venueA).count()).toBe(0);
  });
});

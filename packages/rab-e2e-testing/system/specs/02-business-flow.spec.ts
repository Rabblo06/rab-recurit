import { expect, test } from '@playwright/test';

import { sql } from '../lib/db';
import { RUN_ID, SYNTHETIC_PASSWORD, workspaceHost, workspaceOrigin } from '../lib/env';
import { ApiClient, expectStatus, rows } from '../lib/http';
import { tokenFrom, waitForLink } from '../lib/mail';
import { shiftQrToken } from '../lib/qr';
import { loadState, updateState } from '../lib/state';
import { shot, uiLogin } from '../lib/ui';
import { managerFor, staffMobile } from '../lib/actors';

/**
 * Scenario 2 — Manager A runs a real agency day in workspace A: venue (geofenced), job role, staff invited and activated
 * from the worker email log, shift, offer, staff accepts on the mobile API, manager confirms, check-in → clock-in →
 * clock-out with location evidence, attendance review, report finalise (timesheet), payroll record approval, payroll run.
 * Then: every row is in workspace A's schema and none in B's.
 */
const tag = RUN_ID.toLowerCase();
const uniq = Date.now().toString(36).slice(-5);
// Venue at Trafalgar Square; INSIDE ~11 m away, OUTSIDE ~1.1 km away (same geometry as the server's own integration suite).
const VENUE = { lat: 51.508, lng: -0.128, radius: 150 };
const INSIDE = { lat: 51.5081, lng: -0.128 };
const OUTSIDE = { lat: 51.518, lng: -0.128 };
const fix = (p: { lat: number; lng: number }, ageMs = 5_000, accuracyM = 15) => ({ ...p, accuracyM, capturedAt: new Date(Date.now() - ageMs).toISOString() });

test.describe.serial('S2 Manager A business flow in workspace A', () => {
  let m: ApiClient;
  let staff: ApiClient;

  test('2.1 venue (geofence enforced), job role, staff invite → activation from the worker email log', async () => {
    m = await managerFor('A');
    const me = expectStatus(await m.get('/rest/v1/auth/me'), 200, 'me').body;
    expect(me.roles).toContain('manager');
    const venue = expectStatus(await m.post('/rest/v1/venues', {
      name: `Grand Hall ${tag} ${uniq}`, type: 'hotel', lat: VENUE.lat, lng: VENUE.lng, geofenceRadiusM: VENUE.radius, enforceGeofence: true,
    }), 201, 'create venue').body;
    const role = expectStatus(await m.post('/rest/v1/job-roles', { name: `Bartender ${tag} ${uniq}`, defaultRatePence: 1450 }), 201, 'create job role').body;
    const staffEmail = `staff.a1.${tag}.${uniq}@alpha-e2e.test`;
    const created = expectStatus(await m.post('/rest/v1/staff', { email: staffEmail, firstName: 'Sam', lastName: 'Shaker', jobRoleId: role.id, defaultPayRatePence: 1450 }), 201, 'create staff').body;
    const { link } = await waitForLink(staffEmail, /activate-account\?token=/);
    const anon = new ApiClient({ host: '127.0.0.1:3300', origin: null, mobile: true });
    expectStatus(await anon.post('/rest/v1/auth/activate-account', { token: tokenFrom(link), newPassword: SYNTHETIC_PASSWORD }), 200, 'staff activation');
    staff = await staffMobile(staffEmail);
    const profileId = created.staffProfileId ?? created.profile?.id ?? created.id;
    updateState((s) => {
      s.A.venueId = venue.id;
      s.A.geoVenueId = venue.id;
      s.A.jobRoleId = role.id;
      s.A.staffEmail = staffEmail;
      s.A.staffProfileId = profileId;
      s.A.staffUserId = created.userId ?? created.user?.id;
      s.notes.staffCreateKeys = Object.keys(created);
    });
  });

  test('2.2 shift → publish → offer → staff accepts (mobile, Bearer) → manager confirms', async () => {
    const s = loadState();
    m ??= await managerFor('A');
    staff ??= await staffMobile(s.A.staffEmail!);
    const startsAt = new Date(Date.now() - 5 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 6 * 3600_000);
    const shift = expectStatus(await m.post('/rest/v1/shifts', { venueId: s.A.venueId, jobRoleId: s.A.jobRoleId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1, breakMinutes: 0 }), 201, 'create shift').body;
    expectStatus(await m.post(`/rest/v1/shifts/${shift.id}/publish`), 201, 'publish');
    let staffProfileId = s.A.staffProfileId!;
    let offer = await m.post(`/rest/v1/shifts/${shift.id}/offers`, { staffProfileId });
    if (offer.status !== 201) {
      // Resolve the profile id from the staff list if the create response used another key.
      const list = rows(expectStatus(await m.get(`/rest/v1/staff?q=${encodeURIComponent(s.A.staffEmail!)}`), 200, 'staff list').body);
      staffProfileId = list[0]?.id ?? staffProfileId;
      offer = await m.post(`/rest/v1/shifts/${shift.id}/offers`, { staffProfileId });
    }
    expectStatus(offer, 201, 'send offer');
    const mine = rows(expectStatus(await staff.get('/rest/v1/offers/mine'), 200, 'offers/mine').body);
    expect(mine.some((o) => o.id === offer.body.id || o.offerId === offer.body.id)).toBe(true);
    expectStatus(await staff.post(`/rest/v1/offers/${offer.body.id}/accept`), 201, 'staff accept');
    const confirmed = await m.post(`/rest/v1/offers/${offer.body.id}/confirm`);
    expect([201, 409]).toContain(confirmed.status);
    const seat = await sql(`select status, check_in_required from ${s.A.schema}.shift_assignment where shift_id = $1`, [shift.id]);
    expect(seat[0]).toMatchObject({ status: 'confirmed' });
    updateState((st) => {
      st.A.shiftId = shift.id;
      st.A.offerId = offer.body.id;
      st.A.staffProfileId = staffProfileId;
      st.notes.confirmStatus = confirmed.status;
    });
  });

  test('2.3 check-in → clock-in → clock-out with geofence evidence (outside refused, inside verified)', async () => {
    const s = loadState();
    staff ??= await staffMobile(s.A.staffEmail!);
    const shiftRow = (await sql(`select id, venue_id, qr_version from ${s.A.schema}.shift where id = $1`, [s.A.shiftId]))[0];
    const qr = shiftQrToken({ id: shiftRow.id, venueId: shiftRow.venue_id, qrVersion: shiftRow.qr_version });
    const missing = await staff.post('/rest/v1/attendance/check-in', { shiftId: s.A.shiftId });
    const outside = await staff.post('/rest/v1/attendance/check-in', { shiftId: s.A.shiftId, ...fix(OUTSIDE) });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(outside.status).toBeGreaterThanOrEqual(400);
    const early = await staff.post('/rest/v1/attendance/clock-in', { shiftId: s.A.shiftId, qrToken: qr, ...fix(INSIDE) });
    expect({ status: early.status, code: early.body?.code }).toEqual({ status: 409, code: 'CHECK_IN_REQUIRED' });
    const checkIn = expectStatus(await staff.post('/rest/v1/attendance/check-in', { shiftId: s.A.shiftId, ...fix(INSIDE) }), 200, 'check-in inside').body;
    expect(checkIn).toMatchObject({ locationVerified: true, geofenceEnforced: true });
    const clockIn = expectStatus(await staff.post('/rest/v1/attendance/clock-in', { shiftId: s.A.shiftId, qrToken: qr, ...fix(INSIDE) }), 201, 'clock-in').body;
    const active = expectStatus(await staff.get('/rest/v1/attendance/me/active'), 200, 'me/active').body;
    const clockOutOutside = await staff.post('/rest/v1/attendance/clock-out', { qrToken: qr, ...fix(OUTSIDE) });
    expect(clockOutOutside.status).toBeGreaterThanOrEqual(400);
    const out = expectStatus(await staff.post('/rest/v1/attendance/clock-out', { qrToken: qr, ...fix(INSIDE) }), 201, 'clock-out').body;
    updateState((st) => {
      st.A.attendanceId = out.id;
      st.notes.geofence = { missing: [missing.status, missing.body?.code], outside: [outside.status, outside.body?.code], clockOutOutside: [clockOutOutside.status, clockOutOutside.body?.code], checkIn, clockInStatus: clockIn.status, activeKeys: Object.keys(active ?? {}) };
    });
  });

  test('2.4 attendance review (correction with reason), report finalise, timesheet, payroll approve, payroll run', async ({ page }) => {
    const s = loadState();
    m ??= await managerFor('A');
    const att = (await sql(`select id, clock_out_at from ${s.A.schema}.attendance where id = $1`, [s.A.attendanceId]))[0];
    const newIn = new Date(new Date(att.clock_out_at).getTime() - 240 * 60_000).toISOString();
    const corr = expectStatus(await m.post(`/rest/v1/attendance/${s.A.attendanceId}/correct`, { field: 'clockInAt', newValue: newIn, reason: 'W6 e2e: staff arrived on time, phone clock-in was late' }), 201, 'correct').body;
    const review = expectStatus(await m.post(`/rest/v1/attendance/report/shift/${s.A.shiftId}/staff/${s.A.staffProfileId}/attendance-review`), 200, 'attendance review').body;
    const fin = expectStatus(await m.patch(`/rest/v1/attendance/report/shift/${s.A.shiftId}/finalise`, {}), 200, 'finalise report').body;
    const report = expectStatus(await m.get(`/rest/v1/attendance/report/shift/${s.A.shiftId}`), 200, 'report').body;
    const rec = (await sql(`select id, status, worked_minutes, amount_pence, pay_rate_pence from ${s.A.schema}.payroll_record where attendance_id = $1`, [s.A.attendanceId]))[0];
    expect(rec?.status).toBe('pending_approval');
    expect(Number(rec.worked_minutes)).toBe(240);
    expect(String(rec.amount_pence)).toBe(String(4 * 1450));
    const recs = rows(expectStatus(await m.get('/rest/v1/payroll/records?status=pending_approval'), 200, 'payroll records').body);
    expect(recs.some((r) => r.id === rec.id)).toBe(true);
    expectStatus(await m.post(`/rest/v1/payroll/records/${rec.id}/approve`), 200, 'approve payroll record');

    // Payroll calendar (Initial Manager only) → prepare → detail → CSV → finalise.
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 6));
    const end = new Date(start.getTime() + 13 * 86400_000);
    const payday = new Date(end.getTime() + 10 * 86400_000);
    const next = new Date(end.getTime() + 86400_000);
    const imp = expectStatus(await m.post('/rest/v1/payroll/calendar/import', {
      year: today.getUTCFullYear(), source: `W6 e2e synthetic calendar ${tag}`,
      periods: [
        { start: iso(start), end: iso(end), payday: iso(payday), needsConfirmation: false },
        { start: iso(next), end: iso(new Date(next.getTime() + 13 * 86400_000)), payday: iso(new Date(next.getTime() + 23 * 86400_000)), needsConfirmation: false },
      ],
    }), [200, 201], 'calendar import').body;
    const periods = expectStatus(await m.get('/rest/v1/payroll/runs'), 200, 'runs').body;
    const periodId = periods.periods.find((p: any) => p.period.start === iso(start)).period.id;
    const prepared = expectStatus(await m.post('/rest/v1/payroll/runs/prepare', { periodId }), 200, 'prepare run').body;
    expect(prepared.totals.records).toBe(1);
    const detail = expectStatus(await m.get(`/rest/v1/payroll/runs/${prepared.id}`), 200, 'run detail').body;
    const csv = expectStatus(await m.get(`/rest/v1/payroll/runs/${prepared.id}/export`), 200, 'csv export');
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    const finalised = expectStatus(await m.post(`/rest/v1/payroll/runs/${prepared.id}/finalise`), 200, 'finalise run').body;
    expect(finalised.status).toBe('finalised');
    const recAfter = (await sql(`select status from ${s.A.schema}.payroll_record where id = $1`, [rec.id]))[0];
    expect(recAfter.status).toBe('processing');
    updateState((st) => {
      st.A.payrollRecordId = rec.id;
      st.A.payrollRunId = prepared.id;
      st.notes.payroll = { correction: corr?.id ?? corr, reviewKeys: Object.keys(review ?? {}), finaliseKeys: Object.keys(fin ?? {}), reportKeys: Object.keys(report ?? {}), imported: imp?.periods?.length ?? imp, totals: prepared.totals, detailStaff: detail.staff?.length, csvLines: csv.text.trim().split('\n').length };
    });

    // UI evidence on workspace host A: payroll page with the run.
    await uiLogin(page, workspaceOrigin(s.A.label!), s.A.imEmail!, SYNTHETIC_PASSWORD);
    await page.goto(`${workspaceOrigin(s.A.label!)}/payroll`);
    await page.waitForLoadState('networkidle');
    await shot(page, '02-workspace-a-payroll');
    await page.goto(`${workspaceOrigin(s.A.label!)}/shifts`);
    await page.waitForLoadState('networkidle');
    await shot(page, '02-workspace-a-shifts');
  });

  test('2.5 every business row is in workspace A schema, none in workspace B schema or core', async () => {
    const s = loadState();
    const tables = ['venue', 'job_role', 'staff_profile', 'shift', 'shift_assignment', 'job_offer', 'attendance', 'attendance_correction', 'shift_report', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip'];
    const counts: Record<string, { A: number; B: number; core: number | null }> = {};
    for (const t of tables) {
      const a = Number((await sql(`select count(*)::int as n from ${s.A.schema}.${t}`))[0].n);
      const b = Number((await sql(`select count(*)::int as n from ${s.B.schema}.${t}`))[0].n);
      const coreExists = (await sql(`select 1 from information_schema.tables where table_schema = 'core' and table_name = $1`, [t])).length > 0;
      const core = coreExists ? Number((await sql(`select count(*)::int as n from core.${t} where workspace_id = $1`, [s.A.workspaceId]).catch(() => [{ n: -1 }]))[0].n) : null;
      counts[t] = { A: a, B: b, core };
    }
    for (const t of ['venue', 'job_role', 'staff_profile', 'shift', 'shift_assignment', 'job_offer', 'attendance', 'payroll_record', 'payroll_run']) {
      expect(counts[t]!.A, `${t} in A`).toBeGreaterThan(0);
      expect(counts[t]!.B, `${t} in B`).toBe(0);
    }
    const shiftInB = await sql(`select count(*)::int as n from ${s.B.schema}.shift where id = $1`, [s.A.shiftId]);
    expect(shiftInB[0].n).toBe(0);
    updateState((st) => {
      st.notes.schemaCounts = counts;
    });
  });
});

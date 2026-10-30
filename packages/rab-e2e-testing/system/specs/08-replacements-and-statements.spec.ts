import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { anonMobile, managerFor, staffMobile } from '../lib/actors';
import { sql } from '../lib/db';
import { EVIDENCE_DIR, RUN_ID, SYNTHETIC_PASSWORD } from '../lib/env';
import { ApiClient, expectStatus, rows } from '../lib/http';
import { tokenFrom, waitForLink } from '../lib/mail';
import { compact, pdfText } from '../lib/pdf-text';
import { loadState, updateState } from '../lib/state';
import { scope, tbl } from '../lib/tenant';

/**
 * Scenario 8 — the manager decisions and the document the business flow does not reach: the Approved Shift Statement PDF the
 * worker renders for the payroll record approved in 2.4 (what it says, who may download it), and replacement requests
 * (staff declines → the worker's shortlist → Manager A approves one request, sending the offer to the chosen replacement,
 * and rejects another), each with its cross-tenant and wrong-role denials.
 */
const tag = RUN_ID.toLowerCase();
const uniq = Date.now().toString(36).slice(-5);
const results: Record<string, unknown> = {};

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, stepMs = 2000): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return { value: v as T, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test.describe.serial('S8 Approved Shift Statement and replacement decisions', () => {
  let mA: ApiClient;
  let mB: ApiClient;

  test.beforeAll(async () => {
    mA = await managerFor('A');
    mB = await managerFor('B');
  });

  test.afterAll(() => {
    updateState((s) => {
      s.notes.replacementsAndStatements = { ...(s.notes.replacementsAndStatements as object), ...results };
    });
  });

  test('8.1 Approved Shift Statement PDF: generated after approval, states the approved shift, downloadable only by its staff member and payroll managers', async () => {
    const s = loadState();
    const staff = await staffMobile(s.A.staffEmail!);
    const { value: entry, ms } = await waitFor(async () => {
      const list = rows(expectStatus(await staff.get('/rest/v1/payroll/me/statements'), 200, 'my statements').body);
      const e = list.find((x: any) => x.payrollRecordId === s.A.payrollRecordId);
      return e?.statement?.state === 'available' && e.statement.fileId ? e : undefined;
    }, 180_000);
    const fileId: string = entry.statement.fileId;

    const own = await staff.get(`/rest/v1/files/${fileId}/download`);
    expect(own.status).toBe(200);
    expect(String(own.headers['content-type'])).toContain('application/pdf');
    const text = pdfText(own.raw);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, '08-approved-shift-statement.txt'), text);
    const has = (phrase: string) => compact(text).toLowerCase().includes(compact(phrase).toLowerCase());
    const ref8 = s.A.payrollRecordId!.replace(/-/g, '').slice(0, 8).toUpperCase();
    // The values 2.4 asserted on the record (4 h corrected, £14.50/h, £58.00), and the people/places the shift involved.
    const expected: Record<string, string> = {
      title: 'Approved Shift Statement',
      staff: 'Sam Shaker',
      employer: s.A.orgName!,
      venue: entry.venueName,
      role: entry.roleName,
      hours: 'Verified payable hours 4h',
      rate: 'Approved hourly rate £14.50 per hour',
      gross: 'Approved gross £58.00',
      approver: 'by Ivy Alpha',
      disclaimer: 'This statement is not a payslip',
    };
    const missing = Object.entries(expected).filter(([, v]) => !has(v)).map(([k]) => k);
    const reference = text.match(/ASS-\d{8}-[0-9A-F]{8}/)?.[0] ?? null;
    const foreign = [s.B.orgName!, s.B.label!, 'Bravo'].filter((v) => has(v));

    const manager = await mA.get(`/rest/v1/files/${fileId}/download`);
    const otherTenant = await mB.get(`/rest/v1/files/${fileId}/download`);
    const otherStaff = await (await staffMobile(s.B.staffEmail!)).get(`/rest/v1/files/${fileId}/download`);
    const anonymous = await anonMobile().get(`/rest/v1/files/${fileId}/download`);
    results.statement = {
      readyAfterMs: ms, bytes: own.raw.length, lines: text.split('\n').length, missing, reference, foreign,
      download: { staff: own.status, managerA: manager.status, managerB: otherTenant.status, staffB: otherStaff.status, anonymous: anonymous.status },
    };
    expect(own.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(missing, `statement text lacks: ${missing.join(', ')}`).toEqual([]);
    expect(reference?.endsWith(`-${ref8}`), `statement reference ${reference} names record ${ref8}`).toBe(true);
    expect(foreign).toEqual([]);
    expect(manager.status).toBe(200);
    expect(manager.raw.equals(own.raw)).toBe(true);
    expect(otherTenant.status).toBe(404);
    expect(otherStaff.status).toBe(404);
    expect(anonymous.status).toBe(401);
  });

  test('8.2 replacement requests: declines yield shortlists; Manager A approves one (offer to the chosen replacement) and rejects another; B and staff are refused', async () => {
    const s = loadState();
    // Two fresh staff in A, invited and activated like everyone else.
    const newStaff = async (n: number) => {
      const email = `repl.${n}.${tag}.${uniq}@alpha-e2e.test`;
      const created = expectStatus(await mA.post('/rest/v1/staff', { email, firstName: `Rory${n}`, lastName: 'Replace', jobRoleId: s.A.jobRoleId, defaultPayRatePence: 1450 }), 201, `create staff R${n}`).body;
      const { link } = await waitForLink(email, /activate-account\?token=/);
      expectStatus(await anonMobile().post('/rest/v1/auth/activate-account', { token: tokenFrom(link), newPassword: SYNTHETIC_PASSWORD }), 200, `R${n} activation`);
      return { email, profileId: created.id as string, client: await staffMobile(email) };
    };
    const r1 = await newStaff(1);
    const r2 = await newStaff(2);

    // Two future shifts; R1 declines the offer for X, R2 the offer for Y.
    const newShift = async (daysAhead: number) => {
      const startsAt = new Date(Date.now() + daysAhead * 86400_000);
      startsAt.setUTCHours(10, 0, 0, 0);
      const shift = expectStatus(await mA.post('/rest/v1/shifts', { venueId: s.A.venueId, jobRoleId: s.A.jobRoleId, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 4 * 3600_000).toISOString(), requiredCount: 1, breakMinutes: 0 }), 201, 'create shift').body;
      expectStatus(await mA.post(`/rest/v1/shifts/${shift.id}/publish`), 201, 'publish');
      return shift.id as string;
    };
    const x = await newShift(3);
    const y = await newShift(4);
    const offerX = expectStatus(await mA.post(`/rest/v1/shifts/${x}/offers`, { staffProfileId: r1.profileId }), 201, 'offer X to R1').body;
    const offerY = expectStatus(await mA.post(`/rest/v1/shifts/${y}/offers`, { staffProfileId: r2.profileId }), 201, 'offer Y to R2').body;
    expectStatus(await r1.client.post(`/rest/v1/offers/${offerX.id}/decline`, { reason: 'e2e: unavailable' }), [200, 201], 'R1 declines X');
    expectStatus(await r2.client.post(`/rest/v1/offers/${offerY.id}/decline`, { reason: 'e2e: unavailable' }), [200, 201], 'R2 declines Y');

    // The worker's periodic scan (WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS, default 120 s) turns each decline into a request.
    const { value: found, ms } = await waitFor(async () => {
      const list = rows(expectStatus(await mA.get('/rest/v1/replacement-requests'), 200, 'list requests').body);
      const rx = list.find((r: any) => r.shiftId === x);
      const ry = list.find((r: any) => r.shiftId === y);
      return rx && ry ? { rx, ry } : undefined;
    }, 300_000, 3000);
    const { rx, ry } = found;
    const shortlistX: string[] = (rx.candidatesSnapshot ?? []).map((c: any) => c.staffProfileId);
    const shortlistY: string[] = (ry.candidatesSnapshot ?? []).map((c: any) => c.staffProfileId);
    expect(rx.status).toBe('awaiting_approval');
    expect(shortlistX).toContain(r2.profileId);
    expect(shortlistX).not.toContain(r1.profileId);
    expect(shortlistY).not.toContain(r2.profileId);

    // Denials first, while both requests are still open.
    const denials = {
      bReads: (await mB.get(`/rest/v1/replacement-requests/${rx.id}`)).status,
      bApproves: (await mB.post(`/rest/v1/replacement-requests/${rx.id}/approve`, { staffProfileId: r2.profileId })).status,
      bRejects: (await mB.post(`/rest/v1/replacement-requests/${ry.id}/reject`, {})).status,
      bListHasA: rows((await mB.get('/rest/v1/replacement-requests')).body).some((r: any) => r.id === rx.id || r.id === ry.id),
      staffApproves: (await r2.client.post(`/rest/v1/replacement-requests/${rx.id}/approve`, { staffProfileId: r2.profileId })).status,
      offShortlist: (await mA.post(`/rest/v1/replacement-requests/${rx.id}/approve`, { staffProfileId: r1.profileId })).status,
      bodyStatus: (await mA.post(`/rest/v1/replacement-requests/${rx.id}/approve`, { staffProfileId: r2.profileId, status: 'offer_sent' })).status,
    };
    expect(denials.bReads).toBe(404);
    expect(denials.bApproves).toBe(404);
    expect(denials.bRejects).toBe(404);
    expect(denials.bListHasA).toBe(false);
    expect([403, 404]).toContain(denials.staffApproves);
    expect(denials.offShortlist).toBe(409);
    expect(denials.bodyStatus).toBe(400);
    expect((await mA.get(`/rest/v1/replacement-requests/${rx.id}`)).body.status).toBe('awaiting_approval');

    // Approve X → the offer goes to R2, exactly once.
    const approved = expectStatus(await mA.post(`/rest/v1/replacement-requests/${rx.id}/approve`, { staffProfileId: r2.profileId }), [200, 201], 'approve X').body;
    expect(approved.status).toBe('offer_sent');
    expect(approved.selectedStaffProfileId).toBe(r2.profileId);
    const r2Offers = rows(expectStatus(await r2.client.get('/rest/v1/offers/mine'), 200, 'R2 offers').body);
    expect(r2Offers.some((o: any) => (o.id ?? o.offerId) === approved.resultingOfferId)).toBe(true);
    const approveAgain = await mA.post(`/rest/v1/replacement-requests/${rx.id}/approve`, { staffProfileId: r2.profileId });
    const rejectApproved = await mA.post(`/rest/v1/replacement-requests/${rx.id}/reject`, {});
    expect(approveAgain.status).toBe(409);
    expect(rejectApproved.status).toBe(409);

    // Reject Y → nothing is sent.
    const rejected = expectStatus(await mA.post(`/rest/v1/replacement-requests/${ry.id}/reject`, {}), [200, 201], 'reject Y').body;
    expect(rejected.status).toBe('rejected');
    const rejectAgain = await mA.post(`/rest/v1/replacement-requests/${ry.id}/reject`, {});
    const approveRejected = await mA.post(`/rest/v1/replacement-requests/${ry.id}/approve`, { staffProfileId: r1.profileId });
    expect(rejectAgain.status).toBe(409);
    expect(approveRejected.status).toBe(409);

    // Database evidence: X has the declined seat + the replacement offer; Y only the declined one; both requests resolved.
    const seats = async (shiftId: string) => Number((await sql(`select count(*)::int as n from ${tbl(s.A, 'shift_assignment')} where ${scope(s.A)} and shift_id = $1`, [shiftId]))[0].n);
    const stored = await sql(`select shift_id, status, selected_staff_profile_id, resulting_offer_id is not null as has_offer, rejected_by is not null as has_rejecter from ${tbl(s.A, 'replacement_request')} where ${scope(s.A)} and shift_id = any($1::uuid[]) order by shift_id = $2 desc`, [[x, y], x]);
    results.replacements = {
      readyAfterMs: ms, shortlistX: shortlistX.length, shortlistY: shortlistY.length, denials,
      approve: { status: approved.status, again: approveAgain.status, rejectAfter: rejectApproved.status },
      reject: { status: rejected.status, again: rejectAgain.status, approveAfter: approveRejected.status },
      seats: { x: await seats(x), y: await seats(y) }, stored,
    };
    expect(await seats(x)).toBe(2);
    expect(await seats(y)).toBe(1);
    expect(stored.map((r: any) => [r.status, r.has_offer, r.has_rejecter])).toEqual([['offer_sent', true, false], ['rejected', false, true]]);
  });
});

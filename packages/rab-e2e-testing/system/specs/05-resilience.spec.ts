import { expect, test } from '@playwright/test';

import { managerFor, staffMobile } from '../lib/actors';
import { sql } from '../lib/db';
import { RUN_ID, SYNTHETIC_PASSWORD } from '../lib/env';
import { ApiClient, expectStatus } from '../lib/http';
import { readWorkerEmails, waitForLink } from '../lib/mail';
import { docker, health, logsSinceAll, restartAsync, start, stop, waitHealthy } from '../lib/stack';
import { loadState, updateState } from '../lib/state';

/**
 * Scenario 5 — resilience on the disposable stack: restart/stop the worker in the middle of a burst of work (no lost or
 * duplicated emails/offers; anything not queued is reported to the caller), take Redis away briefly (fail closed, no
 * corruption), and blip the database connection (everything must come back without a human).
 */
const tag = RUN_ID.toLowerCase();
const uniq = Date.now().toString(36).slice(-5);
const results: Record<string, unknown> = {};

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, stepMs = 1000): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return { value: v as T, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function containerState(name: string): { status: string; exitCode: number; startedAt: string; finishedAt: string } {
  const [status, exitCode, startedAt, finishedAt] = docker(['inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}', name]).trim().split('|');
  return { status: status!, exitCode: Number(exitCode), startedAt: startedAt!, finishedAt: finishedAt! };
}

test.describe.serial('S5 resilience', () => {
  test.afterAll(() => {
    updateState((s) => {
      s.notes.resilience = { ...(s.notes.resilience as object), ...results };
    });
  });

  test('5.1 worker restarted / stopped mid-burst: every queued invitation and every offer exactly once; nothing silently lost', async () => {
    const s = loadState();
    const m = await managerFor('A');
    const N = 18;
    const emails = Array.from({ length: N }, (_, i) => `burst${i}.${tag}.${uniq}@alpha-e2e.test`);
    const created: { email: string; profileId: string; emailQueued: boolean; invitationStatus: string | null; phase: string }[] = [];
    const create = async (i: number, phase: string) => {
      const r = expectStatus(await m.post('/rest/v1/staff', { email: emails[i], firstName: `Burst${i}`, lastName: 'Worker', jobRoleId: s.A.jobRoleId }), 201, `staff (${phase})`);
      created.push({ email: emails[i]!, profileId: r.body.staffProfileId ?? r.body.id, emailQueued: r.body.emailQueued, invitationStatus: r.body.invitationStatus, phase });
    };
    // A third before the restart, a third while the worker restarts (SIGTERM mid-dispatch), a third while it is stopped.
    for (let i = 0; i < N / 3; i++) await create(i, 'before');
    const restartStarted = Date.now();
    const restartP = restartAsync('worker');
    for (let i = N / 3; i < (2 * N) / 3; i++) await create(i, 'during-restart');
    await restartP;
    const workerBackMs = await waitHealthy('worker', 240_000, restartStarted);
    const restartTotalMs = Date.now() - restartStarted;
    stop('worker');
    const stoppedAt = Date.now();
    for (let i = (2 * N) / 3; i < N; i++) await create(i, 'worker-stopped');
    const queuedWhileStopped = await sql(`select status, count(*)::int as n from core.email_outbox where recipient_email = any($1::text[]) group by 1`, [emails.slice((2 * N) / 3)]);
    const startCalled = Date.now();
    start('worker');
    const workerStartMs = await waitHealthy('worker', 240_000, startCalled);
    const stoppedForMs = Date.now() - stoppedAt;
    const queued = created.filter((c) => c.emailQueued).map((c) => c.email);
    const { ms: drainMs } = await waitFor(async () => {
      const got = readWorkerEmails().filter((e) => queued.includes(e.to));
      return new Set(got.map((e) => e.to)).size === queued.length ? got : undefined;
    }, 240_000, 2000);
    await new Promise((r) => setTimeout(r, 15_000)); // let any duplicate surface
    const all = readWorkerEmails().filter((e) => emails.includes(e.to));
    const perRecipient = Object.fromEntries(emails.map((e) => [e, all.filter((x) => x.to === e).length]));
    const outbox = await sql(`select recipient_email, status, dispatch_generation, infrastructure_attempt_count from core.email_outbox where recipient_email = any($1::text[])`, [emails]);

    // Offers: 6 burst staff activate from their links, then bulk offers go out while the worker restarts again.
    const anonM = new ApiClient({ host: '127.0.0.1:3300', origin: null, mobile: true });
    const activatable = created.filter((c) => c.emailQueued).slice(0, 6);
    for (const c of activatable) {
      const { link } = await waitForLink(c.email, /activate-account\?token=/, 30_000);
      expectStatus(await anonM.post('/rest/v1/auth/activate-account', { token: new URL(link).searchParams.get('token'), newPassword: SYNTHETIC_PASSWORD }), 200, 'burst activation');
      // The account becomes ACTIVE (offerable) on its first sign-in, as on a real phone.
      await staffMobile(c.email);
    }
    const startsAt = new Date(Date.now() + 72 * 3600_000);
    const shift = expectStatus(await m.post('/rest/v1/shifts', { venueId: s.A.venueId, jobRoleId: s.A.jobRoleId, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 5 * 3600_000).toISOString(), requiredCount: activatable.length }), 201, 'shift').body;
    expectStatus(await m.post(`/rest/v1/shifts/${shift.id}/publish`), 201, 'publish');
    const restart2At = Date.now();
    const restart2 = restartAsync('worker');
    await new Promise((r) => setTimeout(r, 300));
    const ids = activatable.map((c) => c.profileId);
    const bulk = await m.post(`/rest/v1/shifts/${shift.id}/offers/bulk`, { staffProfileIds: ids });
    const bulkAgain = await m.post(`/rest/v1/shifts/${shift.id}/offers/bulk`, { staffProfileIds: ids });
    await restart2;
    await waitHealthy('worker', 240_000, restart2At);
    await new Promise((r) => setTimeout(r, 15_000));
    const offers = await sql(`select o.staff_profile_id, count(*)::int as n from ${s.A.schema}.job_offer o join ${s.A.schema}.shift_assignment sa on sa.id = o.shift_assignment_id where sa.shift_id = $1 group by 1`, [shift.id]);
    results.workerRestart = {
      invitations: N, byPhase: ['before', 'during-restart', 'worker-stopped'].map((p) => ({ phase: p, created: created.filter((c) => c.phase === p).length, emailQueued: created.filter((c) => c.phase === p && c.emailQueued).length })),
      restartTotalMs, workerBackMs, stoppedForMs, workerStartMs, queuedWhileStopped, drainMs,
      emailsLogged: all.length, perRecipientMax: Math.max(...Object.values(perRecipient)),
      outboxStatuses: outbox.reduce((a: Record<string, number>, r: any) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}),
      outboxGenerations: outbox.reduce((a: Record<string, number>, r: any) => ({ ...a, [String(r.dispatch_generation)]: (a[String(r.dispatch_generation)] ?? 0) + 1 }), {}),
      bulkOffers: bulk.status, bulkAgain: bulkAgain.status, bulkSample: bulk.body?.results?.slice?.(0, 1), bulkAgainSample: bulkAgain.body?.results?.slice?.(0, 1),
      offerRows: offers.length, offerMaxPerStaff: offers.reduce((mx: number, r: any) => Math.max(mx, r.n), 0),
    };
    // Exactly once for every queued invitation; never an email for one the API reported as not queued.
    for (const c of created) expect(perRecipient[c.email], c.email).toBe(c.emailQueued ? 1 : 0);
    for (const c of created) expect(c.invitationStatus === 'queued').toBe(c.emailQueued);
    expect(outbox.every((r: any) => String(r.status).toUpperCase() === 'SENT')).toBe(true);
    expect(bulk.status).toBe(201);
    expect(offers.length).toBe(activatable.length);
    expect(offers.every((r: any) => r.n === 1)).toBe(true);
  });

  test('5.2 Redis down briefly: the API fails closed where designed, recovers, and no data is corrupted', async () => {
    const s = loadState();
    const m = await managerFor('A');
    const anon = new ApiClient({ label: 'anon', honour429: false });
    const venuesBefore = Number((await sql(`select count(*)::int as n from ${s.A.schema}.venue`))[0].n);
    const name = `Redis Outage Venue ${tag} ${uniq}`;
    const staffEmail = `redis.outage.${tag}.${uniq}@alpha-e2e.test`;
    stop('redis');
    const t0 = Date.now();
    const staffDuring = await m.post('/rest/v1/staff', { email: staffEmail, firstName: 'Redis', lastName: 'Outage', jobRoleId: s.A.jobRoleId });
    const during = {
      healthz: (await anon.get('/healthz')).status,
      login: (await anon.post('/rest/v1/auth/login', { email: `nobody.${uniq}@e2e.test`, password: 'x-wrong-password' })).status,
      me: (await m.get('/rest/v1/auth/me')).status,
      venues: (await m.get('/rest/v1/venues')).status,
      createVenue: (await m.post('/rest/v1/venues', { name, type: 'hotel' })).status,
      createStaff: staffDuring.status,
      staffEmailQueued: staffDuring.body?.emailQueued ?? null,
    };
    const createdDuring = Number((await sql(`select count(*)::int as n from ${s.A.schema}.venue where name = $1`, [name]))[0].n);
    const workerDuring = health('worker');
    start('redis');
    await waitHealthy('redis', 60_000);
    const { ms: apiRecoveryMs } = await waitFor(async () => (await anon.post('/rest/v1/auth/login', { email: `nobody2.${uniq}@e2e.test`, password: 'x-wrong-password' })).status === 401, 120_000, 1000);
    const after = {
      venues: (await m.get('/rest/v1/venues')).status,
      createVenue: (await m.post('/rest/v1/venues', { name: `${name} after`, type: 'hotel' })).status,
    };
    await new Promise((r) => setTimeout(r, 20_000));
    const worker = containerState('crewflow-e2e-worker-1');
    const venuesAfter = Number((await sql(`select count(*)::int as n from ${s.A.schema}.venue`))[0].n);
    results.redisOutage = { downForMs: Date.now() - t0, during, createdDuring, workerDuring, apiRecoveryMs, after, workerAfter: worker, venuesBefore, venuesAfter };
    // Fail closed: nothing may half-succeed. A venue created during the outage is either fully there (2xx) or absent.
    expect(during.createVenue < 300 ? createdDuring === 1 : createdDuring === 0).toBe(true);
    expect(during.login).toBe(503);
    expect(after.venues).toBe(200);
    expect(after.createVenue).toBe(201);
    expect(venuesAfter).toBe(venuesBefore + (createdDuring ? 1 : 0) + 1);
    expect(worker.status).toBe('running');
  });

  test('5.3 database connection blip (Postgres restarted): API and worker reconnect without a human', async () => {
    const s = loadState();
    const m = await managerFor('A');
    const anon = new ApiClient({ label: 'anon' });
    const t0 = Date.now();
    const since = new Date(t0 - 1000).toISOString();
    docker(['restart', '-t', '5', 'crewflow-e2e-postgres-1']);
    const restartMs = Date.now() - t0;
    const firstAfter = await m.get('/rest/v1/venues').catch((e) => ({ status: -1, text: String(e), ms: 0 }) as any);
    const { ms: apiRecoveryMs } = await waitFor(async () => (await m.get('/rest/v1/venues')).status === 200, 120_000, 500);
    const healthz = (await anon.get('/healthz')).status;
    const created = await m.post('/rest/v1/venues', { name: `After DB blip ${tag} ${uniq}`, type: 'hotel' });
    // Give the worker's supervisor time to act (it delays a failure exit by 30 s), then look at the real container state.
    await new Promise((r) => setTimeout(r, 45_000));
    const workerState = containerState('crewflow-e2e-worker-1');
    const workerLogs = logsSinceAll('worker', since);
    const provisionerCrash = /Unhandled 'error' event/.test(workerLogs) && /provisioner exited unexpectedly/.test(workerLogs);
    // Can the stack still deliver work? An invitation sent now must arrive.
    const probeEmail = `after.blip.${tag}.${uniq}@alpha-e2e.test`;
    const probe = await m.post('/rest/v1/staff', { email: probeEmail, firstName: 'After', lastName: 'Blip', jobRoleId: s.A.jobRoleId });
    let delivered = false;
    try {
      await waitForLink(probeEmail, /activate-account\?token=/, 60_000);
      delivered = true;
    } catch {
      delivered = false;
    }
    results.dbBlip = {
      restartMs, firstRequestAfter: [firstAfter.status, Math.round(firstAfter.ms)], apiRecoveryMs, healthz, createAfter: created.status,
      workerStateAfter45s: workerState, provisionerCrash,
      crashLines: workerLogs.split('\n').filter((l) => /Unhandled 'error'|57P01|exited unexpectedly|delaying exit|exiting with code/.test(l)).slice(0, 8),
      probeInvite: { status: probe.status, emailQueued: probe.body?.emailQueued, delivered },
    };
    // Cleanup so later phases have a worker, whatever happened above (recorded, not hidden).
    if (containerState('crewflow-e2e-worker-1').status !== 'running') {
      const at = Date.now();
      start('worker');
      (results.dbBlip as any).manualWorkerStartNeeded = true;
      (results.dbBlip as any).workerRecoveryMs = await waitHealthy('worker', 240_000, at);
    }
    expect(created.status).toBe(201);
    expect(healthz).toBe(200);
    expect(workerState.status, 'worker must survive a Postgres connection blip').toBe('running');
    expect(provisionerCrash, 'provisioner must not crash on a terminated connection').toBe(false);
    expect(delivered).toBe(true);
  });
});

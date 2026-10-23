import { expect, test } from '@playwright/test';

import { managerFor } from '../lib/actors';
import { sql } from '../lib/db';
import { RUN_ID } from '../lib/env';
import { expectStatus } from '../lib/http';
import { loadState, updateState } from '../lib/state';

/**
 * Scenario 6 (setup half) — runs AFTER perf/seed.mjs: a payroll calendar period that covers the seeded approved records,
 * then a real `runs/prepare` over them (timed — it is the heaviest payroll read/write), so the load script can measure
 * the run-detail endpoint on a realistic run. Also records server-path workspace creation and migrator timings.
 */
test('6.0 payroll run over the seeded period; workspace creation / migrator timings', async () => {
  const s = loadState();
  const m = await managerFor('A');
  const p = (s.notes.perfPeriod ?? { start: '2026-10-03', endExclusive: '2026-10-17' }) as { start: string; endExclusive: string };
  const end = new Date(Date.parse(`${p.endExclusive}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const periods = [
    { start: p.start, end, payday: new Date(Date.parse(`${end}T00:00:00Z`) + 10 * 86400_000).toISOString().slice(0, 10), needsConfirmation: false },
    { start: '2026-10-17', end: '2026-10-30', payday: '2026-11-09', needsConfirmation: false },
    { start: '2026-10-31', end: '2026-11-13', payday: '2026-11-23', needsConfirmation: false },
  ];
  const imp = await m.post('/rest/v1/payroll/calendar/import', { year: 2026, source: `W6 e2e perf calendar ${RUN_ID}`, periods });
  const list = expectStatus(await m.get('/rest/v1/payroll/runs'), 200, 'runs').body;
  const period = list.periods.find((x: any) => x.period.start === p.start);
  expect(period, `period ${p.start} present (import ${imp.status} ${imp.text.slice(0, 200)})`).toBeTruthy();
  const approved = (await sql(`select count(*)::int n from ${s.A.schema}.payroll_record where status = 'approved'`))[0].n;
  const t0 = performance.now();
  const prepared = expectStatus(await m.post('/rest/v1/payroll/runs/prepare', { periodId: period.period.id }), 200, 'prepare').body;
  const prepareMs = performance.now() - t0;
  const reg = await sql(`select w.subdomain, round(extract(epoch from max(m.completed_at) - min(m.started_at)) * 1000)::int as migrator_ms, count(*)::int as modules
    from core.workspace_schema_migration m join core.manager_workspace w on w.id = m.workspace_id group by 1 order by 1`);
  updateState((st) => {
    st.notes.perfRunId = prepared.id;
    st.notes.perfPrepare = { importStatus: imp.status, approvedRecords: approved, prepareMs: Math.round(prepareMs), totals: prepared.totals };
    st.notes.migratorTimings = reg;
  });
  expect(prepared.totals.records).toBeGreaterThan(100);
});

/**
 * Workspace creation duration on a loaded database (after the volume seed): a third organisation's Initial Manager creates
 * a workspace through the API; server-path provisioning answers READY inside the POST. Timed end to end.
 */
test('6.1 workspace creation duration with the seeded volume present', async () => {
  const s = loadState();
  const { ApiClient } = await import('../lib/http');
  const { tokenFrom, waitForLink } = await import('../lib/mail');
  const { ADMIN_EMAIL, SYNTHETIC_PASSWORD } = await import('../lib/env');
  const tag = `${RUN_ID.toLowerCase()}${Date.now().toString(36).slice(-4)}`;
  const admin = new ApiClient({ label: 'admin' });
  expectStatus(await admin.login(ADMIN_EMAIL, SYNTHETIC_PASSWORD), 200, 'admin login');
  const ceoEmail = `ceo.c.${tag}@charlie-e2e.test`;
  const imEmail = `im.c.${tag}@charlie-e2e.test`;
  // Owner correction 2026-10-23: email-only CEO invitation; the CEO names the organisation when accepting.
  expectStatus(await admin.post('/rest/v1/admin/organisation-invitations', { email: ceoEmail }), 200, 'invite CEO C');
  const ceo = new ApiClient({ label: 'ceoC' });
  expectStatus(await ceo.post('/rest/v1/invitations/accept', { token: tokenFrom((await waitForLink(ceoEmail, /accept-invitation\?token=/)).link), firstName: 'Cy', lastName: 'Charlie', organisationName: `Charlie Events ${tag}`, newPassword: SYNTHETIC_PASSWORD }), 200, 'ceo C accepts');
  expectStatus(await ceo.login(ceoEmail, SYNTHETIC_PASSWORD), 200, 'ceo C login');
  expectStatus(await ceo.post('/rest/v1/managers/initial-manager-invite', { email: imEmail, firstName: 'Iz', lastName: 'Charlie' }), [200, 201], 'IM C invite');
  const im = new ApiClient({ label: 'imC' });
  expectStatus(await im.post('/rest/v1/auth/activate-account', { token: tokenFrom((await waitForLink(imEmail, /activate-account\?token=/)).link), newPassword: SYNTHETIC_PASSWORD }), 200, 'IM C activation');
  expectStatus(await im.login(imEmail, SYNTHETIC_PASSWORD), 200, 'IM C login');
  const label = `charlie-${tag}`.slice(0, 40);
  const t0 = performance.now();
  const created = expectStatus(await im.post('/rest/v1/manager-workspaces', { name: `Charlie Ops ${tag}`, subdomain: label }), [200, 201], 'create workspace C');
  const createMs = performance.now() - t0;
  const reg = await sql(`select r.schema_name, w.schema_status, round(extract(epoch from max(m.completed_at) - min(m.started_at)) * 1000)::int as migrator_ms
    from core.manager_workspace w join core.workspace_schema_registry r on r.workspace_id = w.id join core.workspace_schema_migration m on m.workspace_id = w.id
    where w.subdomain = $1 group by 1, 2`, [label]);
  updateState((st) => {
    st.notes.workspaceCreateLoaded = { httpStatus: created.status, schemaStatus: created.body.schemaStatus, createMs: Math.round(createMs), serverMs: Math.round(created.ms), registry: reg[0] };
  });
  expect(created.body.schemaStatus).toBe('READY');
});

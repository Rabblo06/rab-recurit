/**
 * AI Phase 1 end-to-end fixture seed (synthetic data only, disposable test database only).
 *
 * Run by `run-ai-e2e.sh` with ts-node against crewflow-test-db (127.0.0.1:15436). The test-database guard
 * (`applyIntegrationTestDatabaseEnv`) refuses anything but the explicit TEST_DATABASE_URL pair on a loopback host.
 *
 * Seeds:
 *  - Organisation A (AI switch OFF — the platform admin turns it on through the Admin Panel in the browser):
 *      CEO (production permissions, own workspace), venue "Riverside Hall", two job roles, three shifts on the coming
 *      weekend days (two need staff, one is full), assignments/offers, one late clock-in, two payroll runs.
 *      Current Initial Manager whose `payroll.view` is revoked (user permission override) — eligible for AI, but the
 *      payroll tool must not be offered to them.
 *  - Organisation B: CEO, venue "Harbour Lights B-ONLY" with an unfilled weekend shift for the role "Org-B Secret
 *    Sommelier" — text that must never appear in A's answers.
 *  - An admin organisation whose CEO is a platform administrator.
 *
 * Writes the identities (emails + generated passwords) to E2E_IDENTITIES_OUT (scratchpad, never the repository).
 */
import 'reflect-metadata';

process.env.EMAIL_DRIVER = 'LOGGER';
process.env.AI_ENABLED = 'true';
process.env.AI_PROVIDER = 'mock';
process.env.AI_MODEL = 'crewflow-mock-1';

import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { applyIntegrationTestDatabaseEnv } from '../../rab-server/src/database/typeorm/core/test-database-guard';

applyIntegrationTestDatabaseEnv(process.env);

const H = 3600 * 1000;

/** The coming weekend's days (UTC/London calendar), as the deterministic test model computes "this weekend". */
function weekendDays(now = new Date()): { saturday: string; sunday: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date(`${day(now)}T00:00:00Z`);
  const dow = today.getUTCDay();
  const saturday = new Date(today.getTime() + (dow === 0 ? -1 : (6 - dow + 7) % 7) * 86_400_000);
  return { saturday: day(saturday), sunday: day(new Date(saturday.getTime() + 86_400_000)) };
}

/** A start time on the weekend that is still in the future when possible (today's later hours on a Sunday). */
function weekendStart(hourUtc: number): Date {
  const { saturday, sunday } = weekendDays();
  const sun = new Date(`${sunday}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
  if (sun.getTime() > Date.now() + H) return sun;
  return new Date(`${saturday}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
}

async function main(): Promise<void> {
  const out = process.env.E2E_IDENTITIES_OUT;
  if (!out) throw new Error('E2E_IDENTITIES_OUT is required');
  // Imported after the env is routed so AppModule's ConfigModule validates the disposable-database settings.
  const { AppModule } = await import('../../rab-server/src/app.module');
  const { PasswordHashingService } = await import('../../rab-server/src/engine/core-modules/auth/services/password-hashing.service');
  const { TenantContextService } = await import('../../rab-server/src/engine/core-modules/tenant/tenant-context.service');
  const { createAdminDataSource } = await import('../../rab-server/src/__tests__/integration/helpers/admin-datasource');
  const { TestIdentityFactory } = await import('../../rab-server/src/__tests__/integration/helpers/test-identities');
  type Identity = Awaited<ReturnType<InstanceType<typeof TestIdentityFactory>['createCeo']>>;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  const owner = createAdminDataSource();
  await owner.initialize();
  const marker = await owner.query(`SELECT current_setting('crewflow.disposable_test_database', true) AS v, current_database() AS db, inet_server_port() AS port`);
  if (marker[0]?.v !== 'true') throw new Error(`refusing to seed: database ${marker[0]?.db}:${marker[0]?.port} is not marked crewflow.disposable_test_database=true`);
  const factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
  const q = (sql: string, params: unknown[] = []) => owner.query(sql, params);
  const run = randomUUID().slice(0, 6);

  async function organisation(label: string, name: string) {
    const org = await factory.createOrganisation(label);
    await q(`UPDATE core.organisation SET name = $2 WHERE id = $1`, [org.id, name]);
    return org;
  }
  async function rename(who: Identity, first: string, last: string) {
    await q(`UPDATE core."user" SET first_name = $2, last_name = $3 WHERE id = $1`, [who.userId, first, last]);
  }

  async function staffing(ownerId: Identity, opts: { venue: string; roles: string[]; shifts: Array<{ role: number; hour: number; required: number; confirmed: number; status: string }> }) {
    const org = ownerId.organisationId;
    const ws = ownerId.workspaceId!;
    const staff: Identity[] = [];
    for (let i = 0; i < 4; i++) staff.push(await factory.createStaff({ id: org }, { owner: ownerId, label: `e2estaff${i}` }) as Identity);
    const [venue] = await q(`INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`, [org, opts.venue, ownerId.userId, ws]);
    const roles: string[] = [];
    for (const name of opts.roles) {
      const [r] = await q(`INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, $2, 1500, $3, $4) RETURNING id`, [org, name, ownerId.userId, ws]);
      roles.push(r.id);
    }
    const shifts: string[] = [];
    let s = 0;
    for (const def of opts.shifts) {
      const start = weekendStart(def.hour);
      const [row] = await q(
        `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 1500, $8, $9, $10) RETURNING id`,
        [org, venue.id, roles[def.role], start, new Date(start.getTime() + 6 * H), def.required, def.confirmed, def.status, ownerId.userId, ws],
      );
      shifts.push(row.id);
      for (let c = 0; c < def.confirmed; c++) {
        await q(
          `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
           VALUES ($1, $2, $3, 'confirmed', 1500, $4, now(), tstzrange($5, $6), $7)`,
          [org, row.id, staff[s++ % staff.length]!.profileId, ownerId.userId, start, new Date(start.getTime() + 6 * H), ws],
        );
      }
    }
    return { staff, venueId: venue.id, roles, shifts };
  }

  // ---- Organisation A
  const orgA = await organisation(`ai-e2e-a-${run}`, `Org A Hospitality (synthetic ${run})`);
  const ceoA = (await factory.createCeo(orgA, { permissions: 'production' })) as Identity;
  await rename(ceoA, 'Avery', 'Chen');
  const a = await staffing(ceoA, {
    venue: 'Riverside Hall',
    roles: ['Bartender', 'Waiter'],
    shifts: [
      { role: 0, hour: 17, required: 3, confirmed: 1, status: 'partially_filled' },
      { role: 1, hour: 18, required: 2, confirmed: 0, status: 'open' },
      { role: 1, hour: 16, required: 1, confirmed: 1, status: 'fully_filled' },
    ],
  });
  // Two past completed shifts with attendance (one late clock-in: +25 min) for the attendance and payroll tools.
  async function pastWork(hoursAgo: number, lateMinutes: number, staffIndex: number) {
    const start = new Date(Date.now() - hoursAgo * H);
    const [shift] = await q(
      `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
       VALUES ($1, $2, $3, $4, $5, 0, 1, 1, 1500, 'completed', $6, $7) RETURNING id`,
      [orgA.id, a.venueId, a.roles[0], start, new Date(start.getTime() + 8 * H), ceoA.userId, ceoA.workspaceId],
    );
    const [assignment] = await q(
      `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
       VALUES ($1, $2, $3, 'completed', 1500, $4, now(), tstzrange($5, $6), $7) RETURNING id`,
      [orgA.id, shift.id, a.staff[staffIndex]!.profileId, ceoA.userId, start, new Date(start.getTime() + 8 * H), ceoA.workspaceId],
    );
    const [attendance] = await q(
      `INSERT INTO core.attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', 480, 12000) RETURNING id`,
      [orgA.id, assignment.id, shift.id, a.staff[staffIndex]!.profileId, ceoA.workspaceId, new Date(start.getTime() + lateMinutes * 60_000), new Date(start.getTime() + 8 * H)],
    );
    return { shiftId: shift.id as string, attendanceId: attendance.id as string, staffId: a.staff[staffIndex]!.profileId! };
  }
  const work1 = await pastWork(30, 25, 3);
  const work2 = await pastWork(54, 2, 2);
  const [offerAssignment] = await q(
    `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period, workspace_id)
     VALUES ($1, $2, $3, 'offered', 1500, $4, tstzrange($5, $6), $7) RETURNING id`,
    [orgA.id, a.shifts[0], a.staff[2]!.profileId, ceoA.userId, weekendStart(17), new Date(weekendStart(17).getTime() + 6 * H), ceoA.workspaceId],
  );
  await q(
    `INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
     VALUES ($1, $2, $3, 'pending', now(), now() + interval '1 day', 9000, $4, $5)`,
    [orgA.id, offerAssignment.id, a.staff[2]!.profileId, ceoA.userId, ceoA.workspaceId],
  );
  // Two payroll runs: older £120.00, newer £150.00 (aggregate comparison only).
  const [cal] = await q(`INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES ($1, 2026, 1, 'ai-e2e', $2) RETURNING id`, [orgA.id, ceoA.userId]);
  const [p1] = await q(`INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, '2026-09-01', '2026-09-14', '2026-09-18') RETURNING id`, [orgA.id, cal.id]);
  const [p2] = await q(`INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, '2026-09-15', '2026-09-28', '2026-10-02') RETURNING id`, [orgA.id, cal.id]);
  const record = async (w: { shiftId: string; attendanceId: string; staffId: string }, amount: number) => {
    const [row] = await q(
      `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, 'approved', 480, 1500, $6, now(), $7) RETURNING id`,
      [orgA.id, ceoA.workspaceId, w.attendanceId, w.shiftId, w.staffId, amount, ceoA.userId],
    );
    return row.id as string;
  };
  const [olderRun] = await q(`INSERT INTO core.payroll_run (organisation_id, workspace_id, period_id, prepared_by) VALUES ($1, $2, $3, $4) RETURNING id`, [orgA.id, ceoA.workspaceId, p1.id, ceoA.userId]);
  const [newerRun] = await q(`INSERT INTO core.payroll_run (organisation_id, workspace_id, period_id, prepared_by) VALUES ($1, $2, $3, $4) RETURNING id`, [orgA.id, ceoA.workspaceId, p2.id, ceoA.userId]);
  const line = (runId: string, recordId: string, staffId: string, amount: number, day: string) =>
    q(
      `INSERT INTO core.payroll_run_line (organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, worked_minutes, pay_rate_pence, amount_pence)
       VALUES ($1, $2, $3, $4, $5, $6, 480, 1500, $7)`,
      [orgA.id, ceoA.workspaceId, runId, recordId, staffId, day, amount],
    );
  await line(olderRun.id, await record(work2, 12000), work2.staffId, 12000, '2026-09-05');
  await line(newerRun.id, await record(work1, 15000), work1.staffId, 15000, '2026-09-20');

  // The current Initial Manager of A, WITHOUT payroll.view (a per-user revoke override, the product's own mechanism).
  const imA = (await factory.createInternalManager({ id: orgA.id }, { permissions: 'production' })) as Identity;
  await rename(imA, 'Jordan', 'Ellis');
  await q(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [imA.userId]);
  await q(
    `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'payroll.view'`,
    [imA.userId, orgA.id],
  );

  // ---- Organisation B (AI on; its data must never reach A)
  const orgB = await organisation(`ai-e2e-b-${run}`, `Org B Catering (synthetic ${run})`);
  const ceoB = (await factory.createCeo(orgB, { permissions: 'production' })) as Identity;
  await staffing(ceoB, { venue: 'Harbour Lights B-ONLY', roles: ['Org-B Secret Sommelier'], shifts: [{ role: 0, hour: 17, required: 4, confirmed: 0, status: 'open' }] });
  await q(`INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true) ON CONFLICT (organisation_id) DO UPDATE SET enabled = true`, [orgB.id]);

  // ---- Platform administrator (own organisation)
  const adminOrg = await organisation(`ai-e2e-admin-${run}`, `Crewflow Platform (synthetic ${run})`);
  const admin = (await factory.createCeo(adminOrg, { permissions: 'production', platformAdmin: true })) as Identity;
  await rename(admin, 'Pat', 'Admin');

  // Every manager here finished workspace onboarding (otherwise the console redirects to /onboarding/profile).
  await q(`UPDATE core.manager_workspace SET onboarding_completed_at = now() WHERE organisation_id = ANY($1::uuid[]) AND onboarding_completed_at IS NULL`, [[orgA.id, orgB.id, adminOrg.id]]);

  const pick = (who: Identity) => ({ email: who.email, password: who.password, userId: who.userId, organisationId: who.organisationId, workspaceId: who.workspaceId });
  writeFileSync(
    out,
    JSON.stringify(
      {
        run,
        weekend: weekendDays(),
        orgA: { id: orgA.id, name: `Org A Hospitality (synthetic ${run})`, slug: orgA.slug },
        orgB: { id: orgB.id, name: `Org B Catering (synthetic ${run})` },
        ceoA: pick(ceoA),
        imA: pick(imA),
        ceoB: pick(ceoB),
        admin: pick(admin),
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`[ai-e2e-seed] run=${run} orgA=${orgA.id} orgB=${orgB.id} weekend=${JSON.stringify(weekendDays())}`);
  await owner.destroy();
  await app.close();
}

main().then(
  () => process.exit(0),
  (error) => {
    // eslint-disable-next-line no-console
    console.error('[ai-e2e-seed] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

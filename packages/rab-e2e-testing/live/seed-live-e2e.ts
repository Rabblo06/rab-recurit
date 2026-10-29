/**
 * Live-backend web E2E fixture seed (synthetic data only, disposable test database only).
 *
 * Run by `run-live.sh` with ts-node from source, NODE_ENV=test, against a database built by the restricted-migrator harness
 * (CI: the M2 harness fresh install on the disposable-postgres action; locally: crewflow-test-db 127.0.0.1:15436). The
 * test-database guard (`applyIntegrationTestDatabaseEnv`) refuses anything but the explicit TEST_DATABASE_URL pair on a
 * loopback host, and this seed additionally refuses a database not marked `crewflow.disposable_test_database=true`.
 *
 * Every identity is created by the integration suites' own `TestIdentityFactory` (production role definitions, real
 * workspaces, one random password per run — never a repository constant). Scheduling rows follow the shapes
 * `ai/seed-ai-e2e.ts` already uses. What each live spec needs:
 *
 *  - Console organisation (smoke, qa_shift_workflow, table-toolbar-*, performance-baseline): a CEO whose email is the specs'
 *    default (`admin@acme.test`), two active venues (one restaurant), a job role, active / suspended staff with phone
 *    numbers and employment types, draft shifts, a Venue Manager's pending shift request with requested staff, open shifts
 *    with pending and withdrawn offers, completed past work with approved attendance and payroll records, and `user.created`
 *    audit entries written by the real POST /staff path.
 *  - Two independent manager organisations for session-race / cookie-race / performance-baseline (`manager.a.e2e@…`,
 *    `manager.c.e2e@…`, the specs' default addresses).
 *  - QA_UI (ui-corrections-live): an owner Internal Manager, two Venue Managers (one active, one invite-expired) and three Staff.
 *  - QA_IDENTITIES (devices-sessions-live): two managers in two organisations.
 *
 * Outputs (E2E_LIVE_OUT, a scratch directory — never the repository):
 *   live.env           E2E_SEED_PASSWORD / E2E_MANAGER_PASSWORD (+ emails) for `source` by the runner
 *   qa-ui.json         QA_UI
 *   qa-identities.json QA_IDENTITIES
 */
import 'reflect-metadata';

process.env.EMAIL_DRIVER = 'LOGGER';

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { applyIntegrationTestDatabaseEnv, assertSameDatabaseAtRuntime } from '../../rab-server/src/database/typeorm/core/test-database-guard';

const H = 3600 * 1000;
const DAY = 24 * H;

/** The spec defaults (session-race, cookie-race, smoke, table-toolbar-*, qa_shift_workflow, performance-baseline). */
const CONSOLE_ADMIN_EMAIL = process.env.E2E_SEED_EMAIL ?? 'admin@acme.test';
const MANAGER_A_EMAIL = process.env.E2E_MANAGER_A_EMAIL ?? 'manager.a.e2e@example.test';
const MANAGER_C_EMAIL = process.env.E2E_MANAGER_C_EMAIL ?? 'manager.c.e2e@example.test';

async function main(): Promise<void> {
  const out = process.env.E2E_LIVE_OUT;
  if (!out) throw new Error('E2E_LIVE_OUT is required');
  mkdirSync(out, { recursive: true });

  // Refuse BEFORE the application module is compiled or initialised (its lifecycle hooks already reach the database):
  // NODE_ENV=test and the validated loopback TEST_DATABASE_URL pair are required (null = not a test run), and both
  // connections must reach the same database, marked disposable in the CATALOG (pg_db_role_setting via ALTER DATABASE),
  // which a connection string's `options=-c ...` cannot fake.
  const resolved = applyIntegrationTestDatabaseEnv(process.env);
  if (!resolved) throw new Error('refusing to seed: NODE_ENV must be "test" with the TEST_DATABASE_URL / TEST_DATABASE_URL_UNPOOLED pair');
  await assertSameDatabaseAtRuntime(resolved);

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
  const existing = await owner.query(`SELECT count(*)::int AS n FROM core."user" WHERE lower(email) = ANY($1::text[])`, [
    [CONSOLE_ADMIN_EMAIL, MANAGER_A_EMAIL, MANAGER_C_EMAIL].map((e) => e.toLowerCase()),
  ]);
  if (existing[0].n > 0) throw new Error('refusing to seed: the live E2E identities already exist in this database (seed a fresh harness database)');

  const factory = new TestIdentityFactory({
    app,
    dataSource: moduleRef.get(DataSource),
    adminDataSource: owner,
    tenantContext: moduleRef.get(TenantContextService),
    passwordHashing: moduleRef.get(PasswordHashingService),
  });
  const q = (sql: string, params: unknown[] = []) => owner.query(sql, params);
  const orgIds: string[] = [];

  async function organisation(label: string, name: string) {
    const org = await factory.createOrganisation(label);
    await q(`UPDATE core.organisation SET name = $2 WHERE id = $1`, [org.id, name]);
    orgIds.push(org.id);
    return org;
  }
  async function profile(who: Identity, first: string, last: string, email?: string) {
    await q(`UPDATE core."user" SET first_name = $2, last_name = $3, email = COALESCE($4, email) WHERE id = $1`, [who.userId, first, last, email ?? null]);
    if (email) who.email = email;
  }

  // ---------------------------------------------------------------- console organisation
  const consoleOrg = await organisation('e2e-live-console', 'Acme Staffing (synthetic e2e)');
  const admin = (await factory.createCeo(consoleOrg, { permissions: 'production' })) as Identity;
  await profile(admin, 'Alex', 'Morgan', CONSOLE_ADMIN_EMAIL);
  const ws = admin.workspaceId!;
  const org = consoleOrg.id;

  const venue = async (name: string, type: string, client: string) =>
    (await q(`INSERT INTO core.venue (organisation_id, name, client_name, type, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [org, name, client, type, admin.userId, ws]))[0].id as string;
  const riverside = await venue('Riverside Kitchen', 'restaurant', 'Riverside Group (synthetic)');
  const harbour = await venue('Harbour Warehouse', 'warehouse', 'Harbour Logistics (synthetic)');
  const [role] = await q(`INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, 'Bartender', 1500, $2, $3) RETURNING id`, [org, admin.userId, ws]);

  // Active staff (factory: real staff role, profile, workspace membership), distinct created_at for the sort checks.
  const staffSpec: Array<[string, string, string, string, string]> = [
    ['Ava', 'Fletcher', 'Full-time', 'active', '+44 7700 900101'],
    ['Ben', 'Hall', 'Full-time', 'active', '+44 7700 900102'],
    ['Cara', 'Ingram', 'Part-time', 'active', '+44 7700 900103'],
    ['Dev', 'Joshi', 'Casual', 'suspended', '+44 7700 900104'],
  ];
  const staff: Identity[] = [];
  for (const [i, [first, last, type, status, phone]] of staffSpec.entries()) {
    const s = (await factory.createStaff(consoleOrg, { owner: admin, label: `e2e-live-staff${i}` })) as Identity;
    await profile(s, first, last);
    await q(`UPDATE core."user" SET phone = $2 WHERE id = $1`, [s.userId, phone]);
    await q(
      `UPDATE core.staff_profile SET employment_type = $2, employment_status = $3, job_role_id = $4, created_at = now() - make_interval(days => $5) WHERE id = $1`,
      [s.profileId, type, status, role.id, 10 - i],
    );
    staff.push(s);
  }

  // Two more staff through the real POST /staff (writes the `user.created` audit entries the Audit Log filter needs).
  const token = await factory.login(admin, { applicationTarget: 'manager_web' });
  for (const [first, last] of [['Eli', 'Kemp'], ['Fay', 'Lowe']]) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `${first.toLowerCase()}.${last.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`, firstName: first, lastName: last, phone: '+44 7700 900199', employmentType: 'Full-time', jobRoleId: role.id });
    if (res.status !== 201) throw new Error(`POST /staff returned ${res.status} ${JSON.stringify(res.body?.code ?? res.body?.message ?? '')}`);
  }

  const shift = async (venueId: string, startsAt: Date, hours: number, status: string, createdBy: string, required = 2, filled = 0) =>
    (
      await q(
        `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 1500, $8, $9, $10) RETURNING id`,
        [org, venueId, role.id, startsAt, new Date(startsAt.getTime() + hours * H), required, filled, status, createdBy, ws],
      )
    )[0].id as string;
  const future = (days: number, hourUtc: number) => {
    const d = new Date(Date.now() + days * DAY);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d;
  };

  // Drafts (Shifts status filter).
  await shift(riverside, future(5, 9), 6, 'draft', admin.userId);
  await shift(harbour, future(6, 10), 8, 'draft', admin.userId);

  // A Venue Manager's shift request awaiting this manager's approval, with two requested (active, available) staff.
  const vm = (await factory.createVenueManager(consoleOrg, { owner: admin, venueIds: [riverside] })) as Identity;
  await profile(vm, 'Vera', 'Mills');
  const requestedStart = future(8, 17);
  const requested = await shift(riverside, requestedStart, 6, 'pending_manager_approval', vm.userId, 2, 0);
  for (const s of staff.slice(0, 2)) {
    await q(`INSERT INTO core.shift_request_staff (organisation_id, workspace_id, shift_id, staff_profile_id) VALUES ($1, $2, $3, $4)`, [org, ws, requested, s.profileId]);
  }

  // Open shift with offers: one pending, one withdrawn (Offers tabs and sort).
  const openStart = future(9, 18);
  const open = await shift(harbour, openStart, 6, 'offered', admin.userId, 2, 0);
  for (const [s, offerStatus, assignmentStatus] of [
    [staff[0]!, 'pending', 'offered'],
    [staff[2]!, 'withdrawn', 'withdrawn'],
  ] as const) {
    const [assignment] = await q(
      `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period, workspace_id)
       VALUES ($1, $2, $3, $4, 1500, $5, tstzrange($6, $7), $8) RETURNING id`,
      [org, open, s.profileId, assignmentStatus, admin.userId, openStart, new Date(openStart.getTime() + 6 * H), ws],
    );
    await q(
      `INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
       VALUES ($1, $2, $3, $4, now(), now() + interval '1 day', 9000, $5, $6)`,
      [org, assignment.id, s.profileId, offerStatus, admin.userId, ws],
    );
  }

  // Completed past work with approved attendance and payroll records, inside the current calendar month (Payroll page).
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const pastStart = (hoursAgo: number) => new Date(Math.max(Date.now() - hoursAgo * H, monthStart.getTime() + 60_000));
  for (const [i, [hoursAgo, venueId, amount]] of ([
    [10, riverside, 9000],
    [9, harbour, 12000],
  ] as const).entries()) {
    const start = pastStart(hoursAgo);
    const end = new Date(Math.min(start.getTime() + 6 * H, Date.now() - 60_000));
    const s = staff[i]!;
    const shiftId = await shift(venueId, start, (end.getTime() - start.getTime()) / H, 'completed', admin.userId, 1, 1);
    const [assignment] = await q(
      `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
       VALUES ($1, $2, $3, 'completed', 1500, $4, now(), tstzrange($5, $6), $7) RETURNING id`,
      [org, shiftId, s.profileId, admin.userId, start, end, ws],
    );
    const worked = Math.round((end.getTime() - start.getTime()) / 60_000);
    const [attendance] = await q(
      `INSERT INTO core.attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9) RETURNING id`,
      [org, assignment.id, shiftId, s.profileId, ws, start, end, worked, amount],
    );
    await q(
      `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1500, $8, $9, $10)`,
      [org, ws, attendance.id, shiftId, s.profileId, i === 0 ? 'approved' : 'pending_approval', worked, amount, i === 0 ? new Date() : null, i === 0 ? admin.userId : null],
    );
  }

  // ---------------------------------------------------------------- session-race / cookie-race managers
  const orgA = await organisation('e2e-live-manager-a', 'Manager A Org (synthetic e2e)');
  const managerA = (await factory.createCeo(orgA, { permissions: 'production' })) as Identity;
  await profile(managerA, 'Manager', 'Alpha', MANAGER_A_EMAIL);
  const orgC = await organisation('e2e-live-manager-c', 'Manager C Org (synthetic e2e)');
  const managerC = (await factory.createCeo(orgC, { permissions: 'production' })) as Identity;
  await profile(managerC, 'Manager', 'Charlie', MANAGER_C_EMAIL);

  // ---------------------------------------------------------------- QA_UI (ui-corrections-live)
  const uiOrg = await organisation('e2e-live-qa-ui', 'QA UI Org (synthetic e2e)');
  // An Internal Manager (not a CEO): the dashboard shows a Manager the "Venue managers" count of their own workspace, a CEO
  // the organisation's "Managers" (features/dashboard/Dashboard.tsx), and the spec asserts the former.
  const uiOwner = (await factory.createInternalManager(uiOrg, { permissions: 'production' })) as Identity;
  await profile(uiOwner, 'Quinn', 'Owner');
  const vmActive = (await factory.createVenueManager(uiOrg, { owner: uiOwner, label: 'e2e-live-vm-active' })) as Identity;
  await profile(vmActive, 'Val', 'Active');
  const vmExpired = (await factory.createVenueManager(uiOrg, { owner: uiOwner, label: 'e2e-live-vm-expired' })) as Identity;
  await profile(vmExpired, 'Vic', 'Expired');
  // Invited, never accepted, invitation expired: the account never set a password.
  await q(`UPDATE core."user" SET status = 'invite_expired', password_hash = NULL WHERE id = $1`, [vmExpired.userId]);
  const uiStaff: Identity[] = [];
  for (let i = 0; i < 3; i++) {
    const s = (await factory.createStaff(uiOrg, { owner: uiOwner, label: `e2e-live-ui-staff${i}` })) as Identity;
    await q(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [s.profileId]);
    uiStaff.push(s);
  }

  // ---------------------------------------------------------------- QA_IDENTITIES (devices-sessions-live)
  const qaA = (await factory.createCeo(await organisation('e2e-live-qa-a', 'QA Devices A (synthetic e2e)'), { permissions: 'production' })) as Identity;
  const qaB = (await factory.createCeo(await organisation('e2e-live-qa-b', 'QA Devices B (synthetic e2e)'), { permissions: 'production' })) as Identity;

  // Every manager here finished workspace onboarding (otherwise the console redirects to /onboarding).
  await q(`UPDATE core.manager_workspace SET onboarding_completed_at = now() WHERE organisation_id = ANY($1::uuid[]) AND onboarding_completed_at IS NULL`, [orgIds]);

  const password = admin.password; // one random password per factory run, shared by every identity above
  const sh = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  writeFileSync(
    path.join(out, 'live.env'),
    [
      `export E2E_SEED_EMAIL=${sh(admin.email)}`,
      `export E2E_SEED_PASSWORD=${sh(password)}`,
      `export E2E_MANAGER_A_EMAIL=${sh(managerA.email)}`,
      `export E2E_MANAGER_C_EMAIL=${sh(managerC.email)}`,
      `export E2E_MANAGER_PASSWORD=${sh(password)}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(out, 'qa-ui.json'),
    JSON.stringify({ manager: { email: uiOwner.email, password }, venueManagers: [vmActive.email, vmExpired.email], staff: uiStaff.map((s) => s.email) }, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(path.join(out, 'qa-identities.json'), JSON.stringify({ a: { email: qaA.email, password }, b: { email: qaB.email, password } }, null, 2), { mode: 0o600 });
  // eslint-disable-next-line no-console
  console.log(`[e2e-live-seed] organisations=${orgIds.length} console=${org} (identities written to E2E_LIVE_OUT; no password printed)`);
  await owner.destroy();
  await app.close();
}

main().then(
  () => process.exit(0),
  (error) => {
    // eslint-disable-next-line no-console
    console.error('[e2e-live-seed] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

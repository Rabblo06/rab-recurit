import { ManagerType, UserStatus } from '@rab/shared';
import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource, EntityManager } from 'typeorm';

import { isRemoteDatabaseHost } from '../database/deployment-identity/deployment-identity';
import { readPrimaryDatabaseUrl } from '../database/postgres/pg-config';
import { describeDatabaseUrl } from '../database/typeorm/core/test-database-guard';
import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../engine/core-modules/auth/services/account-lifecycle.service';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { loadSystemRoleDefaultPermissions } from '../modules/identity/services/system-role-permissions';
import { ROLE_DEFS } from '../modules/manager/services/manager.service';
import { STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS } from '../modules/staff/services/staff.service';

export const AI_DEMO_ORGANISATION_NAME = 'AI Demo (synthetic)';
export const AI_DEMO_SLUG = 'ai-demo-synthetic';
export const AI_DEMO_DEFAULT_CEO_EMAIL = 'ceo.ai-demo@example.test';
const SYNTHETIC_EMAIL = /^[a-z0-9._%+-]+@example\.test$/;
const MARKER_FN = 'core.ai_dev_mark_organisation_synthetic(uuid)';

interface SeedAiDemoOptions {
  adminEmail?: string;
  ceoEmail?: string;
}

/**
 * The target rules, pure (exported for its unit test). The command runs ONLY against the development database:
 *   - NODE_ENV=development and RAB_RUNTIME_ENV=development (the same declaration the dev API/Worker carry);
 *   - DB_TARGET=local (the command bootstrap already resolved and probed it; `test`, `staging`, `production` refused);
 *   - PG_DATABASE_URL (or the deprecated DATABASE_URL) on a loopback host or a listed compose database service
 *     (deployment-identity.ts LOCAL_DATABASE_SERVICE_HOSTS).
 * The live checks follow in `run()`: the database must NOT carry the disposable-test marker, and the connection must be
 * the operator identity allowed to run the synthetic-marker function. Messages never contain a URL or credential.
 */
export function seedAiDemoTargetProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV !== 'development') problems.push(`NODE_ENV must be development (got ${env.NODE_ENV ?? 'unset'}).`);
  if (env.RAB_RUNTIME_ENV !== 'development') problems.push(`RAB_RUNTIME_ENV must be development (got ${env.RAB_RUNTIME_ENV ?? 'unset'}).`);
  if (env.DB_TARGET !== 'local') problems.push(`DB_TARGET must be local (got ${env.DB_TARGET ?? 'unset'}); test, staging and production databases are refused.`);
  // Phase B: the process's primary URL (PG_DATABASE_URL; the deprecated DATABASE_URL outside production).
  const primary = readPrimaryDatabaseUrl(env);
  if (!primary) {
    problems.push('PG_DATABASE_URL is required (or, outside production, the deprecated DATABASE_URL).');
  } else {
    try {
      const id = describeDatabaseUrl(primary.value, primary.name);
      // Final review F4: the one shared host rule (loopback or a listed compose database service), not its own copy.
      if (isRemoteDatabaseHost(id.host)) problems.push(`${primary.name} must be a loopback or docker-service database (got host "${id.host}").`);
    } catch {
      problems.push(`${primary.name} is not a parseable postgres URL (value not shown).`);
    }
  }
  return problems;
}

const STAFF_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['Avery', 'Testwell'], ['Blake', 'Samplefield'], ['Casey', 'Mockridge'], ['Devon', 'Fauxley'],
  ['Emery', 'Dummington'], ['Finley', 'Placeholt'], ['Gray', 'Synthby'], ['Harper', 'Fixturo'],
];
export const AI_DEMO_VENUES = ['Synthetic Grand Hall', 'Example Riverside Bar', 'Placeholder Conference Centre'] as const;
export const AI_DEMO_JOB_ROLES: ReadonlyArray<readonly [string, number]> = [['Bartender', 1300], ['Waiting staff', 1250], ['Kitchen porter', 1200]];
const H = 3_600_000;

/**
 * `seed-ai-demo` — DEVELOPMENT ONLY (docs/ai/PART_A_PLAN.md §2.3, owner decision 9). Creates ONE clearly synthetic
 * organisation, "AI Demo (synthetic)", so the real-provider gate has something it may answer about: fake names,
 * `@example.test` addresses only, generated venues, job roles, shifts, assignments, offers, attendance and payroll runs.
 * It then marks the organisation `synthetic_data` through `core.ai_dev_mark_organisation_synthetic` (the only writer of
 * that column; the database re-checks that every user of the organisation is `@example.test`).
 *
 * The CEO account goes through the NORMAL activation path: created `invited` with NO password, and the standard
 * activation email (account invite, the same mechanism as every other invitation) is queued for the Worker to deliver
 * through the configured EMAIL_DRIVER. The owner sets the password through that link. No password is generated, stored,
 * printed or accepted by this command. Synthetic staff are `invited` with no password and no invitation: they can never
 * sign in.
 *
 * Authority: `--admin-email` names an ACTIVE platform administrator; the organisation is created through
 * `core.create_organisation()`, which itself refuses anyone else (CF-13), and that administrator is the audited actor.
 * Run with DATABASE_URL set to the `crewflow` operator identity (the only role allowed to execute the marker function;
 * `crewflow_app` is refused). Everything runs in ONE transaction: any failure leaves nothing behind. Refuses to run twice
 * (the definer refuses the taken "ai-demo-synthetic" slug and the transaction rolls back). It does NOT turn the organisation's AI switch
 * on: that stays a platform-admin action (Admin Panel, reason + step-up).
 */
@Command({
  name: 'seed-ai-demo',
  description: 'DEVELOPMENT ONLY: seed the synthetic "AI Demo (synthetic)" organisation for the real-model dev run (refuses test/production databases)',
})
export class SeedAiDemoCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly audit: AuditService,
    private readonly env: EnvironmentService,
  ) {
    super();
  }

  @Option({ flags: '--admin-email <email>', description: 'An ACTIVE platform administrator who authorises the organisation (required)' })
  parseAdminEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  @Option({ flags: '--ceo-email <email>', description: `The synthetic CEO's address (must end @example.test; default ${AI_DEMO_DEFAULT_CEO_EMAIL})` })
  parseCeoEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  async run(_params: string[], options: SeedAiDemoOptions = {}): Promise<void> {
    const problems = seedAiDemoTargetProblems(process.env);
    if (problems.length > 0) throw new Error(`seed-ai-demo refused (nothing was changed):\n${problems.join('\n')}`);
    if (!options.adminEmail) throw new Error('seed-ai-demo refused: --admin-email <active platform administrator> is required. Nothing was changed.');
    const ceoEmail = options.ceoEmail ?? AI_DEMO_DEFAULT_CEO_EMAIL;
    if (!SYNTHETIC_EMAIL.test(ceoEmail)) throw new Error('seed-ai-demo refused: --ceo-email must be an @example.test address (synthetic organisation). Nothing was changed.');

    const summary = await this.dataSource.transaction(async (m) => {
      await this.assertLiveTarget(m);
      const adminUserId = await this.resolveAdmin(m, options.adminEmail!);
      return this.seed(m, adminUserId, ceoEmail);
    });

    // eslint-disable-next-line no-console
    console.log(
      [
        `seed-ai-demo: created "${AI_DEMO_ORGANISATION_NAME}" (organisation ${summary.organisationId}), marked synthetic_data.`,
        `  workspace ${summary.workspaceId} (schema routing: ${summary.schema}), ${summary.staff} staff, ${summary.venues} venues, ${summary.shifts} shifts,`,
        `  ${summary.offers} offers, ${summary.attendance} attendance records, ${summary.payrollRuns} payroll runs.`,
        `  CEO ${ceoEmail}: invited, NO password. The activation email is queued; the Worker delivers it through EMAIL_DRIVER.`,
        '  Open the activation link from that email to set the password yourself. No password was generated or printed.',
        '  The organisation AI switch is still OFF: turn it on in Admin Panel -> AI (reason + step-up).',
      ].join('\n'),
    );
  }

  /** Live refusals, inside the seed transaction and before any write. */
  private async assertLiveTarget(m: EntityManager): Promise<void> {
    const [row] = await m.query<Array<{ marked: boolean; can_mark: boolean | null; who: string }>>(
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) cfg
                       WHERE d.datname = current_database() AND s.setrole = 0 AND cfg = 'crewflow.disposable_test_database=true') AS marked,
              CASE WHEN to_regprocedure($1) IS NULL THEN NULL ELSE has_function_privilege(to_regprocedure($1), 'EXECUTE') END AS can_mark,
              current_user AS who`,
      [MARKER_FN],
    );
    if (!row) throw new Error('seed-ai-demo refused: the target probe returned nothing. Nothing was changed.');
    if (row.marked) throw new Error('seed-ai-demo refused: this database is marked as a disposable TEST database (crewflow.disposable_test_database). Nothing was changed.');
    if (row.can_mark === null) throw new Error('seed-ai-demo refused: core.ai_dev_mark_organisation_synthetic does not exist — apply AiDevRealProvider1786720230000 first. Nothing was changed.');
    if (!row.can_mark) throw new Error(`seed-ai-demo refused: the connected role "${row.who}" may not run the synthetic marker. Use the crewflow operator identity, never crewflow_app. Nothing was changed.`);
  }

  private async resolveAdmin(m: EntityManager, email: string): Promise<string> {
    // The pre-auth lookup definer (the runtime `user` RLS hides other organisations' rows); only id + status are read.
    const users = await m.query<Array<{ id: string; status: string }>>(`SELECT id, status FROM core.auth_find_users_by_email($1)`, [email]);
    const user = users.length === 1 && users[0]!.status === UserStatus.ACTIVE ? users[0] : undefined;
    if (user) {
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [user.id]);
      const [admin] = await m.query<Array<{ ok: boolean }>>(`SELECT core.is_active_platform_admin($1) AS ok`, [user.id]);
      if (admin?.ok) return user.id;
    }
    throw new Error('seed-ai-demo refused: --admin-email is not an active platform administrator. Nothing was changed.');
  }

  private async seed(m: EntityManager, adminUserId: string, ceoEmail: string) {
    // 1. Organisation, through the definer that re-checks the platform-admin authority of the bound user (CF-13).
    await m.query(`SELECT set_config('rab.user_id', $1, true)`, [adminUserId]);
    // The definer refuses a taken slug (the runtime RLS cannot see other organisations, so it is the only reliable check):
    // a second run stops here and the whole transaction rolls back.
    const [{ create_organisation: organisationId }] = await m
      .query<Array<{ create_organisation: string }>>(`SELECT core.create_organisation($1, $2) AS create_organisation`, [AI_DEMO_ORGANISATION_NAME, AI_DEMO_SLUG])
      .catch(() => {
        throw new Error(`seed-ai-demo refused: the organisation slug "${AI_DEMO_SLUG}" is not available (already seeded?). Nothing was changed.`);
      });
    const adminCtx: AuthContext = { organisationId, workspaceId: null, userId: adminUserId, role: '' };
    await this.bind(m, adminCtx, 'core');
    await this.audit.record(m, adminCtx, AuditAction.ORGANISATION_CREATED, {
      entityType: 'organisation',
      entityId: organisationId,
      metadata: { name: AI_DEMO_ORGANISATION_NAME, slug: AI_DEMO_SLUG, via: 'seed-ai-demo', synthetic: true },
    });

    // 2. Roles (the production ROLE_DEFS / staff defaults; never a second definition).
    const ceoRoleId = await this.ensureRole(m, organisationId, ROLE_DEFS[ManagerType.CEO]!.key, ROLE_DEFS[ManagerType.CEO]!.name, ROLE_DEFS[ManagerType.CEO]!.permissions);
    const staffRoleId = await this.ensureRole(m, organisationId, STAFF_ROLE_KEY, 'Staff', STAFF_ROLE_PERMISSIONS);

    // 3. The CEO: invited, no password; own workspace (onboarding complete) so the console and AI open on the seeded data.
    const ceoUserId = await this.insertUser(m, organisationId, ceoEmail, 'Demo', 'Ceo');
    await m.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [ceoUserId, ceoRoleId, organisationId]);
    await m.query(`INSERT INTO core.organisation_member (organisation_id, user_id) VALUES ($1, $2)`, [organisationId, ceoUserId]);
    await m.query(`SELECT set_config('rab.user_id', $1, true)`, [ceoUserId]);
    const [workspace] = await m.query<Array<{ id: string; schema_status: string | null }>>(
      `INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status, onboarding_completed_at, schema_status)
       VALUES ($1, $2, $3, $4, 'active', now(), 'CREATING') RETURNING id, schema_status`,
      [organisationId, ceoUserId, 'AI Demo Workspace (synthetic)', AI_DEMO_SLUG],
    );
    const workspaceId = workspace!.id;
    await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
    await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4)`, [organisationId, ceoUserId, ManagerType.CEO, workspaceId]);
    await this.membership(m, organisationId, ceoUserId, workspaceId);
    // Server-path provisioning (the same definer the API calls when a workspace is created): bound org + owner.
    if (workspace!.schema_status !== 'READY') {
      const [{ outcome }] = await m.query<Array<{ outcome: string }>>(`SELECT core.provision_workspace($1) AS outcome`, [workspaceId]);
      if (outcome !== 'READY' && outcome !== 'ALREADY_READY') throw new Error(`seed-ai-demo: workspace provisioning ended ${outcome}. Nothing was committed.`);
    }
    const schema = this.env.get('HWS_RUNTIME_ENABLED') ? await this.workspaceSchema(m, workspaceId) : 'core';
    const ceoCtx: AuthContext = { organisationId, workspaceId, userId: ceoUserId, role: '' };
    await this.bind(m, ceoCtx, schema);

    // 3b. A synthetic Initial Manager (invited, no password, no invitation): the organisation's payroll calendar is written
    //     under its authority, exactly as the RLS policy on `payroll_calendar` requires (Initial Manager only).
    const imDef = ROLE_DEFS[ManagerType.INTERNAL]!;
    const imRoleId = await this.ensureRole(m, organisationId, imDef.key, imDef.name, imDef.permissions);
    await this.bind(m, adminCtx, 'core');
    const imUserId = await this.insertUser(m, organisationId, 'initial.manager.ai-demo@example.test', 'Morgan', 'Exampleton');
    await m.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [imUserId, imRoleId, organisationId]);
    await m.query(`INSERT INTO core.organisation_member (organisation_id, user_id) VALUES ($1, $2)`, [organisationId, imUserId]);
    await m.query(`SELECT set_config('rab.user_id', $1, true)`, [imUserId]);
    await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, is_initial_manager) VALUES ($1, $2, $3, true)`, [organisationId, imUserId, ManagerType.INTERNAL]);
    await this.bind(m, ceoCtx, schema);

    // 4. Synthetic staff: invited, no password, never invited by email (they cannot sign in).
    const [jobRoles, venues] = [[] as string[], [] as string[]];
    for (const [name, rate] of AI_DEMO_JOB_ROLES) {
      const [r] = await m.query<Array<{ id: string }>>(`INSERT INTO job_role (organisation_id, workspace_id, name, default_rate_pence, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [organisationId, workspaceId, name, rate, ceoUserId]);
      jobRoles.push(r!.id);
    }
    for (const name of AI_DEMO_VENUES) {
      const [v] = await m.query<Array<{ id: string }>>(`INSERT INTO venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [organisationId, workspaceId, name, ceoUserId]);
      venues.push(v!.id);
    }
    const staff: string[] = [];
    for (let i = 0; i < STAFF_NAMES.length; i++) {
      const [first, last] = STAFF_NAMES[i]!;
      const userId = await this.insertUser(m, organisationId, `staff${String(i + 1).padStart(2, '0')}.ai-demo@example.test`, first, last);
      await m.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [userId, staffRoleId, organisationId]);
      await m.query(`INSERT INTO core.organisation_member (organisation_id, user_id) VALUES ($1, $2)`, [organisationId, userId]);
      await this.membership(m, organisationId, userId, workspaceId);
      await this.bind(m, ceoCtx, schema);
      const [p] = await m.query<Array<{ id: string }>>(
        `INSERT INTO staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id, employment_status, job_role_id)
         VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id`,
        [organisationId, userId, `AID-${String(i + 1).padStart(3, '0')}`, ceoUserId, workspaceId, jobRoles[i % jobRoles.length]],
      );
      staff.push(p!.id);
    }

    // 5. Shifts: upcoming (partly filled, full, open, draft) and past (completed, with attendance and payroll).
    const now = Date.now();
    const shift = async (venue: number, role: number, startMs: number, required: number, filled: number, status: string): Promise<string> => {
      const [row] = await m.query<Array<{ id: string }>>(
        `INSERT INTO shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
         VALUES ($1, $2, $3, $4, $5, 30, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [organisationId, venues[venue], jobRoles[role], new Date(startMs), new Date(startMs + 8 * H), required, filled, AI_DEMO_JOB_ROLES[role]![1], status, ceoUserId, workspaceId],
      );
      return row!.id;
    };
    const assignment = async (shiftId: string, staffId: string, status: string, startMs: number, role: number): Promise<string> => {
      const [row] = await m.query<Array<{ id: string }>>(
        `INSERT INTO shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 IN ('confirmed', 'completed') THEN now() END, tstzrange($7, $8), $9) RETURNING id`,
        [organisationId, shiftId, staffId, status, AI_DEMO_JOB_ROLES[role]![1], ceoUserId, new Date(startMs), new Date(startMs + 8 * H), workspaceId],
      );
      return row!.id;
    };
    let offers = 0;
    const offer = async (assignmentId: string, staffId: string, status: string, role: number) => {
      offers += 1;
      await m.query(
        `INSERT INTO job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
         VALUES ($1, $2, $3, $4, now(), now() + interval '1 day', $5, $6, $7)`,
        [organisationId, assignmentId, staffId, status, AI_DEMO_JOB_ROLES[role]![1] * 8, ceoUserId, workspaceId],
      );
    };
    const day = (n: number) => now + n * 24 * H;
    const s = (i: number) => staff[i % staff.length]!;
    const upcoming = [
      { at: day(1) + 2 * H, venue: 0, role: 0, required: 3, plan: ['confirmed', 'offered', 'declined'] },
      { at: day(2), venue: 1, role: 1, required: 2, plan: ['confirmed', 'confirmed'] },
      { at: day(3) + 4 * H, venue: 2, role: 2, required: 2, plan: ['offered', 'staff_accepted'] },
      { at: day(5), venue: 0, role: 1, required: 4, plan: ['confirmed'] },
      { at: day(6), venue: 1, role: 0, required: 1, plan: [] as string[] },
      { at: day(9), venue: 2, role: 0, required: 2, plan: [] as string[], draft: true },
    ];
    let shifts = 0;
    let k = 0;
    for (const u of upcoming) {
      const confirmed = u.plan.filter((p) => p === 'confirmed').length;
      const status = u.draft ? 'draft' : confirmed >= u.required ? 'fully_filled' : confirmed > 0 ? 'partially_filled' : 'open';
      const id = await shift(u.venue, u.role, u.at, u.required, confirmed, status);
      shifts += 1;
      for (const p of u.plan) {
        const staffId = s(k++);
        const a = await assignment(id, staffId, p, u.at, u.role);
        if (p === 'offered') await offer(a, staffId, 'pending', u.role);
        if (p === 'declined') await offer(a, staffId, 'declined', u.role);
        if (p === 'staff_accepted') await offer(a, staffId, 'staff_accepted', u.role);
      }
    }
    // Past, completed shifts: attendance (on time / late) and approved payroll records.
    const attendanceRows: Array<{ attendanceId: string; shiftId: string; staffId: string; amount: number; workDate: string }> = [];
    let attendance = 0;
    for (const [n, venue, role, lateMinutes] of [[-9, 0, 0, 2], [-8, 1, 1, 25], [-4, 2, 2, 0], [-3, 0, 1, 12]] as const) {
      const at = day(n);
      const id = await shift(venue, role, at, 2, 2, 'completed');
      shifts += 1;
      for (const late of [0, lateMinutes]) {
        const staffId = s(k++);
        const a = await assignment(id, staffId, 'completed', at, role);
        const amount = AI_DEMO_JOB_ROLES[role]![1] * 8;
        const [att] = await m.query<Array<{ id: string }>>(
          `INSERT INTO attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', 450, $8) RETURNING id`,
          [organisationId, a, id, staffId, workspaceId, new Date(at + late * 60_000), new Date(at + 8 * H), amount],
        );
        attendance += 1;
        attendanceRows.push({ attendanceId: att!.id, shiftId: id, staffId, amount, workDate: new Date(at).toISOString().slice(0, 10) });
      }
    }

    // 6. Payroll: a calendar, two periods, two runs (older / newer) with their lines.
    const year = new Date(now).getUTCFullYear();
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const imCtx: AuthContext = { organisationId, workspaceId, userId: imUserId, role: '' };
    await this.bind(m, imCtx, schema);
    const [cal] = await m.query<Array<{ id: string }>>(`INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES ($1, $2, 1, 'seed-ai-demo', $3) RETURNING id`, [organisationId, year, ceoUserId]);
    const periods = [
      { start: iso(day(-10)), end: iso(day(-6)), payday: iso(day(-2)), rows: attendanceRows.slice(0, 4) },
      { start: iso(day(-5)), end: iso(day(-1)), payday: iso(day(3)), rows: attendanceRows.slice(4) },
    ];
    let payrollRuns = 0;
    for (const p of periods) {
      await this.bind(m, imCtx, schema);
      const [period] = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organisationId, cal!.id, p.start, p.end, p.payday],
      );
      await this.bind(m, ceoCtx, schema);
      const [run] = await m.query<Array<{ id: string }>>(`INSERT INTO payroll_run (organisation_id, workspace_id, period_id, prepared_by) VALUES ($1, $2, $3, $4) RETURNING id`, [organisationId, workspaceId, period!.id, ceoUserId]);
      payrollRuns += 1;
      for (const r of p.rows) {
        // The normal payroll lifecycle: created pending_approval from the approved attendance, then approved.
        const [rec] = await m.query<Array<{ id: string }>>(
          `INSERT INTO payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence)
           VALUES ($1, $2, $3, $4, $5, 'pending_approval', 450, $6, $7) RETURNING id`,
          [organisationId, workspaceId, r.attendanceId, r.shiftId, r.staffId, Math.round(r.amount / 8), r.amount],
        );
        await m.query(`UPDATE payroll_record SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1`, [rec!.id, ceoUserId]);
        await m.query(
          `INSERT INTO payroll_run_line (organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, worked_minutes, pay_rate_pence, amount_pence)
           VALUES ($1, $2, $3, $4, $5, $6, 450, $7, $8)`,
          [organisationId, workspaceId, run!.id, rec!.id, r.staffId, r.workDate, Math.round(r.amount / 8), r.amount],
        );
      }
    }

    // 7. The CEO's activation (the normal account-invite path: token + email outbox; the Worker delivers it).
    await this.bind(m, { organisationId, workspaceId: null, userId: adminUserId, role: '' }, 'core');
    await this.accountLifecycle.sendAccountInvite(m, adminCtx, { userId: ceoUserId, email: ceoEmail, createdBy: adminUserId });

    // 8. The synthetic marker — the only writer of `synthetic_data`; the database re-checks the @example.test rule.
    await m.query(`SELECT ${MARKER_FN.replace('(uuid)', '($1)')} AS marked`, [organisationId]);
    await this.bind(m, adminCtx, 'core');
    await this.audit.record(m, adminCtx, AuditAction.AI_SYNTHETIC_DATA_MARKED, {
      entityType: 'organisation',
      entityId: organisationId,
      metadata: { via: 'seed-ai-demo', users: STAFF_NAMES.length + 2 },
    });

    return { organisationId, workspaceId, schema, staff: staff.length, venues: venues.length, shifts, offers, attendance, payrollRuns };
  }

  private async bind(m: EntityManager, ctx: AuthContext, schema: string): Promise<void> {
    await this.tenantContext.bindCoreIdentityGucs(m, ctx);
    await m.query(`SELECT set_config('search_path', $1, true)`, [schema]);
  }

  private async workspaceSchema(m: EntityManager, workspaceId: string): Promise<string> {
    const [row] = await m.query<Array<{ schema_name: string; status: string }>>(`SELECT schema_name, status FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
    if (!row || row.status !== 'READY' || !/^workspace_[0-9a-f]{32}$/.test(row.schema_name)) throw new Error('seed-ai-demo: the workspace schema is not READY. Nothing was committed.');
    return row.schema_name;
  }

  private async ensureRole(m: EntityManager, organisationId: string, key: string, name: string, permissions: readonly string[]): Promise<string> {
    const [existing] = await m.query<Array<{ id: string }>>(`SELECT id FROM core.role WHERE organisation_id = $1 AND key = $2`, [organisationId, key]);
    if (existing) return existing.id;
    const [role] = await m.query<Array<{ id: string }>>(`INSERT INTO core.role (organisation_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id`, [organisationId, key, name]);
    // Fail closed: an incomplete catalogue stops the seed instead of minting a role missing part of its access.
    const perms = await loadSystemRoleDefaultPermissions(m, key, permissions);
    for (const p of perms) await m.query(`INSERT INTO core.role_permission (role_id, permission_id, organisation_id) VALUES ($1, $2, $3)`, [role!.id, p.id, organisationId]);
    return role!.id;
  }

  private async insertUser(m: EntityManager, organisationId: string, email: string, firstName: string, lastName: string): Promise<string> {
    if (!SYNTHETIC_EMAIL.test(email)) throw new Error('seed-ai-demo: refusing a non-@example.test address.');
    const [row] = await m.query<Array<{ id: string }>>(
      `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [organisationId, email, firstName, lastName, UserStatus.INVITED],
    );
    return row!.id;
  }

  private async membership(m: EntityManager, organisationId: string, userId: string, workspaceId: string): Promise<void> {
    await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [organisationId, workspaceId]);
    await m.query(`INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source) VALUES ($1, $2, $3, 'active', 'write_path')`, [organisationId, userId, workspaceId]);
  }
}

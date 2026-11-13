/**
 * Phase X2.2 (owner decision 2026-11-12, "the Twenty way"): the three ops commands run as one-off CLI commands of the API
 * image under the ONE owner login crewflow_owner, with the operator label required and recorded in audit_log, and the
 * frozen statement lists still enforced. Proven on the disposable database every suite runs on (built the owner-login
 * way: TEST_DATABASE_URL = crewflow_owner), through the real command classes and their real services:
 *
 *   - each command is refused without the label (before any statement, nothing written);
 *   - each command is refused under any other login: by the URL rule (layer 2), and on the database when a session is not
 *     crewflow_owner (verifyOpsAppSession);
 *   - the narrowed session: crewflow_owner → SET LOCAL ROLE rab_secure_owner, verified per transaction, and a statement
 *     name outside the plan / a write transaction on a read-only plan is refused;
 *   - each command runs as crewflow_owner and writes its audit rows carrying the label and the verified database facts
 *     (hws:backfill --apply, user-session:backfill --apply, containment:suspend-test-accounts --execute).
 *
 * The command's process view is the one a real one-off has: role `cli`, PG_DATABASE_URL = crewflow_owner, no legacy
 * database variable (the Jest setup's DATABASE_URL names are removed for the duration of each run and restored after).
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { ContainmentSuspendCommand } from '../../command/containment.command';
import { HwsBackfillCommand } from '../../command/hws-backfill.command';
import {
  assertOpsActingFacts,
  assertOwnerLoginFacts,
  ElevatedOpsSession,
  ElevatedOpsSessionError,
  ElevatedTransactionRecord,
  OPS_SESSION_FACTS_SQL,
  parseOpsSessionFacts,
  verifyOpsAppSession,
} from '../../command/ops/elevated-ops-session';
import { OPS_ELEVATED_PLANS, OpsStatementName } from '../../command/ops/ops-statements';
import { OpsRunError } from '../../command/ops/ops-run';
import { UserSessionBackfillCommand } from '../../command/user-session-backfill.command';
import { currentPgProcessRole, PgProcessRole, resolvePgEnvironment, setPgProcessRole } from '../../database/postgres';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { HwsBackfillService } from '../../database/typeorm/workspace-schema/backfill/hws-backfill.service';
import { selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { SecurityVersionService } from '../../engine/core-modules/auth/services/security-version.service';
import { UserSessionBackfillService } from '../../engine/core-modules/auth/token/backfill/user-session-backfill.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { SchemaResolverService } from '../../engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../engine/core-modules/tenant/workspace-membership.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';
import { provisionTypeScript, seedWorkspace } from './helpers/workspace-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
jest.setTimeout(180_000);

const OWNER_LOGIN = 'crewflow_owner';
const LEGACY_NAMES = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX'] as const;
const CHANGE_REF = `X22-${randomBytes(4).toString('hex')}`;
// Owner decision G1 (c): --operator "<name>" (spaces allowed) and --change-ref required; --operator-source optional.
const OPERATOR = "X22 Integration (O'Disposable)";
const LABEL = { operator: OPERATOR, changeRef: CHANGE_REF };

function userOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

(RUN ? describe : describe.skip)('X2.2: the ops commands under the owner login (disposable database)', () => {
  const { appUrl, adminUrl } = resolveIntegrationTestDatabase(process.env);
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let adminClient: Client;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let containment: ContainmentSuspendCommand;
  let userSessions: UserSessionBackfillCommand;
  let hws: HwsBackfillCommand;
  let platformAdmin: TestIdentity;
  let orgId: string;
  const scratch = mkdtempSync(join(tmpdir(), 'x22-ops-'));

  /**
   * The process view of a one-off `node dist/command/main.js <ops command>` under the owner login: role `cli`,
   * PG_DATABASE_URL = `url`, no legacy database variable. Restores everything afterwards, on failure too.
   */
  async function asOneOffCli<T>(fn: () => Promise<T>, url: string = appUrl): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const name of ['PG_DATABASE_URL', ...LEGACY_NAMES]) saved[name] = process.env[name];
    const savedRole: PgProcessRole = currentPgProcessRole();
    for (const name of LEGACY_NAMES) delete process.env[name];
    process.env.PG_DATABASE_URL = url;
    setPgProcessRole('cli');
    try {
      return await fn();
    } finally {
      setPgProcessRole(savedRole);
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  async function auditRows(organisationId: string, action: string): Promise<Array<{ metadata: Record<string, any>; entity_id: string; actor_user_id: string | null }>> {
    // audit_log is FORCE RLS: read in the organisation's own tenant context, as crewflow_owner.
    return tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, (m) =>
      m.query(
        `SELECT metadata, entity_id, actor_user_id FROM core.audit_log
          WHERE action = $1 AND metadata->'operationalLabel'->>'changeRef' = $2 ORDER BY created_at`,
        [action, CHANGE_REF],
      ),
    );
  }

  async function auditCountForChangeRef(): Promise<number> {
    const [row] = await admin.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE metadata->'operationalLabel'->>'changeRef' = $1`, [CHANGE_REF]);
    return row.n as number;
  }

  /** Every label-carrying audit row proves the owner-login path and the verified login. */
  function expectOwnerLoginAudit(metadata: Record<string, any>, command: string, mode: string): void {
    expect(metadata.operationalLabel).toMatchObject({
      kind: 'operational-label',
      note: 'operational label, not database-verified identity',
      actorSource: 'manual-console',
      actorId: OPERATOR,
      changeRef: CHANGE_REF,
      command,
      mode,
      path: 'owner-login',
    });
    expect(metadata.operationalLabel.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.databaseVerified.appLogin).toBe(OWNER_LOGIN);
  }

  beforeAll(async () => {
    expect(userOf(appUrl)).toBe(OWNER_LOGIN); // the suites run on the owner-login build; anything else is a harness error
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
    // D4: workspace fingerprints differ between PostgreSQL 16 and 18; select the server's table as the runner does, so the
    // workspace fixture below provisions on either major (this suite runs on PG16 in ci-server and PG16/PG18 in ci-twenty-tests).
    await selectWorkspaceFingerprintsForServer(async (sql) => (await adminClient.query(sql)).rows);
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    containment = new ContainmentSuspendCommand(
      dataSource,
      tenantContext,
      moduleRef.get(WorkspaceMembershipService),
      moduleRef.get(RefreshTokenService),
      moduleRef.get(SecurityVersionService),
      moduleRef.get(AuditService),
    );
    userSessions = new UserSessionBackfillCommand(new UserSessionBackfillService(), dataSource, tenantContext, moduleRef.get(AuditService));
    hws = new HwsBackfillCommand(
      new HwsBackfillService(dataSource, moduleRef.get(SchemaResolverService)),
      moduleRef.get(EnvironmentService),
      dataSource,
      tenantContext,
      moduleRef.get(AuditService),
    );

    // The containment run deactivates EVERY active user of the test-pattern organisations, so it needs the same clean slate
    // as containment-suspend-test-accounts.integration.spec.ts (same guard against a concurrent process on this database).
    const [{ n }] = await admin.query<[{ n: number }]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid != pg_backend_pid() AND state = 'active'`,
    );
    if (n > 0) throw new Error(`Refusing to TRUNCATE core.organisation: ${n} other backend(s) are active on this database.`);
    await admin.query(`TRUNCATE core.organisation CASCADE`);

    const org = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, firstIsPlatformAdmin: true, label: 'x22' });
    platformAdmin = org.managers[0]!;
    orgId = org.organisation.id;
    await factory.createStaff(org.organisation, { owner: platformAdmin, label: 'x22-staff' });
  });

  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await adminClient?.end();
    await admin?.destroy();
    await app?.close();
  });

  describe('refusals before any statement', () => {
    const commands = () =>
      [
        ['containment:suspend-test-accounts', () => containment, { target: join(scratch, 'none.tsv'), expectOrgs: '1', expectUsers: '1', expectActive: '1', actorUserId: randomUUID(), log: join(scratch, 'none.log') }],
        ['user-session:backfill', () => userSessions, { apply: true }],
        ['hws:backfill', () => hws, { apply: true, hwsCutover: true, workspaceId: randomUUID() }],
      ] as const;

    it('each command is refused without the operator label (each flag named), and nothing is written', async () => {
      const before = await auditCountForChangeRef();
      for (const [name, command, options] of commands()) {
        await expect(asOneOffCli(() => command().run([], { ...options } as never))).rejects.toThrow(
          /requires the operator label --operator, --change-ref \(missing: --operator, --change-ref\)/,
        );
        await expect(asOneOffCli(() => command().run([], { ...options, ...LABEL, operator: undefined } as never))).rejects.toThrow(/missing: --operator\)/);
        await expect(asOneOffCli(() => command().run([], { ...options, ...LABEL, changeRef: undefined } as never))).rejects.toThrow(/missing: --change-ref\)/);
        await expect(asOneOffCli(() => command().run([], { ...options, ...LABEL, operator: 'Jane\nSmith' } as never))).rejects.toThrow(
          /--operator must be 1-200 characters/,
        );
        await expect(asOneOffCli(() => command().run([], { ...options, ...LABEL, operatorSource: 'laptop' } as never))).rejects.toThrow(
          /--operator-source must be one of/,
        );
        expect(name).toBeTruthy();
      }
      expect(await auditCountForChangeRef()).toBe(before);
    });

    it('each command is refused under any other login (here the cluster superuser), with the label present', async () => {
      expect(userOf(adminUrl)).not.toBe(OWNER_LOGIN);
      for (const [, command, options] of commands()) {
        const failure = asOneOffCli(() => command().run([], { ...options, ...LABEL } as never), adminUrl);
        await expect(failure).rejects.toBeInstanceOf(OpsRunError);
        await expect(asOneOffCli(() => command().run([], { ...options, ...LABEL } as never), adminUrl)).rejects.toThrow(
          new RegExp(`runs only under the owner login crewflow_owner; PG_DATABASE_URL names "${userOf(adminUrl)}"`),
        );
      }
      expect(await auditCountForChangeRef()).toBe(0);
    });

    it('each command is refused inside the API process (a command body reached without main.ts)', async () => {
      for (const [, command, options] of commands()) {
        const saved = currentPgProcessRole();
        try {
          await expect(
            asOneOffCli(async () => {
              setPgProcessRole('api');
              return command().run([], { ...options, ...LABEL } as never);
            }),
          ).rejects.toThrow(/never inside the api process/);
        } finally {
          setPgProcessRole(saved);
        }
      }
    });

    it('on the database: a session that is not crewflow_owner is refused, whatever the URL rule saw', async () => {
      await asOneOffCli(async () => {
        const resolved = resolvePgEnvironment({ PG_DATABASE_URL: appUrl, DB_TARGET: process.env.DB_TARGET }, { processRole: 'cli' });
        const proof = await verifyOpsAppSession(dataSource, resolved, process.env, 'test');
        expect(proof).toMatchObject({ path: 'owner-login', login: OWNER_LOGIN });
        // The admin DataSource connects as the cluster superuser while the resolved URL claims crewflow_owner.
        await expect(verifyOpsAppSession(admin, resolved, process.env, 'test')).rejects.toThrow(/run only under the owner login crewflow_owner \(session_user/);
      });
    });
  });

  describe('the narrowed session keeps the frozen statement lists', () => {
    async function openNarrowed(plan = OPS_ELEVATED_PLANS.containment, records: ElevatedTransactionRecord[] = []): Promise<ElevatedOpsSession> {
      const resolved = resolvePgEnvironment({ PG_DATABASE_URL: appUrl, DB_TARGET: process.env.DB_TARGET }, { processRole: 'cli' });
      const proof = await verifyOpsAppSession(dataSource, resolved, process.env, 'test');
      return ElevatedOpsSession.open({ plan, resolved, env: process.env, app: proof, onVerified: (r) => records.push(r) });
    }

    it('crewflow_owner narrows to rab_secure_owner per transaction and reads every tenant only through a listed name', async () => {
      await asOneOffCli(async () => {
        const records: ElevatedTransactionRecord[] = [];
        const session = await openNarrowed(OPS_ELEVATED_PLANS.containment, records);
        // The session's own one-connection pool (private): the SAME backend serves every transaction of this session.
        const sessionPool = (session as unknown as { dataSource: DataSource }).dataSource;
        const backend = async () =>
          (await sessionPool.query('SELECT pg_backend_pid() AS pid, current_user::text AS acting, session_user::text AS login'))[0] as {
            pid: number;
            acting: string;
            login: string;
          };
        try {
          const before = await backend();
          const orgs = await session.transaction('read-only', (run) => run('containment.test-pattern-organisations', ['^test-[0-9a-f-]{36}$']));
          expect(orgs.map((o) => o.id)).toContain(orgId);
          // Between the two transactions, on the same backend: the login itself, not rab_secure_owner.
          const between = await backend();
          expect(between).toEqual({ pid: before.pid, acting: OWNER_LOGIN, login: OWNER_LOGIN });
          // The second transaction on the SAME session and backend starts as crewflow_owner: its pre-narrowing check
          // (assertOwnerLoginFacts) refuses a session already acting as another role, so success proves it, and the
          // record shows it was narrowed again from the login.
          await session.transaction('read-only', (run) => run('containment.test-pattern-organisations', ['^test-[0-9a-f-]{36}$']));
          expect(records).toEqual([
            expect.objectContaining({ access: 'read-only', login: OWNER_LOGIN, acting: 'rab_secure_owner' }),
            expect.objectContaining({ access: 'read-only', login: OWNER_LOGIN, acting: 'rab_secure_owner' }),
          ]);
          expect(await backend()).toEqual({ pid: before.pid, acting: OWNER_LOGIN, login: OWNER_LOGIN });
        } finally {
          await session.destroy();
        }
      });
    });

    it('a statement name outside the plan, and a write transaction on a read-only plan, are refused', async () => {
      await asOneOffCli(async () => {
        const session = await openNarrowed(OPS_ELEVATED_PLANS.containment);
        try {
          await expect(
            session.transaction('read-only', (run) => run('user-session-backfill.insert-family' as OpsStatementName, [])),
          ).rejects.toThrow(/statement "user-session-backfill.insert-family" is not on the frozen read-only list of plan containment-read/);
          await expect(session.transaction('read-only', (run) => run('not-a-statement' as OpsStatementName, []))).rejects.toBeInstanceOf(ElevatedOpsSessionError);
          await expect(session.transaction('read-write', async () => undefined)).rejects.toThrow(/plan containment-read allows no read-write elevated transaction/);
        } finally {
          await session.destroy();
        }
        const scan = await openNarrowed(OPS_ELEVATED_PLANS['user-session-apply']);
        try {
          // A read name is not a write name: the apply plan's READ WRITE list holds only bind + insert.
          await expect(scan.transaction('read-write', (run) => run('user-session-backfill.candidates', [1]))).rejects.toThrow(/not on the frozen read-write list/);
        } finally {
          await scan.destroy();
        }
      });
    });

    // ---- G3: the live cases of ops-elevated-session.integration.spec.ts, ported to the owner-login path (same assertions) ----

    it('live facts: after SET LOCAL ROLE rab_secure_owner crewflow_owner holds no crewflow privilege; unnarrowed / wrong role / read-write refuse', async () => {
      const raw = new Client({ connectionString: appUrl });
      await raw.connect();
      const database = new URL(appUrl).pathname.slice(1);
      const expect_ = { expectedLogin: OWNER_LOGIN, expectedDatabase: database, role: 'rab_secure_owner' as const, readOnly: true };
      const facts = async () => parseOpsSessionFacts((await raw.query(OPS_SESSION_FACTS_SQL, ['rab_secure_owner'])).rows[0]);
      try {
        await raw.query('BEGIN READ ONLY');
        const before = await facts();
        expect(before).toMatchObject({ login: OWNER_LOGIN, acting: OWNER_LOGIN, canSetRole: true, actingHasCrewflow: true, loginExempt: false });
        expect(() => assertOwnerLoginFacts(before, expect_)).not.toThrow();
        expect(() => assertOpsActingFacts(before, expect_)).toThrow(/unnarrowed or wrong role/);
        await raw.query('SET LOCAL ROLE crewflow');
        const asCrewflow = await facts();
        expect(() => assertOpsActingFacts(asCrewflow, expect_)).toThrow(/current_user is "crewflow"/);
        // A session already acting as another role is refused before narrowing.
        expect(() => assertOwnerLoginFacts(asCrewflow, expect_)).toThrow(/already acting as another role/);
        await raw.query('ROLLBACK');

        await raw.query('BEGIN READ ONLY');
        await raw.query('SET LOCAL ROLE rab_secure_owner');
        const narrowed = await facts();
        expect(narrowed).toMatchObject({ acting: 'rab_secure_owner', actingHasCrewflow: false, actingExempt: false, readOnly: true });
        expect(() => assertOpsActingFacts(narrowed, expect_)).not.toThrow();
        // READ ONLY is a real boundary: a write is refused by PostgreSQL itself.
        await expect(raw.query(`UPDATE core.organisation SET name = name WHERE false`)).rejects.toThrow(/read-only transaction/);
        await raw.query('ROLLBACK');

        await raw.query('BEGIN');
        await raw.query('SET LOCAL ROLE rab_secure_owner');
        const readWrite = await facts();
        expect(readWrite.readOnly).toBe(false);
        expect(() => assertOpsActingFacts(readWrite, expect_)).toThrow(/requires READ ONLY/);
        await raw.query('ROLLBACK');
        // LOCAL: the role is gone after the transaction.
        expect((await raw.query('SELECT current_user::text AS u')).rows[0].u).toBe(OWNER_LOGIN);
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined);
        await raw.end();
      }
    });

    it('refuses the wrong session_user: the narrowed session opens only on PG_DATABASE_URL naming crewflow_owner', async () => {
      await asOneOffCli(async () => {
        const resolved = resolvePgEnvironment({ PG_DATABASE_URL: appUrl, DB_TARGET: process.env.DB_TARGET }, { processRole: 'cli' });
        const proof = await verifyOpsAppSession(dataSource, resolved, process.env, 'test');
        // Another login's URL (the cluster superuser) with a proof from the owner session: refused before any connection.
        const other = resolvePgEnvironment({ PG_DATABASE_URL: adminUrl, DB_TARGET: process.env.DB_TARGET }, { processRole: 'cli' });
        await expect(ElevatedOpsSession.open({ plan: OPS_ELEVATED_PLANS.containment, resolved: other, env: process.env, app: proof })).rejects.toThrow(
          /needs PG_DATABASE_URL naming crewflow_owner/,
        );
        // A proof that names another login: refused too.
        await expect(
          ElevatedOpsSession.open({ plan: OPS_ELEVATED_PLANS.containment, resolved, env: process.env, app: { ...proof, login: userOf(adminUrl) } }),
        ).rejects.toThrow(/needs PG_DATABASE_URL naming crewflow_owner/);
        // And on the database, before narrowing: a session_user other than crewflow_owner is refused (live facts).
        const raw = new Client({ connectionString: adminUrl });
        await raw.connect();
        try {
          await raw.query('BEGIN READ ONLY');
          const facts = parseOpsSessionFacts((await raw.query(OPS_SESSION_FACTS_SQL, ['rab_secure_owner'])).rows[0]);
          expect(() =>
            assertOwnerLoginFacts(facts, { expectedLogin: OWNER_LOGIN, expectedDatabase: proof.database, role: 'rab_secure_owner', readOnly: true }),
          ).toThrow(new RegExp(`session_user is "${userOf(adminUrl)}", not the owner login crewflow_owner`));
        } finally {
          await raw.query('ROLLBACK').catch(() => undefined);
          await raw.end();
        }
      });
    });

    it('refuses a login whose rab_secure_owner membership lacks the SET option (live facts from a test role that never outlives its transaction)', async () => {
      // crewflow_owner's own grants are never touched. A throw-away role is created, granted and used INSIDE one transaction
      // of the cluster superuser (SET LOCAL SESSION AUTHORIZATION), then rolled back: a crash cannot leave it behind.
      const raw = new Client({ connectionString: adminUrl });
      await raw.connect();
      const role = `x22_noset_${randomBytes(4).toString('hex')}`;
      try {
        await raw.query('BEGIN');
        await raw.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`);
        await raw.query(`GRANT rab_secure_owner TO ${role} WITH INHERIT TRUE, SET FALSE`);
        await raw.query(`GRANT crewflow TO ${role} WITH INHERIT TRUE, SET TRUE`);
        await raw.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);
        const facts = parseOpsSessionFacts((await raw.query(OPS_SESSION_FACTS_SQL, ['rab_secure_owner'])).rows[0]);
        expect(facts).toMatchObject({ login: role, acting: role, loginMemberSecureOwner: true, loginMemberCrewflow: true, canSetRole: false });
        // The decision on the live SET=false fact (the name rule is satisfied on purpose, so this rule is what refuses).
        expect(() =>
          assertOwnerLoginFacts(
            { ...facts, login: OWNER_LOGIN, acting: OWNER_LOGIN, readOnly: true },
            { expectedLogin: OWNER_LOGIN, expectedDatabase: facts.database, role: 'rab_secure_owner', readOnly: true },
          ),
        ).toThrow(/may not SET ROLE rab_secure_owner/);
        // PostgreSQL agrees: the narrowing itself is refused for such a login.
        await raw.query('SAVEPOINT s');
        await expect(raw.query('SET LOCAL ROLE rab_secure_owner')).rejects.toThrow(/permission denied/);
        await raw.query('ROLLBACK TO SAVEPOINT s');
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined);
        await raw.end();
      }
      const [{ n }] = await admin.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname = $1`, [role]);
      expect(n).toBe(0);
    });

    it('the apply plan: a READ WRITE transaction is verified as read-write and still narrowed; a non-plan name inside it is refused', async () => {
      await asOneOffCli(async () => {
        const records: ElevatedTransactionRecord[] = [];
        const session = await openNarrowed(OPS_ELEVATED_PLANS['user-session-apply'], records);
        try {
          // Bind a non-existent identity and roll back by throwing: the write path opens, verifies and runs only plan names.
          await expect(
            session.transaction('read-write', async (run) => {
              await run('user-session-backfill.bind-family', ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000']);
              await expect(run('containment.target-users' as OpsStatementName, [[]])).rejects.toThrow(ElevatedOpsSessionError);
              throw new Error('rollback');
            }),
          ).rejects.toThrow('rollback');
          expect(records[0]).toMatchObject({ access: 'read-write', login: OWNER_LOGIN, acting: 'rab_secure_owner' });
        } finally {
          await session.destroy();
        }
      });
    });
  });

  describe('each command runs and audits as crewflow_owner', () => {
    it('hws:backfill --apply --hws-cutover: runs as crewflow_owner and writes ops.hws_backfill_applied with the label', async () => {
      const label = `x22-hws-${randomBytes(4).toString('hex')}`;
      const ws = await seedWorkspace(adminClient, label);
      expect(await provisionTypeScript(adminUrl, ws)).toBeTruthy();
      // A dry run is the default: no mode flag → report only, no audit row.
      const dryReport = join(scratch, 'hws-dry-report.json');
      await asOneOffCli(() => hws.run([], { workspaceId: ws.id, reportFile: dryReport, ...LABEL }));
      expect(JSON.parse(readFileSync(dryReport, 'utf8'))).toMatchObject({ mode: 'dry-run', workspacesSelected: 1 });
      expect(await auditRows(ws.org, AuditAction.OPS_HWS_BACKFILL_APPLIED)).toHaveLength(0);

      const reportFile = join(scratch, 'hws-report.json');
      await asOneOffCli(() => hws.run([], { apply: true, hwsCutover: true, workspaceId: ws.id, reportFile, ...LABEL }));
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      expect(report).toMatchObject({ mode: 'apply', workspacesSelected: 1 });
      const rows = await auditRows(ws.org, AuditAction.OPS_HWS_BACKFILL_APPLIED);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entity_id).toBe(ws.id);
      expect(rows[0]!.actor_user_id).toBeNull();
      expectOwnerLoginAudit(rows[0]!.metadata, 'hws:backfill', 'apply');
      expect(rows[0]!.metadata.databaseVerified.elevatedLogin).toBeUndefined(); // no narrowed session for this command
      expect(rows[0]!.metadata.hwsCutover).toBe(true);
    });

    it('user-session:backfill --verify runs as crewflow_owner; --apply narrows, inserts, and writes one audit row per organisation', async () => {
      await asOneOffCli(() => userSessions.run([], { verify: true, ...LABEL }));

      const familyId = randomUUID();
      const now = Date.now();
      await admin.query(
        `INSERT INTO core.refresh_token
           (id, organisation_id, user_id, token_hash, application_target, family_id, device_id, user_agent, ip,
            expires_at, revoked_at, created_at, family_expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'manager_web', $4, NULL, 'x22', NULL, $5, NULL, $6, $7)`,
        [orgId, platformAdmin.userId, randomBytes(32).toString('hex'), familyId, new Date(now + 3_600_000), new Date(now - 60_000), new Date(now + 86_400_000)],
      );
      // A dry run is the default: no mode flag → nothing inserted, no audit row.
      await asOneOffCli(() => userSessions.run([], { batch: 500, ...LABEL }));
      expect(await admin.query(`SELECT 1 FROM core.user_session WHERE id = $1`, [familyId])).toHaveLength(0);
      expect(await auditRows(orgId, AuditAction.OPS_USER_SESSION_BACKFILL_APPLIED)).toHaveLength(0);

      await asOneOffCli(() => userSessions.run([], { apply: true, batch: 500, ...LABEL }));

      const [session] = await admin.query(`SELECT organisation_id, user_id FROM core.user_session WHERE id = $1`, [familyId]);
      expect(session).toEqual({ organisation_id: orgId, user_id: platformAdmin.userId });
      const rows = await auditRows(orgId, AuditAction.OPS_USER_SESSION_BACKFILL_APPLIED);
      expect(rows).toHaveLength(1);
      expectOwnerLoginAudit(rows[0]!.metadata, 'user-session:backfill', 'apply');
      expect(rows[0]!.metadata.databaseVerified).toMatchObject({ appLogin: OWNER_LOGIN, elevatedLogin: OWNER_LOGIN, elevatedRole: 'rab_secure_owner' });
      expect(rows[0]!.metadata.familyIds).toContain(familyId);
    });

    it('containment:suspend-test-accounts --execute: narrowed reads, owner-login writes, and every suspension audited with the label', async () => {
      const orgs: Array<{ id: string }> = await admin.query(`SELECT id FROM core.organisation WHERE slug ~ '^test-[0-9a-f-]{36}$'`);
      const ids = orgs.map((o) => o.id);
      const users: Array<{ id: string; organisation_id: string; status: string }> = await admin.query(
        `SELECT id, organisation_id, status FROM core."user" WHERE organisation_id = ANY($1::uuid[])`,
        [ids],
      );
      const targets = users.filter((u) => u.status === 'active');
      expect(targets.length).toBeGreaterThanOrEqual(2);
      const targetFile = join(scratch, 'targets.tsv');
      writeFileSync(targetFile, ['organisation_id\tuser_id', ...targets.map((t) => `${t.organisation_id}\t${t.id}`)].join('\n') + '\n');
      const logFile = join(scratch, 'containment.log');
      const baseOptions = {
        target: targetFile,
        expectOrgs: String(ids.length),
        expectUsers: String(users.length),
        expectActive: String(targets.length),
        actorUserId: platformAdmin.userId!,
        ...LABEL,
      };

      // A dry run is the default: without --execute nobody is suspended and no audit row is written.
      await asOneOffCli(() => containment.run([], { ...baseOptions, log: join(scratch, 'containment-dry.log') }));
      for (const t of targets) {
        const [row] = await admin.query(`SELECT status FROM core."user" WHERE id = $1`, [t.id]);
        expect(row.status).toBe('active');
      }
      expect(await auditRows(orgId, 'user.suspended')).toHaveLength(0);
      expect(readFileSync(join(scratch, 'containment-dry.log'), 'utf8')).toContain('"mode":"dry-run"');

      await asOneOffCli(() =>
        containment.run([], {
          target: targetFile,
          expectOrgs: String(ids.length),
          expectUsers: String(users.length),
          expectActive: String(targets.length),
          actorUserId: platformAdmin.userId!,
          log: logFile,
          execute: true,
          ...LABEL,
        }),
      );

      for (const t of targets) {
        const [row] = await admin.query(`SELECT status FROM core."user" WHERE id = $1`, [t.id]);
        expect(row.status).toBe('suspended');
      }
      const rows = await auditRows(orgId, 'user.suspended');
      expect(rows).toHaveLength(targets.filter((t) => t.organisation_id === orgId).length);
      for (const row of rows) {
        expectOwnerLoginAudit(row.metadata, 'containment:suspend-test-accounts', 'execute');
        expect(row.metadata.databaseVerified).toMatchObject({ appLogin: OWNER_LOGIN, elevatedLogin: OWNER_LOGIN, elevatedRole: 'rab_secure_owner' });
        expect(row.metadata.actorClaim).toMatchObject({ userId: platformAdmin.userId, checkedAgainst: 'core.is_active_platform_admin' });
      }
      const log = readFileSync(logFile, 'utf8');
      expect(log).toContain('"event":"elevated-verified"');
      expect(log).toContain('"acting":"rab_secure_owner"');
    });
  });
});

import 'reflect-metadata';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { checkWorkspaceSchemaDrift } from '../../database/typeorm/workspace-schema/workspace-schema-drift';
import { pgClientRunner, WorkspaceSchemaMigrator } from '../../database/typeorm/workspace-schema/workspace-schema-migrator';
import { LATEST_WORKSPACE_MODULE_VERSION, WORKSPACE_SCHEMA_MODULES } from '../../database/typeorm/workspace-schema/workspace-schema-modules';
import {
  dropWorkspaceSchema,
  ledgerOf,
  provisionLegacyV14,
  provisionServerPath,
  provisionTypeScript,
  registryOf,
  SeededWorkspace,
  seedWorkspace,
  sqlstateOf,
} from './helpers/workspace-fixtures';

/**
 * Wave 2 lane S2 (B3 per-workspace migrator + ledger, B4 version tracking + drift). Disposable database only.
 *
 * Proves, against real schemas built by every path:
 *  - both provisioning paths build module 15 with 15 APPLIED ledger rows, module_version 15 and the expected fingerprint,
 *    and a pre-ledger (v14) workspace migrated forward ends byte-for-byte the same (identical fingerprint);
 *  - a failure in schema 2 of 3 leaves 1 and 3 migrated and 2 untouched (rolled back) with a FAILED ledger row; rerun resumes;
 *  - a data pre-check violation REFUSES the module (data unchanged); a checksum mismatch REFUSES; a hand-changed pre-ledger
 *    workspace is not adopted (BASELINE_MISMATCH); a busy table fails fast (LOCK_TIMEOUT) without touching others;
 *  - the runtime role cannot run the migrator, write the ledger, run the recorder/fingerprint, or forge drift columns;
 *    the ledger is append-only for every role; zero ledger rows with no tenant context;
 *  - the drift detector flags a hand-dropped policy (alert-only: the workspace stays routable) and clears after repair.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

describeIfDb('WorkspaceSchemaMigrator + ledger + drift (B3/B4)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const sfx = Math.random().toString(36).slice(2, 8);
  const label = (n: string) => `s2m-${n}-${sfx}`;
  let admin: Client;
  let crewflow: Client;
  const created: SeededWorkspace[] = [];
  const latestFp = EXPECTED_WORKSPACE_FINGERPRINTS[LATEST_WORKSPACE_MODULE_VERSION]!;

  const fingerprint = async (id: string) => (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS f', [id])).rows[0].f as string | null;
  const hasMoneyChecks = async (schema: string) =>
    (
      await admin.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = format('%I.attendance', $1::text)::regclass
            AND conname IN ('attendance_earned_pence_non_negative', 'attendance_worked_minutes_non_negative')`,
        [schema],
      )
    ).rows[0].n as number;
  const legacy = async (n: string) => {
    const ws = await seedWorkspace(admin, label(n));
    created.push(ws);
    await provisionLegacyV14(adminUrl, ws);
    return ws;
  };
  const migrator = () => new WorkspaceSchemaMigrator(pgClientRunner(crewflow));

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    if (!(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper) {
      throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    }
    crewflow = new Client({ connectionString: adminUrl });
    await crewflow.connect();
    await crewflow.query('SET ROLE crewflow');
  });

  afterAll(async () => {
    for (const ws of created) await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
    await crewflow?.end();
    await admin?.end();
  });

  it('both provisioning paths build the latest module set: ledger rows, module_version, expected fingerprint, drift OK', async () => {
    const srv = await seedWorkspace(admin, label('srv'));
    const ts = await seedWorkspace(admin, label('ts'));
    created.push(srv, ts);
    expect(await provisionServerPath(appUrl, srv)).toBe('READY');
    expect(await provisionTypeScript(adminUrl, ts)).toBe('READY');
    for (const ws of [srv, ts]) {
      const reg = await registryOf(admin, ws.id);
      expect(reg).toMatchObject({ status: 'READY', schema_version: 1, module_version: LATEST_WORKSPACE_MODULE_VERSION, drift_status: 'OK' });
      expect(reg.expected_fingerprint).toBe(latestFp);
      expect(await fingerprint(ws.id)).toBe(latestFp);
      const ledger = await ledgerOf(admin, ws.id);
      expect(ledger.map((l) => [l.module_id, l.status, l.attempt])).toEqual(WORKSPACE_SCHEMA_MODULES.map((m) => [m.id, 'APPLIED', 1]));
      expect(await hasMoneyChecks(ws.schema)).toBe(2);
    }
  });

  it('a pre-ledger v14 workspace is BASELINED, then migrated to the latest module, ending identical to a fresh build', async () => {
    const ws = await legacy('old');
    expect(await registryOf(admin, ws.id)).toMatchObject({ status: 'READY', module_version: 0 });
    expect(await fingerprint(ws.id)).toBe(EXPECTED_WORKSPACE_FINGERPRINTS[14]);

    const [out] = await migrator().migrateAll({ workspaceIds: [ws.id], appVersion: 'test:s2' });
    expect(out).toMatchObject({ status: 'MIGRATED', fromVersion: 14, toVersion: LATEST_WORKSPACE_MODULE_VERSION });
    const ledger = await ledgerOf(admin, ws.id);
    expect(ledger.filter((l) => l.status === 'BASELINED').map((l) => l.version)).toEqual([...Array(14).keys()].map((i) => i + 1));
    expect(ledger.filter((l) => l.status === 'APPLIED').map((l) => [l.version, l.previous_version, l.target_version])).toEqual([[15, 14, 15]]);
    expect(await fingerprint(ws.id)).toBe(latestFp);
    expect(await registryOf(admin, ws.id)).toMatchObject({ module_version: 15, expected_fingerprint: latestFp, drift_status: 'OK', status: 'READY' });

    // Idempotent: a second run changes nothing.
    const [again] = await migrator().migrateAll({ workspaceIds: [ws.id] });
    expect(again.status).toBe('UP_TO_DATE');
    expect((await ledgerOf(admin, ws.id)).length).toBe(ledger.length);
  });

  it('a failure in schema 2 of 3 leaves 1 and 3 migrated and 2 rolled back (FAILED row); rerun resumes at attempt 2', async () => {
    const [a, b, c] = [await legacy('fa'), await legacy('fb'), await legacy('fc')];
    const outcomes = await migrator().migrateAll({
      workspaceIds: [a.id, b.id, c.id],
      afterModule: async (schema) => {
        if (schema === b.schema) throw new Error('injected failure: relation "secret" does not exist');
      },
    });
    const by = new Map(outcomes.map((o) => [o.workspaceId, o]));
    expect(by.get(a.id)!.status).toBe('MIGRATED');
    expect(by.get(c.id)!.status).toBe('MIGRATED');
    expect(by.get(b.id)).toMatchObject({ status: 'FAILED', errorClass: 'INTERNAL', moduleId: 'v1.015-attendance-money-checks' });
    expect(await hasMoneyChecks(a.schema)).toBe(2);
    expect(await hasMoneyChecks(c.schema)).toBe(2);
    expect(await hasMoneyChecks(b.schema)).toBe(0); // the module's DDL was rolled back with the schema transaction
    const regB = await registryOf(admin, b.id);
    // The baseline and the module run in ONE schema transaction: both rolled back, so nothing is half-adopted.
    expect(regB).toMatchObject({ status: 'READY', module_version: 0 });
    expect(regB.migration_error).toBe('module v1.015-attendance-money-checks failed (INTERNAL)');
    expect(regB.migration_error).not.toContain('secret');
    const failed = (await ledgerOf(admin, b.id)).filter((l) => l.status === 'FAILED');
    expect(failed).toEqual([expect.objectContaining({ module_id: 'v1.015-attendance-money-checks', attempt: 1, error_class: 'INTERNAL' })]);

    const [resumed] = await migrator().migrateAll({ workspaceIds: [b.id] });
    expect(resumed.status).toBe('MIGRATED');
    expect(await hasMoneyChecks(b.schema)).toBe(2);
    const applied = (await ledgerOf(admin, b.id)).filter((l) => l.module_id === 'v1.015-attendance-money-checks');
    expect(applied.map((l) => [l.status, l.attempt])).toEqual([['FAILED', 1], ['APPLIED', 2]]);
    expect(await fingerprint(b.id)).toBe(latestFp);
  });

  it('a negative earned_pence row REFUSES the money module (PRECHECK_VIOLATION); no data is changed', async () => {
    const ws = await legacy('neg');
    const q = `"${ws.schema}"`;
    const one = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
    const staffUser = await one(
      `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'S2', 'Staff', 'active') RETURNING id`,
      [ws.org, `s2-neg-${sfx}@s2.invalid`],
    );
    const venue = await one(`INSERT INTO ${q}.venue(organisation_id, workspace_id, name) VALUES ($1, $2, 'v') RETURNING id`, [ws.org, ws.id]);
    const role = await one(`INSERT INTO ${q}.job_role(organisation_id, workspace_id, name) VALUES ($1, $2, 'r') RETURNING id`, [ws.org, ws.id]);
    const sp = await one(`INSERT INTO ${q}.staff_profile(organisation_id, workspace_id, user_id, staff_ref) VALUES ($1, $2, $3, 'N1') RETURNING id`, [
      ws.org, ws.id, staffUser,
    ]);
    const shift = await one(
      `INSERT INTO ${q}.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by)
       VALUES ($1, $2, $3, $4, now() - interval '5 hours', now() - interval '1 hour', 1, 1200, $5) RETURNING id`,
      [ws.org, ws.id, venue, role, ws.owner],
    );
    const sa = await one(
      `INSERT INTO ${q}.shift_assignment(organisation_id, workspace_id, shift_id, staff_profile_id, pay_rate_snapshot_pence, period)
       VALUES ($1, $2, $3, $4, 1200, tstzrange(now() - interval '5 hours', now() - interval '1 hour')) RETURNING id`,
      [ws.org, ws.id, shift, sp],
    );
    await admin.query(
      `INSERT INTO ${q}.attendance(organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, earned_pence, worked_minutes)
       VALUES ($1, $2, $3, $4, $5, now() - interval '5 hours', now() - interval '1 hour', 'clocked_out', -100, 240)`,
      [ws.org, ws.id, sa, shift, sp],
    );
    const [out] = await migrator().migrateAll({ workspaceIds: [ws.id] });
    expect(out).toMatchObject({ status: 'REFUSED', errorClass: 'PRECHECK_VIOLATION', moduleId: 'v1.015-attendance-money-checks' });
    expect(await hasMoneyChecks(ws.schema)).toBe(0);
    expect((await admin.query(`SELECT earned_pence::int AS e FROM ${q}.attendance WHERE shift_assignment_id = $1`, [sa])).rows[0].e).toBe(-100);
    expect((await ledgerOf(admin, ws.id)).map((l) => l.status)).toEqual(['REFUSED']); // the baseline rolled back with it
    // Clean up the violating row so the schema can be migrated by later suites/tools.
    await admin.query(`DELETE FROM ${q}.attendance WHERE shift_assignment_id = $1`, [sa]);
    expect((await migrator().migrateAll({ workspaceIds: [ws.id] }))[0]!.status).toBe('MIGRATED');
  });

  it('a recorded checksum that differs from the code REFUSES the schema (CHECKSUM_MISMATCH)', async () => {
    const ws = await legacy('sum');
    expect((await migrator().migrateAll({ workspaceIds: [ws.id], throughVersion: 14 }))[0]!.status).toBe('BASELINED');
    // Simulate a frozen module edited after it was applied: rewrite its recorded checksum (superuser, append-only trigger off).
    await admin.query('BEGIN');
    await admin.query('ALTER TABLE core.workspace_schema_migration DISABLE TRIGGER workspace_schema_migration_no_update_delete');
    await admin.query(`UPDATE core.workspace_schema_migration SET checksum = repeat('f', 64) WHERE workspace_id = $1 AND module_id = 'v1.008-payroll-record'`, [ws.id]);
    await admin.query('ALTER TABLE core.workspace_schema_migration ENABLE TRIGGER workspace_schema_migration_no_update_delete');
    await admin.query('COMMIT');
    const [out] = await migrator().migrateAll({ workspaceIds: [ws.id] });
    expect(out).toMatchObject({ status: 'REFUSED', errorClass: 'CHECKSUM_MISMATCH', moduleId: 'v1.008-payroll-record' });
    expect(await hasMoneyChecks(ws.schema)).toBe(0);
  });

  it('a hand-changed pre-ledger workspace is NOT adopted (BASELINE_MISMATCH) and nothing is applied', async () => {
    const ws = await legacy('hand');
    await admin.query(`GRANT TRUNCATE ON "${ws.schema}".venue TO crewflow_app`);
    const [out] = await migrator().migrateAll({ workspaceIds: [ws.id] });
    expect(out).toMatchObject({ status: 'REFUSED', errorClass: 'BASELINE_MISMATCH' });
    expect(await registryOf(admin, ws.id)).toMatchObject({ module_version: 0, status: 'READY' });
    expect(await hasMoneyChecks(ws.schema)).toBe(0);
    await admin.query(`REVOKE TRUNCATE ON "${ws.schema}".venue FROM crewflow_app`);
  });

  it('a busy table fails fast with LOCK_TIMEOUT and does not block or change any other schema', async () => {
    const [busy, free] = [await legacy('busy'), await legacy('free')];
    const holder = new Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`LOCK TABLE "${busy.schema}".attendance IN ACCESS EXCLUSIVE MODE`);
      const outcomes = await migrator().migrateAll({ workspaceIds: [busy.id, free.id], lockTimeoutMs: 300 });
      const by = new Map(outcomes.map((o) => [o.workspaceId, o]));
      expect(by.get(busy.id)).toMatchObject({ status: 'FAILED', errorClass: 'LOCK_TIMEOUT' });
      expect(JSON.stringify(by.get(free.id))).toContain('"status":"MIGRATED"');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect((await migrator().migrateAll({ workspaceIds: [busy.id] }))[0]!.status).toBe('MIGRATED');
  });

  it('the runtime role cannot migrate, write or rewrite the ledger, run the recorder, or forge drift columns', async () => {
    const ws = created[0]!;
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      await expect(new WorkspaceSchemaMigrator(pgClientRunner(app)).migrateAll()).rejects.toThrow('refuses to run as "crewflow_app"');
      await app.query('BEGIN');
      await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [ws.org, ws.owner]);
      // Reads its own organisation's history only.
      const own = (await app.query('SELECT DISTINCT organisation_id FROM core.workspace_schema_migration')).rows.map((r) => r.organisation_id);
      expect(own).toEqual([ws.org]);
      await app.query('SAVEPOINT s');
      expect(
        await sqlstateOf(
          app.query(
            `INSERT INTO core.workspace_schema_migration (workspace_id, organisation_id, schema_name, module_id, version, checksum, previous_version,
               target_version, attempt, status, started_at, app_version)
             VALUES ($1, $2, $3, 'v1.099-forged', 99, repeat('a', 64), 0, 99, 1, 'APPLIED', now(), 'x')`,
            [ws.id, ws.org, ws.schema],
          ),
        ),
      ).toBe('42501');
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect(await sqlstateOf(app.query(`UPDATE core.workspace_schema_migration SET status = 'APPLIED' WHERE workspace_id = $1`, [ws.id]))).toBe('42501');
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect(await sqlstateOf(app.query(`DELETE FROM core.workspace_schema_migration WHERE workspace_id = $1`, [ws.id]))).toBe('42501');
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect(await sqlstateOf(app.query('SELECT * FROM core.record_workspace_schema_drift($1)', [ws.id]))).toBe('42501');
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect(await sqlstateOf(app.query('SELECT core.workspace_schema_fingerprint($1)', [ws.id]))).toBe('42501');
      await app.query('ROLLBACK TO SAVEPOINT s');
      // Table-level UPDATE on the registry is pre-existing; the guard still refuses the versioning/drift columns.
      expect(await sqlstateOf(app.query(`UPDATE core.workspace_schema_registry SET drift_status = 'OK', module_version = 99 WHERE workspace_id = $1`, [ws.id]))).toBe('42501');
      await app.query('ROLLBACK');

      // No tenant context bound: zero ledger rows (fail closed), never all rows.
      await app.query('BEGIN');
      await app.query(`SELECT set_config('rab.organisation_id', '', true), set_config('rab.user_id', '', true)`);
      expect((await app.query('SELECT count(*)::int AS n FROM core.workspace_schema_migration')).rows[0].n).toBe(0);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
    // crewflow with no context also sees zero rows (FORCE binds the owner).
    await crewflow.query('BEGIN');
    await crewflow.query(`SELECT set_config('rab.organisation_id', '', true)`);
    expect((await crewflow.query('SELECT count(*)::int AS n FROM core.workspace_schema_migration')).rows[0].n).toBe(0);
    await crewflow.query('ROLLBACK');
  });

  it('the ledger is append-only for every role, the owner and the superuser included', async () => {
    const ws = created[0]!;
    await crewflow.query('BEGIN');
    await crewflow.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ws.org]);
    expect(await sqlstateOf(crewflow.query(`UPDATE core.workspace_schema_migration SET attempt = attempt WHERE workspace_id = $1`, [ws.id]))).toBe('42501');
    await crewflow.query('ROLLBACK');
    expect(await sqlstateOf(admin.query(`DELETE FROM core.workspace_schema_migration WHERE workspace_id = $1`, [ws.id]))).toBe('42501');
    expect(await sqlstateOf(admin.query('TRUNCATE core.workspace_schema_migration'))).toBe('42501');
  });

  it('drift detector: a hand-dropped policy is reported DRIFTED (alert-only, still routable); repair clears it', async () => {
    const ws = created[0]!;
    const mine = async () => (await checkWorkspaceSchemaDrift(crewflow)).findings.filter((f) => f.workspaceId === ws.id);
    expect(await mine()).toEqual([]);
    expect((await registryOf(admin, ws.id)).drift_status).toBe('OK');

    const def = (
      await admin.query(
        `SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies
          WHERE schemaname = $1 AND tablename = 'venue' ORDER BY policyname LIMIT 1`,
        [ws.schema],
      )
    ).rows[0];
    await admin.query(`DROP POLICY ${def.policyname} ON "${ws.schema}".venue`);
    try {
      const findings = await mine();
      expect(findings).toEqual([expect.objectContaining({ status: 'DRIFTED' })]);
      const reg = await registryOf(admin, ws.id);
      expect(reg).toMatchObject({ drift_status: 'DRIFTED', status: 'READY', schema_version: 1 });
      expect(reg.observed_fingerprint).not.toBe(reg.expected_fingerprint);
      // Alert-only: routing is unchanged (no fail-closed on drift, gate G3).
      expect((await admin.query('SELECT core.workspace_schema_routable($1) AS r', [ws.id])).rows[0].r).toBe(true);
    } finally {
      const roles = (def.roles as string[]).map((r) => (r === 'public' ? 'PUBLIC' : `"${r}"`)).join(', ');
      await admin.query(
        `CREATE POLICY ${def.policyname} ON "${ws.schema}".venue AS ${def.permissive} FOR ${def.cmd} TO ${roles}` +
          (def.qual ? ` USING (${def.qual})` : '') +
          (def.with_check ? ` WITH CHECK (${def.with_check})` : ''),
      );
    }
    expect(await mine()).toEqual([]);
    expect((await registryOf(admin, ws.id)).drift_status).toBe('OK');
  });

  it('drift detector: a READY registry row whose schema is gone is MISSING; a pre-ledger workspace is UNVERIFIED', async () => {
    const gone = await legacy('gone');
    const pre = await legacy('pre');
    await dropWorkspaceSchema(admin, gone.schema);
    const findings = (await checkWorkspaceSchemaDrift(crewflow)).findings;
    expect(findings.find((f) => f.workspaceId === gone.id)?.status).toBe('MISSING');
    expect(findings.find((f) => f.workspaceId === pre.id)?.status).toBe('UNVERIFIED');
    // A workspace whose schema is gone cannot be migrated either (it is not adoptable).
    expect((await migrator().migrateAll({ workspaceIds: [gone.id] }))[0]!.status).toBe('REFUSED');
  });
});

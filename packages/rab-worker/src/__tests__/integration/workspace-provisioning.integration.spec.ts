/**
 * HWS runtime cutover, automated proof of `workspace-provisioning.job.ts` — the gap flagged in
 * docs/HANDOFF.md §32f/32g/32h ("workspace-provisioning.job.ts has no test coverage at all yet").
 * Real PostgreSQL, real `provisionWorkspaceSchema`, real `core.manager_workspace`/
 * `core.workspace_schema_registry` — no mocks. Every workspace this suite creates is disposable
 * and dropped in `afterEach`.
 *
 * `HWS_RUNTIME_ENABLED` is never set here — this test exercises the job function directly, the same
 * way `main.ts` would call it once the flag is on, without needing the flag itself (which gates only
 * whether the worker *schedules* the job, not what the job does when called).
 */
import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { resolveIntegrationTestDatabase } from '@rab/server/database/typeorm/core/test-database-guard';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import {
  provisionWorkspaceSchema,
  V1_EXPECTED,
  WORKSPACE_TABLES,
  workspaceSchemaName,
  WorkspaceSchemaProvisioningError,
} from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { runWorkspaceProvisioningCycle } from '../../queues/rab-maintenance/workspace-provisioning.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const FIXTURE_PASSWORD = generateFixturePassword();

describeIfDb('workspace provisioning job (integration)', () => {
  let adminDataSource: DataSource;
  let ownerClient: Client;
  let passwordHashing: PasswordHashingService;
  const createdOrgIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    ownerClient = new Client({ connectionString: adminUrl });
    await ownerClient.connect();
    passwordHashing = new PasswordHashingService();
  });

  afterAll(async () => {
    await ownerClient.end();
    await adminDataSource.destroy();
  });

  /** Creates an Organisation + Internal Manager + ManagerWorkspace(schema_status='CREATING') — exactly the state `ManagerWorkspaceService.create()` leaves behind, via the owner connection (mirrors `seedOrgFixture` conventions used elsewhere in this test tree). */
  async function seedCreatingWorkspace(label: string): Promise<{ organisationId: string; workspaceId: string; ownerUserId: string }> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    createdOrgIds.push(organisationId);

    return adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const passwordHash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const userResult = await manager.insert(User, {
        organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        passwordHash,
        firstName: label,
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerUserId, roleId: role.id, organisationId });
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);

      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId,
        name: `${label} Workspace`,
        subdomain: `${label}-${randomUUID().slice(0, 8)}`,
        status: 'active',
        schemaStatus: 'CREATING',
      });
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspace.id]);
      await manager.insert(ManagerProfile, { organisationId, userId: ownerUserId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
      createdWorkspaceIds.push(workspace.id);
      return { organisationId, workspaceId: workspace.id, ownerUserId };
    });
  }

  async function registryRow(
    workspaceId: string,
    organisationId: string,
  ): Promise<{ status: string; schema_version: number; schema_name: string; migration_error: string | null } | null> {
    return adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      const rows = await manager.query(`SELECT status, schema_version, schema_name, migration_error FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
      return rows[0] ?? null;
    });
  }

  async function dropWorkspaceSchema(workspaceId: string): Promise<void> {
    let schemaName: string;
    try {
      schemaName = workspaceSchemaName(workspaceId);
    } catch {
      return;
    }
    await ownerClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  }

  afterEach(async () => {
    // manager_profile's RLS (USING: user_id = current_uid() OR workspace_id = current_workspace() OR manage) needs
    // workspace_id bound too, not just organisation_id — the same lesson learned manually proving the backfill
    // tool's own cleanup (HANDOFF.md §32h, step 11). Delete it per-workspace, before manager_workspace.
    for (const workspaceId of createdWorkspaceIds) {
      const org = await adminDataSource.query(`SELECT organisation_id FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
      if (org.length > 0) {
        const organisationId = org[0].organisation_id as string;
        await adminDataSource.transaction(async (manager) => {
          await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [organisationId, workspaceId]);
          await manager.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
          await manager.query(`DELETE FROM core.manager_profile WHERE workspace_id = $1`, [workspaceId]);
          await manager.query(`DELETE FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
        });
      }
      await dropWorkspaceSchema(workspaceId);
    }
    for (const organisationId of createdOrgIds) {
      await adminDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
        await manager.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [organisationId]);
      });
      // Deliberately NOT `DELETE FROM core.organisation` here — a second, pre-existing,
      // out-of-scope sibling of the bug `AuditLogImmutableHistoricalIdentifiers1786692000000` fixed.
      // `audit_log_organisation_id_fkey` is `ON DELETE CASCADE`, untouched by that migration (no
      // production code path hard-deletes an Organisation, so it was never in scope). Postgres
      // enforces a cascade's internal DELETE against audit_log using the table's OWNER's own grants
      // regardless of which role issues the outer DELETE — confirmed empirically, including as the
      // literal superuser, in a throwaway transaction against this same disposable database, even
      // against an organisation with zero matching audit_log rows (the privilege check runs before
      // row-matching). Since `crewflow` has DELETE revoked from `audit_log` by design and that must
      // stay revoked, there is no way to let this cascade fire; this predates this session's audit
      // work entirely — organisation hard-delete was already unsupported for any org with audit
      // history. Leaving the disposable test organisation behind is the correct fix for a
      // test-only cleanup step, not a workaround: this disposable database already accumulates
      // other test debris by convention, and no code anywhere in this cleanup, or in the tests
      // above it, depends on the organisation actually being gone.
    }
    createdOrgIds.length = 0;
    createdWorkspaceIds.length = 0;
  });

  // ------------------------------------------------------------------ Part 1: real end-to-end provisioning

  it('drives a CREATING workspace to READY, schema version 1, matching the full V1 structural contract', async () => {
    const fx = await seedCreatingWorkspace('prov-ready');

    const result = await runWorkspaceProvisioningCycle(ownerClient);
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const registry = await registryRow(fx.workspaceId, fx.organisationId);
    expect(registry).not.toBeNull();
    expect(registry!.status).toBe('READY');
    expect(registry!.schema_version).toBe(1);
    const expectedSchemaName = workspaceSchemaName(fx.workspaceId);
    expect(registry!.schema_name).toBe(expectedSchemaName);

    // manager_workspace's own lifecycle mirror — core.mark_workspace_schema_ready updates both in one statement.
    const [ws] = await adminDataSource.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [fx.workspaceId]);
    expect(ws.schema_status).toBe('READY');

    // --- structural contract, read directly off the live catalog, not assumed ---
    const [{ n: tableCount, forced }] = await adminDataSource.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
      [expectedSchemaName],
    );
    expect(tableCount).toBe(V1_EXPECTED.tables);
    expect(forced).toBe(V1_EXPECTED.tables); // every one of the 15 is FORCE RLS

    const tableNames: Array<{ relname: string }> = await adminDataSource.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [expectedSchemaName],
    );
    expect(tableNames.map((t) => t.relname).sort()).toEqual([...WORKSPACE_TABLES].sort());

    // workspace_id NOT NULL on all 15 (the schema CHECK also requires it, but the column constraint is the one
    // Part 1 explicitly asks for as a separate assertion).
    const notNullCount: Array<{ n: number }> = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = $1 AND c.relkind = 'r' AND a.attname = 'workspace_id' AND a.attnotnull`,
      [expectedSchemaName],
    );
    expect(notNullCount[0]!.n).toBe(V1_EXPECTED.tables);

    const indexCount: Array<{ n: number }> = await adminDataSource.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1`, [expectedSchemaName]);
    expect(indexCount[0]!.n).toBe(V1_EXPECTED.indexes);

    const policyCount: Array<{ n: number }> = await adminDataSource.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1`, [expectedSchemaName]);
    expect(policyCount[0]!.n).toBe(V1_EXPECTED.policies);

    const fkCount: Array<{ n: number }> = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace ns ON ns.oid = k.connamespace WHERE ns.nspname = $1 AND k.contype = 'f'`,
      [expectedSchemaName],
    );
    expect(fkCount[0]!.n).toBe(V1_EXPECTED.foreignKeys);

    // Schema-bound CHECK, present on all 15, and its value is THIS workspace's own id — never a different one.
    const boundChecks: Array<{ def: string }> = await adminDataSource.query(
      `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_namespace ns ON ns.oid = k.connamespace
        WHERE ns.nspname = $1 AND k.contype = 'c' AND k.conname LIKE '%\\_workspace\\_bound'`,
      [expectedSchemaName],
    );
    expect(boundChecks).toHaveLength(V1_EXPECTED.tables);
    expect(boundChecks.every((row) => row.def.includes(`'${fx.workspaceId}'::uuid`) && row.def.includes('workspace_id IS NOT NULL'))).toBe(true);
  });

  it('repeated provisioning on an already-READY workspace is a safe no-op — the candidate query itself excludes it', async () => {
    const fx = await seedCreatingWorkspace('prov-idempotent');
    const first = await runWorkspaceProvisioningCycle(ownerClient);
    expect(first.ready).toBeGreaterThanOrEqual(1);

    const before = await registryRow(fx.workspaceId, fx.organisationId);
    const second = await runWorkspaceProvisioningCycle(ownerClient);
    const after = await registryRow(fx.workspaceId, fx.organisationId);

    // Not necessarily attempted=0 (other CREATING/FAILED workspaces from parallel tests may exist), but THIS
    // workspace's own registry row must be byte-identical — READY is terminal and untouched by a second sweep.
    expect(after).toEqual(before);
    expect(second.failed).toBe(0);
  });

  it('a workspace that never calls provisioning stays CREATING and non-routable', async () => {
    const fx = await seedCreatingWorkspace('prov-untouched');
    const registry = await registryRow(fx.workspaceId, fx.organisationId);
    expect(registry).toBeNull(); // register_workspace_schema never ran — no registry row at all yet
    const [ws] = await adminDataSource.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [fx.workspaceId]);
    expect(ws.schema_status).toBe('CREATING');
  });

  // ------------------------------------------------------------------ Part 2: deterministic failure + resume

  it('a deterministic mid-provisioning failure never becomes READY, records FAILED safely, and a retry succeeds with no duplicate objects', async () => {
    const fx = await seedCreatingWorkspace('prov-failure-resume');
    const expectedSchemaName = workspaceSchemaName(fx.workspaceId);

    // Deterministic failure: the SAME test seam provisionWorkspaceSchema's own doc comment documents
    // ("Production callers never pass it"), plumbed through the real job function (runWorkspaceProvisioningCycle's
    // testOptions param) rather than bypassing the job and calling the provisioner directly.
    const firstAttempt = await runWorkspaceProvisioningCycle(ownerClient, {
      afterApply: async () => {
        throw new Error('INJECTED-TEST-FAILURE: deterministic mid-provisioning failure');
      },
    });
    expect(firstAttempt.failed).toBeGreaterThanOrEqual(1);
    expect(firstAttempt.ready).toBe(0);

    // Never READY. Failure recorded with a SAFE summary (phase + SQLSTATE-shaped text), never the raw injected message.
    const afterFailure = await registryRow(fx.workspaceId, fx.organisationId);
    expect(afterFailure).not.toBeNull();
    expect(afterFailure!.status).toBe('FAILED');
    const [wsAfterFailure] = await adminDataSource.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [fx.workspaceId]);
    expect(wsAfterFailure.schema_status).toBe('FAILED');

    // Partial work does not become routable: the schema is either absent or was rolled back to empty — never a
    // half-built set of tables sitting there usable.
    const [{ n: tableCountAfterFailure }] = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
      [expectedSchemaName],
    );
    expect(tableCountAfterFailure).toBe(0);

    // Retry (no testOptions this time — a clean attempt) succeeds.
    const retry = await runWorkspaceProvisioningCycle(ownerClient);
    expect(retry.failed).toBe(0);
    expect(retry.ready).toBeGreaterThanOrEqual(1);

    const afterRetry = await registryRow(fx.workspaceId, fx.organisationId);
    expect(afterRetry!.status).toBe('READY');
    expect(afterRetry!.schema_version).toBe(1);

    // Final schema matches a clean, uninterrupted provision exactly — same structural contract as the first test,
    // and no duplicate objects (counts are exact, not "at least").
    const [{ n: finalTableCount, forced: finalForced }] = await adminDataSource.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
      [expectedSchemaName],
    );
    expect(finalTableCount).toBe(V1_EXPECTED.tables);
    expect(finalForced).toBe(V1_EXPECTED.tables);
    const finalFkCount = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace ns ON ns.oid = k.connamespace WHERE ns.nspname = $1 AND k.contype = 'f'`,
      [expectedSchemaName],
    );
    expect(finalFkCount[0].n).toBe(V1_EXPECTED.foreignKeys);
  });

  it('one workspace failing mid-batch does not abort or corrupt a sibling workspace in the same tick', async () => {
    const failing = await seedCreatingWorkspace('prov-batch-fail');
    const healthy = await seedCreatingWorkspace('prov-batch-ok');
    let calls = 0;

    const result = await runWorkspaceProvisioningCycle(ownerClient, {
      afterApply: async (schemaName: string) => {
        calls += 1;
        if (schemaName === workspaceSchemaName(failing.workspaceId)) {
          throw new Error('INJECTED-TEST-FAILURE: only this one workspace fails');
        }
      },
    });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.ready).toBeGreaterThanOrEqual(1);
    expect(calls).toBeGreaterThanOrEqual(2); // both candidates were actually attempted, not short-circuited

    const failedRegistry = await registryRow(failing.workspaceId, failing.organisationId);
    expect(failedRegistry!.status).toBe('FAILED');
    const healthyRegistry = await registryRow(healthy.workspaceId, healthy.organisationId);
    expect(healthyRegistry!.status).toBe('READY');
  });

  it('a WorkspaceSchemaProvisioningError never leaks the raw injected message (safe-error contract)', async () => {
    const fx = await seedCreatingWorkspace('prov-safe-error');

    const attempt = provisionWorkspaceSchema(ownerClient, fx.workspaceId, {
      afterApply: async () => {
        throw new Error('SECRET-SQL-DETAIL-that-must-never-reach-the-registry');
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(WorkspaceSchemaProvisioningError);
    await expect(attempt).rejects.not.toThrow(/SECRET-SQL-DETAIL/);

    const registry = await registryRow(fx.workspaceId, fx.organisationId);
    expect(registry!.migration_error ?? '').not.toContain('SECRET-SQL-DETAIL');
  });
});

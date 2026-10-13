process.env.WORKSPACE_METADATA_CACHE_ENABLED = 'true';

import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { CoreEntityCacheService } from '../../engine/core-modules/entity-cache/core-entity-cache.service';
import { WorkspaceMetadataCacheService } from '../../engine/core-modules/entity-cache/workspace-metadata-cache.service';
import { SchemaResolverService, WorkspaceRoutingError, workspaceSchemaName } from '../../engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { Organisation, Role, User, UserRole } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';

/**
 * Redis checkpoint — Workspace Metadata Cache, exercised directly through `SchemaResolverService`
 * (the only real consumer today) rather than through `TenantContextService`/HTTP — `resolve()`
 * itself doesn't gate on `HWS_RUNTIME_ENABLED` (only its callers do), so this can prove the cache's
 * own contract without needing that flag on too.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

const FIXTURE_PASSWORD = generateFixturePassword();

describeIfDb('Workspace Metadata Cache (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let schemaResolver: SchemaResolverService;
  let workspaceMetadataCache: WorkspaceMetadataCacheService;
  let coreEntityCache: CoreEntityCacheService;
  let passwordHashing: PasswordHashingService;
  const createdWorkspaceIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    schemaResolver = moduleRef.get(SchemaResolverService);
    workspaceMetadataCache = moduleRef.get(WorkspaceMetadataCacheService);
    coreEntityCache = moduleRef.get(CoreEntityCacheService);
    passwordHashing = moduleRef.get(PasswordHashingService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  afterEach(async () => {
    for (const workspaceId of createdWorkspaceIds) {
      let schemaName: string | null = null;
      try {
        schemaName = workspaceSchemaName(workspaceId);
      } catch {
        schemaName = null;
      }
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
      if (schemaName) await adminDataSource.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    for (const organisationId of createdOrgIds) {
      await adminDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
        await manager.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [organisationId]);
      });
      // Deliberately not DELETE FROM core.organisation — see workspace-provisioning.integration.spec.ts's
      // identical afterEach comment: audit_log_organisation_id_fkey's CASCADE is a separate, recorded,
      // out-of-scope finding.
    }
    createdWorkspaceIds.length = 0;
    createdOrgIds.length = 0;
  });

  /** Seeds a fully-READY workspace directly against the owner connection — same shape `workspace-provisioning.integration.spec.ts` uses, minus actually calling the provisioner (this file only cares about SchemaResolverService's own read side). */
  async function seedReadyWorkspace(label: string): Promise<{ organisationId: string; workspaceId: string }> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    createdOrgIds.push(organisationId);

    const workspaceId = await adminDataSource.transaction(async (manager) => {
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

      // Drive it straight to READY via the same SECURITY DEFINER functions the real provisioner
      // uses — this file is testing the CACHE's read side, not provisioning itself (already proven
      // end-to-end in workspace-provisioner-entrypoint.integration.spec.ts).
      await manager.query(`SELECT core.begin_workspace_schema_attempt($1)`, [workspace.id]);
      await manager.query(`SELECT core.register_workspace_schema($1)`, [workspace.id]);
      await manager.query(`SELECT core.provision_workspace_schema($1)`, [workspace.id]);
      await manager.query(`SELECT core.mark_workspace_schema_ready($1, 1)`, [workspace.id]);
      return workspace.id as string;
    });
    createdWorkspaceIds.push(workspaceId);
    return { organisationId, workspaceId };
  }

  /**
   * No direct "peek" getter exists anymore (the old `getResolvedSchema`/`setResolvedSchema` pair
   * was replaced by the shared epoch mechanism — see `WorkspaceMetadataCacheService`'s own doc
   * comment). This probes cache state the same way `core-entity-cache.integration.spec.ts` proves
   * a HIT: a `fetch` that throws if actually called means "was this already cached?" — if the
   * probe resolves without throwing, it was a HIT; if it rejects with the sentinel error, it was a
   * MISS (and nothing was cached by this probe itself, since `fetch` never returns a value).
   */
  async function isCached(workspaceId: string): Promise<boolean> {
    try {
      await coreEntityCache.getOrFetch(
        'workspace_schema_resolution',
        workspaceId,
        async () => {
          throw new Error('PROBE_MISS');
        },
        true,
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'PROBE_MISS') return false;
      throw error;
    }
  }

  it('is enabled for this suite (sanity check on the env override above)', () => {
    expect(workspaceMetadataCache.isEnabled()).toBe(true);
  });

  it('a cold resolve() is a MISS (reads Postgres), a warm resolve() is a HIT served from Redis alone', async () => {
    const fx = await seedReadyWorkspace('wsmeta-hit');
    const expected = workspaceSchemaName(fx.workspaceId);

    expect(await isCached(fx.workspaceId)).toBe(false); // nothing cached yet

    const first = await adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [fx.organisationId]);
      return schemaResolver.resolve(manager, fx.workspaceId);
    });
    expect(first).toBe(expected);

    expect(await isCached(fx.workspaceId)).toBe(true);

    // Prove the SECOND resolve() is actually served from the cache, not Postgres: corrupt the
    // registry row so a real Postgres read would now fail — resolve() must still succeed.
    await adminDataSource.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [fx.workspaceId]);
    const second = await adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [fx.organisationId]);
      return schemaResolver.resolve(manager, fx.workspaceId);
    });
    expect(second).toBe(expected); // served from cache — the Postgres row being FAILED now never mattered
  });

  it('never caches, and always correctly re-evaluates, every failure path', async () => {
    const fx = await seedReadyWorkspace('wsmeta-fail');

    // missing-context
    await expect(
      adminDataSource.transaction((manager) => schemaResolver.resolve(manager, null)),
    ).rejects.toThrow(WorkspaceRoutingError);

    // registry-missing: a random workspace id that was never registered at all.
    const neverRegistered = randomUUID();
    await expect(
      adminDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [fx.organisationId]);
        return schemaResolver.resolve(manager, neverRegistered);
      }),
    ).rejects.toThrow(WorkspaceRoutingError);
    expect(await isCached(neverRegistered)).toBe(false); // never cached

    // not-ready: a second, genuinely CREATING (never provisioned) workspace.
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `wsmeta-notready-${randomUUID()}`, slug: `wsmeta-notready-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    createdOrgIds.push(organisationId);
    const notReadyWorkspaceId = await adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      const passwordHash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const userResult = await manager.insert(User, {
        organisationId,
        email: `wsmeta-notready-${randomUUID()}@example.test`,
        passwordHash,
        firstName: 'NotReady',
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId,
        name: 'Not Ready Workspace',
        subdomain: `wsmeta-notready-${randomUUID().slice(0, 8)}`,
        status: 'active',
        schemaStatus: 'CREATING',
      });
      await manager.query(`SELECT core.begin_workspace_schema_attempt($1)`, [workspace.id]);
      await manager.query(`SELECT core.register_workspace_schema($1)`, [workspace.id]); // registry row exists, status PROVISIONING — never reaches READY
      return workspace.id as string;
    });
    createdWorkspaceIds.push(notReadyWorkspaceId);

    await expect(
      adminDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
        return schemaResolver.resolve(manager, notReadyWorkspaceId);
      }),
    ).rejects.toThrow(WorkspaceRoutingError);
    expect(await isCached(notReadyWorkspaceId)).toBe(false); // never cached — only the READY success path is ever cached
  });

  it('workspace isolation: resolving one workspace never populates or affects another\'s cache entry', async () => {
    const fxA = await seedReadyWorkspace('wsmeta-iso-a');
    const fxB = await seedReadyWorkspace('wsmeta-iso-b');

    await adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [fxA.organisationId]);
      return schemaResolver.resolve(manager, fxA.workspaceId);
    });

    expect(await isCached(fxA.workspaceId)).toBe(true);
    expect(await isCached(fxB.workspaceId)).toBe(false); // B was never resolved, never cached
  });

  it('PROOF (Phase 0B): the DEL-vs-concurrent-fill race is closed — a concurrent resolveSchema() that read the pre-invalidate epoch can never resurface a stale schema after invalidate() runs', async () => {
    const fx = await seedReadyWorkspace('wsmeta-race');

    // A slow "reader" starts resolveSchema() and stalls mid-fetch (modelling a concurrent request
    // whose own Postgres read is in flight when a hypothetical re-provisioning write commits and
    // invalidates below) — this is the exact race the original plain-DEL design was vulnerable to:
    // a reader that read the OLD state, suspended, then wrote back AFTER a DEL ran, with nothing
    // left to ever clear it again before its TTL.
    let resolveSlowFetch!: (v: { schemaName: string; schemaVersion: number }) => void;
    const slowFetchPromise = new Promise<{ schemaName: string; schemaVersion: number }>((resolve) => {
      resolveSlowFetch = resolve;
    });
    const readerPromise = workspaceMetadataCache.resolveSchema(fx.workspaceId, () => slowFetchPromise);
    await new Promise((r) => setTimeout(r, 50)); // let resolveSchema read the epoch and call fetch (now suspended)

    await workspaceMetadataCache.invalidate(fx.workspaceId); // the "write" commits and invalidates

    // The slow reader's fetch now resolves, carrying a STALE pre-write value — and writes it back.
    const staleSchemaName = workspaceSchemaName(fx.workspaceId);
    resolveSlowFetch({ schemaName: staleSchemaName, schemaVersion: 1 });
    await readerPromise; // the reader's own return value is correct for what IT saw — not a bug

    // The proof: a FRESH resolveSchema() call after the write must NEVER be served the stale
    // reader's write — it must re-fetch, because the epoch it now reads is the POST-invalidate one.
    let freshFetchCalls = 0;
    const freshResult = await workspaceMetadataCache.resolveSchema(fx.workspaceId, async () => {
      freshFetchCalls += 1;
      return { schemaName: staleSchemaName, schemaVersion: 1 };
    });
    expect(freshResult).toEqual({ schemaName: staleSchemaName, schemaVersion: 1 });
    expect(freshFetchCalls).toBe(1); // genuinely re-fetched — the stale reader's write never reached this lookup
  });
});

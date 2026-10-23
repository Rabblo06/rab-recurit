/**
 * Hyper Workspace Phase 3 — registry, SchemaResolver and WorkspaceExecutionContext against a real PostgreSQL database.
 *
 * Isolated TEST schemas only: workspace_<hex(A)> and workspace_<hex(B)> hold one probe table each. They are NOT
 * business schemas and no business table is routed here. Requires DATABASE_URL (crewflow, the runtime role since the
 * Crewflow single-credential cutover) and DATABASE_URL_UNPOOLED (owner).
 *
 * P2.2 fix (previously a KNOWN PRE-EXISTING GAP, found-not-fixed during P0 finalization's
 * grant-tightening regression pass — FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.9 Check A): this file's
 * `beforeAll` assumed `core.organisation`/`core.manager_workspace` rows for ORG_A/ORG_B/WS_A/WS_B
 * already existed from an external seed (`registry-tests.sql`, which does not exist anywhere in
 * this repo). On a genuinely from-scratch database this made `register_workspace_schema` fail with
 * `workspace not found`, confirmed by reproducing against a brand-new disposable Postgres container
 * with no accumulated ad-hoc rows. The WS_PENDING fixture two blocks below already seeds its own
 * `user`/`manager_workspace` rows correctly — this just applies that same, already-established
 * pattern to WS_A/WS_B (plus the `organisation` rows neither block was seeding at all).
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { WorkspaceMetadataCacheService } from '../../engine/core-modules/entity-cache/workspace-metadata-cache.service';
import { SchemaResolverService, WorkspaceRoutingError, workspaceSchemaName } from '../../engine/core-modules/tenant/schema-resolver.service';
import { WorkspaceExecutionContext } from '../../engine/core-modules/tenant/workspace-execution-context';

// Always a miss: this file exercises SchemaResolverService's real, uncached Postgres path exactly
// as before the Workspace Metadata Cache existed — caching itself is covered separately in
// workspace-metadata-cache.integration.spec.ts.
function noCacheStub(): WorkspaceMetadataCacheService {
  return { resolveSchema: async (_id: string, fetch: () => Promise<unknown>) => fetch() } as unknown as WorkspaceMetadataCacheService;
}

jest.setTimeout(120_000);

const ORG_A = 'a1a1a1a1-0000-4000-8000-00000000000a';
const ORG_B = 'b1b1b1b1-0000-4000-8000-00000000000b';
const WS_A = 'e1e1e1e1-0000-4000-8000-00000000000a';
const WS_B = 'e2e2e2e2-0000-4000-8000-00000000000b';
const WS_PENDING = 'e4e4e4e4-0000-4000-8000-00000000000d';
const USER_A = 'a2a2a2a2-0000-4000-8000-00000000000a';
const USER_B = 'b2b2b2b2-0000-4000-8000-00000000000b';
const SCHEMA_A = workspaceSchemaName(WS_A);
const SCHEMA_B = workspaceSchemaName(WS_B);

const ctxOf = (org: string, ws: string, user: string): AuthContext => ({
  organisationId: org, workspaceId: ws, userId: user, role: 'manager',
});

function appSource(max: number): DataSource {
  return new DataSource({
    type: 'postgres', url: process.env.DATABASE_URL, synchronize: false, entities: [], extra: { max },
  });
}

describe('Workspace registry, SchemaResolver and WorkspaceExecutionContext (integration)', () => {
  let owner: DataSource;
  let app: DataSource;
  let execCtx: WorkspaceExecutionContext;

  beforeAll(async () => {
    owner = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL_UNPOOLED, synchronize: false, entities: [], extra: { max: 1 } });
    await owner.initialize();
    app = appSource(1);
    await app.initialize();
    execCtx = new WorkspaceExecutionContext(app, new SchemaResolverService(noCacheStub()));

    // Backing organisation/user/manager_workspace rows for ORG_A/ORG_B/WS_A/WS_B/USER_A/USER_B — required by
    // manager_workspace's FKs (organisation_id -> organisation, owner_user_id -> user) and by
    // register_workspace_schema's own `workspace not found` check. See file header comment.
    await owner.query(
      `INSERT INTO core.organisation (id, name, slug) VALUES ($1, 'Org A', $2), ($3, 'Org B', $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_A, `org-a-${ORG_A}`, ORG_B, `org-b-${ORG_B}`],
    );
    await owner.query(
      `INSERT INTO core."user" (id, organisation_id, email, first_name, last_name)
       VALUES ($1, $2, 'owner-a@tenant.test', 'A', 'Owner'), ($3, $4, 'owner-b@tenant.test', 'B', 'Owner')
       ON CONFLICT (id) DO UPDATE SET organisation_id = EXCLUDED.organisation_id`,
      [USER_A, ORG_A, USER_B, ORG_B],
    );
    // schema_status = 'CREATING' — mark_workspace_schema_ready() requires this (or 'FAILED') before it
    // will accept the row into READY; it is NULL by default, same as a freshly-created real workspace
    // row before the provisioner starts (provisionWorkspaceSchema() sets this itself in production).
    // ON CONFLICT DO UPDATE (not DO NOTHING) so a leftover row from an earlier interrupted run — which
    // this file's own comments already acknowledge can happen — is reset to a known-good state rather
    // than silently keeping a stale schema_status from before, which would keep failing with the same
    // "workspace schema is NULL" error no matter how many times this suite re-runs.
    await owner.query(
      `INSERT INTO core.manager_workspace (id, organisation_id, owner_user_id, name, subdomain, schema_status)
       VALUES ($1, $2, $3, 'WS A', 'reg-ws-a', 'CREATING'), ($4, $5, $6, 'WS B', 'reg-ws-b', 'CREATING')
       ON CONFLICT (id) DO UPDATE SET organisation_id = EXCLUDED.organisation_id, owner_user_id = EXCLUDED.owner_user_id, schema_status = EXCLUDED.schema_status`,
      [WS_A, ORG_A, USER_A, WS_B, ORG_B, USER_B],
    );

    // Test-only physical schemas with a probe table, FORCE RLS and a schema-bound workspace CHECK.
    for (const [schema, ws, org, label] of [[SCHEMA_A, WS_A, ORG_A, 'A-row'], [SCHEMA_B, WS_B, ORG_B, 'B-row']] as const) {
      await owner.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION rab_owner`);
      await owner.query(`CREATE TABLE IF NOT EXISTS ${schema}.probe (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL, workspace_id uuid NOT NULL, label text NOT NULL,
        CONSTRAINT probe_bound CHECK (workspace_id = '${ws}'::uuid))`);
      await owner.query(`ALTER TABLE ${schema}.probe ENABLE ROW LEVEL SECURITY`);
      await owner.query(`ALTER TABLE ${schema}.probe FORCE ROW LEVEL SECURITY`);
      await owner.query(`DROP POLICY IF EXISTS probe_tenant ON ${schema}.probe`);
      await owner.query(`CREATE POLICY probe_tenant ON ${schema}.probe
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace())`);
      // crewflow_app, not just crewflow: DATABASE_URL (what appSource() connects as, below) has been
      // crewflow_app since the P2/P3 Checkpoint 2 restricted-runtime-role cutover
      // (CrewflowAppRestrictedRuntimeRole1786687000000 / WorkspaceSchemaCrewflowAppUsageGrant1786688000000).
      // Same class of bug the earlier rab_app-to-crewflow fix already caught once here: granting only
      // to a role the app no longer connects as leaves this test schema invisible to the real runtime
      // connection, confirmed by reproducing "relation probe does not exist" after the Checkpoint 2
      // cutover. crewflow's own grant is left in place (harmless; it's still the provisioning DDL role).
      await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO crewflow, crewflow_app`);
      await owner.query(`GRANT SELECT, INSERT, DELETE ON ${schema}.probe TO crewflow, crewflow_app`);
      await owner.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id',$1,true), set_config('rab.workspace_id',$2,true)`, [org, ws]);
        await m.query(`DELETE FROM ${schema}.probe`);
        await m.query(`INSERT INTO ${schema}.probe (organisation_id, workspace_id, label) VALUES ($1,$2,$3)`, [org, ws, label]);
      });
    }
    // Registry rows for these fixed test workspaces may survive earlier runs (or registry-tests.sql). Reset them first,
    // as the owner with the organisation bound (FORCE RLS), so the restricted functions start from PROVISIONING.
    for (const [org, ids] of [[ORG_A, [WS_A, WS_PENDING]], [ORG_B, [WS_B]]] as const) {
      await owner.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id',$1,true)`, [org]);
        await m.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = ANY($1::uuid[])`, [ids]);
      });
    }
    // Registry: register then mark READY through the restricted functions. these four functions
    // are now rab_owner-only (WorkspaceLifecycleGrantTightening1786677800000) — the real provisioner
    // (`provisionWorkspaceSchema()`) already ran on an owner connection before this migration; only
    // this fixture's bootstrap, which used to call them over the `rab_app` connection as a stand-in,
    // needed to move to `owner` to match.
    await owner.query(`SELECT core.register_workspace_schema($1)`, [WS_A]);
    await owner.query(`SELECT core.mark_workspace_schema_ready($1, 1)`, [WS_A]);
    await owner.query(`SELECT core.register_workspace_schema($1)`, [WS_B]);
    await owner.query(`SELECT core.mark_workspace_schema_ready($1, 1)`, [WS_B]);
    // A third, registered-but-not-provisioned workspace (PROVISIONING) for the not-ready test.
    await owner.query(`INSERT INTO core."user" (id, organisation_id, email, first_name, last_name)
      VALUES ('a7a7a7a7-0000-4000-8000-00000000000d', $1, 'owner-pending@tenant.test', 'P', 'D') ON CONFLICT DO NOTHING`, [ORG_A]);
    await owner.query(`INSERT INTO core.manager_workspace (id, organisation_id, owner_user_id, name, subdomain)
      VALUES ($1, $2, 'a7a7a7a7-0000-4000-8000-00000000000d', 'WS PENDING', 'reg-ws-pending') ON CONFLICT DO NOTHING`, [WS_PENDING, ORG_A]);
    await owner.query(`SELECT core.register_workspace_schema($1)`, [WS_PENDING]);
  });

  afterAll(async () => {
    await app?.destroy();
    // Test hygiene (F4, Wave 1 lane S): the two probe schemas match ^workspace_[0-9a-f]{32}$ but are not V1 workspaces (one
    // rab_owner-owned probe table). Left behind they are real drift for the workspace-aware posture snapshot and
    // check-rls-coverage. beforeAll recreates them (IF NOT EXISTS) on every run.
    for (const schema of [SCHEMA_A, SCHEMA_B]) await owner?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await owner?.destroy();
  });

  it('A context routes to its own schema and sees only its own probe row', async () => {
    const rows = await execCtx.run(ctxOf(ORG_A, WS_A, USER_A), (m) => m.query('SELECT label FROM probe'));
    expect(rows).toEqual([{ label: 'A-row' }]);
  });

  it('B context routes to its own schema and sees only B', async () => {
    const rows = await execCtx.run(ctxOf(ORG_B, WS_B, USER_B), (m) => m.query('SELECT label FROM probe'));
    expect(rows).toEqual([{ label: 'B-row' }]);
  });

  it('search_path is EXACTLY the trusted workspace schema (no core, no public)', async () => {
    const [{ search_path }] = await execCtx.run(ctxOf(ORG_A, WS_A, USER_A), (m) => m.query(`SHOW search_path`));
    expect(search_path).toBe(SCHEMA_A);
  });

  it('an explicit cross-schema query under A context returns no B rows (RLS holds with the schema bypassed)', async () => {
    const rows = await execCtx.run(ctxOf(ORG_A, WS_A, USER_A), (m) => m.query(`SELECT label FROM ${SCHEMA_B}.probe`));
    expect(rows).toEqual([]);
  });

  it('a missing context fails closed before any SQL', async () => {
    await expect(execCtx.run({ organisationId: null, workspaceId: null, userId: USER_A, role: 'manager' }, async () => 'x'))
      .rejects.toMatchObject({ code: 'missing-context' });
  });

  it('a non-UUID workspace value (client-shaped schema name) is refused', async () => {
    await expect(execCtx.run(ctxOf(ORG_A, `workspace_${SCHEMA_A}`, USER_A), async () => 'x')).rejects.toThrow();
  });

  it('an unknown workspace fails closed (registry-missing)', async () => {
    await expect(execCtx.run(ctxOf(ORG_A, '99999999-9999-4999-8999-999999999999', USER_A), async () => 'x'))
      .rejects.toMatchObject({ code: 'registry-missing' });
  });

  it('a workspace in the registry but not READY is refused (not-ready)', async () => {
    const r = await owner.query(`SELECT core.register_workspace_schema($1) AS name`, [WS_PENDING]).catch((e) => e);
    if (r instanceof Error) {
      // The pending workspace must exist in manager_workspace; if the seed user is absent this is a seed issue, not routing.
      throw new Error(`seed: pending workspace not registrable: ${r.message}`);
    }
    await expect(execCtx.run(ctxOf(ORG_A, WS_PENDING, USER_A), async () => 'x'))
      .rejects.toMatchObject({ code: 'not-ready' });
  });

  it('an unsupported schema version is refused (unsupported-version), then restored', async () => {
    // WS_A is already READY, so the restricted function cannot move it again. Set the version as the owner (test-only).
    const setVersion = (v: number) => owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id',$1,true)`, [ORG_A]);
      await m.query(`UPDATE core.workspace_schema_registry SET schema_version = $2 WHERE workspace_id = $1`, [WS_A, v]);
    });
    await setVersion(2);
    try {
      await expect(execCtx.run(ctxOf(ORG_A, WS_A, USER_A), async () => 'x'))
        .rejects.toMatchObject({ code: 'unsupported-version' });
    } finally {
      await setVersion(1);
    }
    const rows = await execCtx.run(ctxOf(ORG_A, WS_A, USER_A), (m) => m.query('SELECT count(*)::int AS n FROM probe'));
    expect(rows[0].n).toBe(1);
  });

  it('a routing refusal is an instance of WorkspaceRoutingError', async () => {
    const err = await execCtx.run(ctxOf(ORG_A, '99999999-9999-4999-8999-999999999999', USER_A), async () => 'x').catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceRoutingError);
  });

  describe.each([1, 2, 5, 10])('pool max=%i', (max) => {
    let pool: DataSource;
    let ctx: WorkspaceExecutionContext;
    beforeAll(async () => {
      pool = appSource(max);
      await pool.initialize();
      ctx = new WorkspaceExecutionContext(pool, new SchemaResolverService(noCacheStub()));
    });
    afterAll(async () => { await pool.destroy(); });

    const routingState = async () => {
      const [s] = await pool.query(`SELECT current_setting('search_path') AS sp,
        coalesce(current_setting('rab.organisation_id', true),'') AS o, coalesce(current_setting('rab.workspace_id', true),'') AS w,
        coalesce(current_setting('rab.user_id', true),'') AS u, coalesce(current_setting('rab.role', true),'') AS r`);
      return s as { sp: string; o: string; w: string; u: string; r: string };
    };
    const clean = (s: { sp: string; o: string; w: string; u: string; r: string }) =>
      s.o === '' && s.w === '' && s.u === '' && s.r === '' && !s.sp.includes('workspace_');

    it('concurrent A and B operations never cross schema, organisation, workspace, user or role', async () => {
      type Tag = 'A' | 'B';
      const jobs: Array<{ tag: Tag; c: AuthContext }> = Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? { tag: 'A' as Tag, c: ctxOf(ORG_A, WS_A, USER_A) } : { tag: 'B' as Tag, c: ctxOf(ORG_B, WS_B, USER_B) }));
      const results = await Promise.all(jobs.map(({ tag, c }) => ctx.run(c, async (m) => {
        const [v] = await m.query(`SELECT label, current_setting('rab.workspace_id') AS w, current_setting('rab.user_id') AS u, current_setting('search_path') AS sp FROM probe`);
        return { tag, label: v.label as string, w: v.w as string, u: v.u as string, sp: v.sp as string };
      })));
      for (const r of results) {
        expect(r.label).toBe(`${r.tag}-row`);
        expect(r.w).toBe(r.tag === 'A' ? WS_A : WS_B);
        expect(r.u).toBe(r.tag === 'A' ? USER_A : USER_B);
        expect(r.sp).toBe(r.tag === 'A' ? SCHEMA_A : SCHEMA_B);
      }
      expect(clean(await routingState())).toBe(true);
    });

    it('commit, rollback, application exception, SQL error and statement timeout leave no routing state', async () => {
      await ctx.run(ctxOf(ORG_A, WS_A, USER_A), async (m) => m.query('SELECT 1'));
      expect(clean(await routingState())).toBe(true);

      await expect(ctx.run(ctxOf(ORG_A, WS_A, USER_A), async () => { throw new Error('app failure'); })).rejects.toThrow('app failure');
      expect(clean(await routingState())).toBe(true);

      await expect(ctx.run(ctxOf(ORG_A, WS_A, USER_A), async (m) => m.query('SELECT * FROM no_such_table_zz'))).rejects.toThrow();
      expect(clean(await routingState())).toBe(true);

      await expect(ctx.run(ctxOf(ORG_A, WS_A, USER_A), async (m) => {
        await m.query(`SET LOCAL statement_timeout = '100ms'`);
        await m.query('SELECT pg_sleep(1)');
      })).rejects.toThrow(/statement timeout/);
      expect(clean(await routingState())).toBe(true);
    });
  });
});

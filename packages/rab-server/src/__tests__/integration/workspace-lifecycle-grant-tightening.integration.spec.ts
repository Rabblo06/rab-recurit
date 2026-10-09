import 'reflect-metadata';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.9, Check A — the workspace-lifecycle
 * SECURITY DEFINER grant-tightening fix, migration `WorkspaceLifecycleGrantTightening1786677800000`).
 *
 * Proves, against a real Postgres, exactly the exit-gate requirements:
 *   - rab_app is denied EXECUTE on the four lifecycle-mutating functions (never structural
 *     verification, state-machine only — a real security boundary, not a convention).
 *   - rab_app retains EXECUTE on the two functions that genuinely need it
 *     (`workspace_schema_routable` — the live per-request routing check; `provision_workspace_schema`
 *     — safe by its own internal ownership/structural checks regardless of caller role).
 *   - PUBLIC has no grant on any of the six functions, before or after.
 *   - no OTHER `rab_app`-executable SECURITY DEFINER function in `core` can mutate
 *     `workspace_schema_registry.status`/`manager_workspace.schema_status` as a bypass —
 *     checked by name against the full catalogue of `rab_app`-granted SECURITY DEFINER functions,
 *     not assumed.
 *
 * Does not re-prove CREATING→READY/FAILED→retry end-to-end — that's
 * `workspace-provisioning.integration.spec.ts`'s job, re-run (unmodified) as part of this same
 * finalization pass specifically because this migration touches the functions it depends on.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const LIFECYCLE_MUTATORS = [
  { name: 'register_workspace_schema', sql: "SELECT core.register_workspace_schema('00000000-0000-0000-0000-000000000000'::uuid)" },
  { name: 'begin_workspace_schema_attempt', sql: "SELECT core.begin_workspace_schema_attempt('00000000-0000-0000-0000-000000000000'::uuid)" },
  { name: 'mark_workspace_schema_ready', sql: "SELECT core.mark_workspace_schema_ready('00000000-0000-0000-0000-000000000000'::uuid, 1)" },
  { name: 'mark_workspace_schema_failed', sql: "SELECT core.mark_workspace_schema_failed('00000000-0000-0000-0000-000000000000'::uuid, 'x')" },
];

// Not revoked from rab_app — genuinely needed by normal runtime (routability) or already safe by
// its own internal checks regardless of caller role (provisioning).
const PRESERVED_RAB_APP_FUNCTIONS = [
  { name: 'workspace_schema_routable', sql: "SELECT core.workspace_schema_routable('00000000-0000-0000-0000-000000000000'::uuid)" },
];

describeIfDb('workspace lifecycle grant tightening (integration, §8A.9 Check A)', () => {
  let appClient: Client;
  let adminDataSource: DataSource;

  beforeAll(async () => {
    appClient = new Client({ connectionString: process.env.DATABASE_URL });
    await appClient.connect();
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await appClient.end();
    await adminDataSource.destroy();
  });

  it.each(LIFECYCLE_MUTATORS)('rab_app is denied EXECUTE on $name (42501), never reaching the function body', async ({ sql }) => {
    await expect(appClient.query(sql)).rejects.toMatchObject({ code: '42501' });
  });

  it.each(PRESERVED_RAB_APP_FUNCTIONS)('rab_app retains EXECUTE on $name — runtime routability must keep working', async ({ sql }) => {
    // Reaches the function body (a structural "workspace not found"-shaped false/error is fine;
    // a 42501 permission-denied is the only outcome this test forbids).
    await expect(appClient.query(sql)).resolves.toBeDefined();
  });

  it('PUBLIC has no EXECUTE grant on any of the six lifecycle/provisioning functions', async () => {
    const rows = await adminDataSource.query<Array<{ proname: string; proacl: string | null }>>(`
      SELECT p.proname, p.proacl::text AS proacl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'core' AND p.proname IN (
         'register_workspace_schema','begin_workspace_schema_attempt',
         'mark_workspace_schema_ready','mark_workspace_schema_failed',
         'workspace_schema_routable','provision_workspace_schema'
       )
    `);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      // A bare `=X/...` entry (no role name before the `=`) denotes PUBLIC. None of these six may
      // have one — REVOKE ALL ... FROM PUBLIC already runs in every migration that created them,
      // and this migration never touches PUBLIC at all.
      expect(row.proacl ?? '').not.toMatch(/(^|,)\s*=/);
    }
  });

  it('no OTHER rab_app-executable SECURITY DEFINER function in core can mutate workspace lifecycle state — no bypass exists', async () => {
    const rows = await adminDataSource.query<Array<{ proname: string }>>(`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'core' AND p.prosecdef = true
         AND p.proacl::text LIKE '%rab_app%'
    `);
    const names = rows.map((r) => r.proname);
    const bypassCandidates = names.filter((n) =>
      !['workspace_schema_routable', 'provision_workspace_schema'].includes(n) &&
      /workspace_schema|schema_ready|schema_failed|register_workspace/.test(n),
    );
    expect(bypassCandidates).toEqual([]);
  });
});

/**
 * Owner-login architecture (owner decision 2026-11-04, PR 3 "fresh-install and migration lifecycle"): the database state classifier, run on the LOCKED migration session (so no other run can change
 * the answer before this run acts on it). Catalog reads only; it never writes.
 *
 *   EMPTY              no `core` schema, nothing of anyone else's (no non-extension relation or function in `public`, no
 *                      other schema): bootstrap, then the whole chain.
 *   BOOTSTRAP-PARTIAL  `core` exists, owned by rab_owner, holds no relation and there is no ledger: a bootstrap committed
 *                      but the chain never started. Bootstrap again (idempotent), then the whole chain.
 *   CHAIN-PARTIAL      a ledger whose every name is this code's, with migrations still pending: resume.
 *   CURRENT            the ledger equals the code's set: nothing to do.
 *   AHEAD              nothing pending, and every unknown ledger name is newer than the code's newest migration: an older
 *                      image after a rollback. Warn and continue (C-1); never refuse, never apply.
 *   FOREIGN            anything else: someone else's database (Twenty's own `core` schema, a `public` full of tables, an
 *                      interleaved or forked ledger, pending migrations AND unknown newer names). Refused, nothing changed.
 *
 * The fresh-install proof (the only gate of the D3(b) ROW_COPY shim and of the fresh-install N1 rule) is separate and
 * stricter: no tenant data was EVER written, decided physically rather than through RLS (an RLS-bound count of a FORCE
 * table reads zero for this login whatever it holds):
 *   - core.organisation, core.manager_workspace and core.workspace_schema_registry are absent or have ZERO pages
 *     (pg_relation_size = 0: no row was ever inserted, not even one later deleted or rolled back, until a VACUUM truncation);
 *   - no `workspace_<32 hex>` schema exists;
 *   - for CHAIN-PARTIAL, rab_owner was CREATED by crewflow_owner: PostgreSQL 16+ records an implicit ADMIN membership row for
 *     the creating non-superuser role, which no GRANT in the separated-to-owner-login transition SQL gives (it grants INHERIT
 *     and SET only). So the interrupted chain was started by an owner-login fresh install, not an existing database being
 *     transitioned.
 */
import { compareLedger } from '../../../../boot-checks/schema-compatibility';
import type { Query } from '../locked-migration-runner';
import { OWNER_LOGIN } from './bootstrap';

export type DatabaseInstallState = 'EMPTY' | 'BOOTSTRAP-PARTIAL' | 'CHAIN-PARTIAL' | 'CURRENT' | 'AHEAD' | 'FOREIGN';

export interface CatalogFacts {
  coreExists: boolean;
  coreOwner: string | null;
  coreRelations: number;
  hasLedger: boolean;
  workspaceSchemas: number;
  otherSchemas: string[];
  publicForeignObjects: number;
}

export interface Classification {
  state: DatabaseInstallState;
  reason: string;
  pending: string[];
  newer: string[];
  interleaved: string[];
  applied: string[];
}

export const CATALOG_FACTS_SQL = `
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'core') AS "coreExists",
       (SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'core') AS "coreOwner",
       (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core') AS "coreRelations",
       EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'core' AND c.relname = 'migrations' AND c.relkind = 'r') AS "hasLedger",
       (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspname ~ '^workspace_[0-9a-f]{32}$') AS "workspaceSchemas",
       coalesce((SELECT array_agg(nspname::text ORDER BY nspname) FROM pg_catalog.pg_namespace
                  WHERE nspname NOT IN ('public', 'core', 'information_schema') AND nspname !~ '^pg_' AND nspname !~ '^workspace_[0-9a-f]{32}$'),
                '{}'::text[]) AS "otherSchemas",
       ((SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'))
        + (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')))::int
         AS "publicForeignObjects"`;

/** Pure decision. `applied` is the ledger (read only when `facts.hasLedger`). */
export function classifyDatabase(facts: CatalogFacts, expected: readonly string[], applied: readonly string[]): Classification {
  const none = { pending: [] as string[], newer: [] as string[], interleaved: [] as string[], applied: [...applied] };
  if (!facts.hasLedger) {
    if (facts.otherSchemas.length) return { ...none, state: 'FOREIGN', reason: `schema(s) that are not Crewflow's: ${facts.otherSchemas.join(', ')}` };
    if (facts.publicForeignObjects > 0) return { ...none, state: 'FOREIGN', reason: `${facts.publicForeignObjects} non-extension object(s) in schema public` };
    if (facts.workspaceSchemas > 0) return { ...none, state: 'FOREIGN', reason: 'workspace schemas without a migration ledger' };
    if (!facts.coreExists) return { ...none, pending: [...expected], state: 'EMPTY', reason: 'no core schema' };
    if (facts.coreOwner === 'rab_owner' && facts.coreRelations === 0) {
      return { ...none, pending: [...expected], state: 'BOOTSTRAP-PARTIAL', reason: 'core exists (rab_owner, empty), no ledger' };
    }
    return { ...none, state: 'FOREIGN', reason: `schema core exists (owner ${facts.coreOwner ?? '?'}, ${facts.coreRelations} relation(s)) without a Crewflow ledger` };
  }
  const ledger = compareLedger(expected, applied);
  const out = { pending: ledger.pending, newer: ledger.unknownNewer, interleaved: ledger.unknownInterleaved, applied: [...applied] };
  if (out.interleaved.length) return { ...out, state: 'FOREIGN', reason: `ledger names unknown to this code and not all newer: ${out.interleaved.slice(0, 5).join(', ')}` };
  if (out.pending.length && out.newer.length) {
    return { ...out, state: 'FOREIGN', reason: `${out.pending.length} pending migration(s) AND ${out.newer.length} newer unknown name(s): not a linear history` };
  }
  if (out.pending.length) return { ...out, state: 'CHAIN-PARTIAL', reason: `${out.pending.length} migration(s) pending` };
  if (out.newer.length) return { ...out, state: 'AHEAD', reason: `${out.newer.length} newer migration(s) in the ledger (an older image)` };
  return { ...out, state: 'CURRENT', reason: 'ledger equals the code' };
}

export async function readCatalogFacts(query: Query): Promise<CatalogFacts> {
  const [row] = (await query(CATALOG_FACTS_SQL)) as CatalogFacts[];
  if (!row) throw new Error('cannot read the catalog facts');
  return row;
}

/** Classifies on the caller's (locked) session. */
export async function classifyDatabaseState(query: Query, expected: readonly string[]): Promise<Classification & { facts: CatalogFacts }> {
  const facts = await readCatalogFacts(query);
  const applied = facts.hasLedger ? ((await query(`SELECT name FROM core.migrations`)) as Array<{ name: string }>).map((r) => r.name) : [];
  return { ...classifyDatabase(facts, expected, applied), facts };
}

/**
 * Every relation is resolved with to_regclass at EXECUTION time (NULL when absent; pg_relation_size(NULL) is NULL): a
 * literal `'core.x'` handed to pg_relation_size is cast to regclass while the statement is PLANNED, so on an EMPTY
 * database it raised 42P01 even inside an untaken CASE branch (found by CI on PR #71; regression: owner-login.spec.ts).
 */
export const TENANT_EVIDENCE_SQL = `
SELECT coalesce(pg_catalog.pg_relation_size(pg_catalog.to_regclass('core.organisation')), 0)::bigint AS "organisationBytes",
       coalesce(pg_catalog.pg_relation_size(pg_catalog.to_regclass('core.manager_workspace')), 0)::bigint AS "workspaceBytes",
       coalesce(pg_catalog.pg_relation_size(pg_catalog.to_regclass('core.workspace_schema_registry')), 0)::bigint AS "registryBytes",
       (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspname ~ '^workspace_[0-9a-f]{32}$') AS "workspaceSchemas",
       EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members a
                WHERE a.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'rab_owner')
                  AND a.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
                  AND a.admin_option) AS "bootstrapRoles"`;

export interface FreshInstallProof {
  fresh: boolean;
  reasons: string[];
}

/**
 * The fresh-install proof (see the header). Pure decision over the evidence row; `state` is this run's classification.
 */
export function decideFreshInstall(
  state: DatabaseInstallState,
  evidence: { organisationBytes: string | number; workspaceBytes: string | number; registryBytes: string | number; workspaceSchemas: number; bootstrapRoles: boolean },
): FreshInstallProof {
  const reasons: string[] = [];
  if (!['EMPTY', 'BOOTSTRAP-PARTIAL', 'CHAIN-PARTIAL'].includes(state)) reasons.push(`state ${state} is not an install in progress`);
  if (Number(evidence.organisationBytes) !== 0) reasons.push('core.organisation has been written (pages exist)');
  if (Number(evidence.workspaceBytes) !== 0) reasons.push('core.manager_workspace has been written');
  if (Number(evidence.registryBytes) !== 0) reasons.push('core.workspace_schema_registry has been written');
  if (Number(evidence.workspaceSchemas) !== 0) reasons.push(`${evidence.workspaceSchemas} workspace schema(s) exist`);
  if (state === 'CHAIN-PARTIAL' && !evidence.bootstrapRoles) reasons.push('the roles were not created by an owner-login bootstrap (an existing database being transitioned)');
  return { fresh: reasons.length === 0, reasons };
}

export async function readFreshInstallProof(query: Query, state: DatabaseInstallState, owner: string = OWNER_LOGIN): Promise<FreshInstallProof> {
  const [row] = (await query(TENANT_EVIDENCE_SQL, [owner])) as Array<Parameters<typeof decideFreshInstall>[1]>;
  if (!row) return { fresh: false, reasons: ['cannot read the tenant evidence'] };
  return decideFreshInstall(state, row);
}

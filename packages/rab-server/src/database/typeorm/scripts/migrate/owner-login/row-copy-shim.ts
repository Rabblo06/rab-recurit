/**
 * Owner-login architecture, owner decision D3(b) (SECURITY TRADE-OFF ST-1): the fresh-install-only ROW_COPY shim.
 *
 * Three historical migrations cannot run under a non-SUPERUSER, non-BYPASSRLS login even on an EMPTY database (M0 B2,
 * VERIFIED): 1786719520000's guard requires SUPERUSER or BYPASSRLS before it looks at a row, and 1786720960000 /
 * 1786720990000 run `SET LOCAL row_security = off` then touch a FORCE-RLS table, which PostgreSQL refuses at plan time for
 * such a login. `crewflow_owner` can never obtain BYPASSRLS. So, and ONLY when the runner has proven a fresh install under
 * the migration lock (fresh-install.ts readFreshInstallProof), the runner executes these three migrations through this
 * shim instead of directly. Migration source is never edited; the ledger rows are written by TypeORM exactly as for any
 * other migration, in the same transaction as the (substituted) body. Nothing else is ever skipped or substituted: the
 * table below is closed, and the proxy refuses any statement sequence it does not expect.
 *
 * Substitutions (each "proof" runs on the same locked session, inside the migration's own transaction):
 *
 *   HwsHistoricalRowsPrivilegedCopy1786719520000  RECORDED, body not run. On an empty database it is a guard followed by a
 *     loop over zero READY workspaces (privileged-copy.ts). Proof instead of the guard:
 *       SELECT pg_relation_size('core.manager_workspace') = 0 AND pg_relation_size('core.workspace_schema_registry') = 0
 *              AND no workspace_<32 hex> schema exists
 *     i.e. no workspace row was ever written, so its loop provably has nothing to copy. Then TypeORM records it.
 *
 *   AiActionProposalActivate1786720960000  up() runs unchanged except its one row check:
 *       original  SET LOCAL row_security = off;
 *                 SELECT count(*)::int AS n FROM core.ai_action_proposal ;
 *                 SET LOCAL row_security = on;
 *       shim      SELECT pg_relation_size('core.ai_action_proposal'::regclass) AS bytes   -- must be 0, else refuse
 *                 SELECT count(*)::int AS n FROM core.ai_action_proposal                  -- unchanged, RLS-bound (row_security stays on)
 *                 SET LOCAL row_security = on                                             -- unchanged (a no-op)
 *
 *   AiAssistantRoundOnly1786720990000  up() runs unchanged except its two row windows:
 *       original  SET LOCAL row_security = off;
 *                 UPDATE core.organisation_ai_assistant SET shape = 'circle' WHERE shape <> 'circle';
 *                 SET LOCAL row_security = on;
 *       shim      SELECT pg_relation_size('core.organisation_ai_assistant'::regclass) AS bytes   -- must be 0
 *                 UPDATE core.organisation_ai_assistant SET shape = 'circle' WHERE shape <> 'circle'   -- unchanged, RLS-bound
 *                 SET LOCAL row_security = on
 *     and in assertShapeCheck():
 *       original  SET LOCAL row_security = off;
 *                 SELECT count(*)::int AS n FROM core.organisation_ai_assistant WHERE shape <> ALL($1::text[]);
 *                 SET LOCAL row_security = on;
 *       shim      SELECT pg_relation_size(...) AS bytes   -- must be 0
 *                 the same SELECT, unchanged, RLS-bound
 *                 SET LOCAL row_security = on
 *
 * Why this is equivalent on a fresh install: `row_security = off` only changes which ROWS a statement sees; it changes no
 * DDL. A table with zero pages has no row at all (visible or not, committed or not), so the RLS-bound statement sees and
 * changes exactly what the original would: nothing. The original's fail-closed intent ("an RLS-subject role gets an error
 * instead of a silently filtered zero") is kept by the physical proof, which is independent of RLS and refuses on ANY page.
 * Every DDL statement, post-condition (verify(), assertTenantTablePosture) and ledger row runs unchanged. The resulting
 * schema is proven equal to the superuser-run chain on PostgreSQL 16 and 18 (migration-security-check.ts, scenario owner-login).
 */
import type { QueryRunner } from 'typeorm';

export const PRIVILEGED_COPY_MIGRATION = 'HwsHistoricalRowsPrivilegedCopy1786719520000';
export const AI_PROPOSAL_ACTIVATE_MIGRATION = 'AiActionProposalActivate1786720960000';
export const AI_ASSISTANT_ROUND_ONLY_MIGRATION = 'AiAssistantRoundOnly1786720990000';

export class RowCopyShimRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowCopyShimRefusal';
  }
}

/** One `row_security = off` window: the table whose emptiness is proven, and the exact statement allowed inside it. */
export interface ShimWindow {
  table: string;
  statement: string;
}

export const ROW_SECURITY_OFF = 'SET LOCAL row_security = off';
export const ROW_SECURITY_ON = 'SET LOCAL row_security = on';

/** The closed substitution table. Statements are compared with whitespace collapsed and trimmed. */
export const SHIM_WINDOWS: Readonly<Record<string, readonly ShimWindow[]>> = {
  [AI_PROPOSAL_ACTIVATE_MIGRATION]: [{ table: 'core.ai_action_proposal', statement: 'SELECT count(*)::int AS n FROM core.ai_action_proposal' }],
  [AI_ASSISTANT_ROUND_ONLY_MIGRATION]: [
    { table: 'core.organisation_ai_assistant', statement: "UPDATE core.organisation_ai_assistant SET shape = 'circle' WHERE shape <> 'circle'" },
    { table: 'core.organisation_ai_assistant', statement: 'SELECT count(*)::int AS n FROM core.organisation_ai_assistant WHERE shape <> ALL($1::text[])' },
  ],
};

/** The migrations the shim handles: exactly these three, nothing else (no arbitrary skipping). */
export const SHIMMED_MIGRATIONS: readonly string[] = [PRIVILEGED_COPY_MIGRATION, AI_PROPOSAL_ACTIVATE_MIGRATION, AI_ASSISTANT_ROUND_ONLY_MIGRATION];

export const RECORD_ONLY_PROOF_SQL = `
SELECT pg_catalog.pg_relation_size('core.manager_workspace'::regclass)::bigint AS "workspaceBytes",
       pg_catalog.pg_relation_size('core.workspace_schema_registry'::regclass)::bigint AS "registryBytes",
       (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspname ~ '^workspace_[0-9a-f]{32}$') AS "workspaceSchemas"`;

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function assertTableNeverWritten(runner: QueryRunner, table: string, migration: string): Promise<void> {
  const [row] = (await runner.query(`SELECT pg_catalog.pg_relation_size($1::regclass)::bigint AS "bytes"`, [table])) as Array<{ bytes: string | number }>;
  if (!row || Number(row.bytes) !== 0) {
    throw new RowCopyShimRefusal(`${migration}: ${table} has data pages, so this is not a fresh install. The ROW_COPY shim refuses; nothing was applied.`);
  }
}

/**
 * A QueryRunner proxy for ONE run of a shimmed migration's up(): every query passes through unchanged, except the exact
 * `row_security = off` windows of SHIM_WINDOWS[migration], replaced as described in the header. `finish()` asserts every
 * window was consumed (the migration's structure is the reviewed one).
 */
export function shimQueryRunner(runner: QueryRunner, migration: string): { runner: QueryRunner; finish: () => void } {
  const windows = SHIM_WINDOWS[migration];
  if (!windows) throw new RowCopyShimRefusal(`${migration} is not in the ROW_COPY shim table. Refusing.`);
  let next = 0;
  let open: ShimWindow | null = null;
  let stage: 'closed' | 'await-statement' | 'await-on' = 'closed';

  const query = async (sql: string, parameters?: unknown[], ...rest: unknown[]) => {
    const text = collapse(String(sql));
    if (stage === 'closed') {
      if (text === ROW_SECURITY_OFF) {
        open = windows[next] ?? null;
        if (!open) throw new RowCopyShimRefusal(`${migration}: an unexpected extra row_security window. Refusing.`);
        await assertTableNeverWritten(runner, open.table, migration);
        stage = 'await-statement';
        return [];
      }
      if (/row_security/i.test(text)) throw new RowCopyShimRefusal(`${migration}: an unreviewed row_security statement. Refusing.`);
      return (runner.query as (...a: unknown[]) => Promise<unknown>)(sql, parameters, ...rest);
    }
    if (stage === 'await-statement') {
      if (text !== collapse(open!.statement)) throw new RowCopyShimRefusal(`${migration}: an unreviewed statement inside a row_security window. Refusing.`);
      stage = 'await-on';
      return (runner.query as (...a: unknown[]) => Promise<unknown>)(sql, parameters, ...rest);
    }
    if (text !== ROW_SECURITY_ON) throw new RowCopyShimRefusal(`${migration}: a row_security window was not closed as reviewed. Refusing.`);
    stage = 'closed';
    open = null;
    next += 1;
    return (runner.query as (...a: unknown[]) => Promise<unknown>)(sql, parameters, ...rest);
  };

  const proxy = new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === 'query') return query;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    runner: proxy,
    finish: () => {
      if (stage !== 'closed' || next !== windows.length) {
        throw new RowCopyShimRefusal(`${migration}: ${next} of ${windows.length} reviewed row_security window(s) ran. Refusing to record it.`);
      }
    },
  };
}

/** The record-only proof for 1786719520000 (see the header). Throws RowCopyShimRefusal unless no workspace was ever written. */
export async function assertPrivilegedCopyIsNoOp(runner: QueryRunner): Promise<void> {
  const [row] = (await runner.query(RECORD_ONLY_PROOF_SQL)) as Array<{ workspaceBytes: string | number; registryBytes: string | number; workspaceSchemas: number }>;
  if (!row || Number(row.workspaceBytes) !== 0 || Number(row.registryBytes) !== 0 || Number(row.workspaceSchemas) !== 0) {
    throw new RowCopyShimRefusal(`${PRIVILEGED_COPY_MIGRATION}: workspace data exists, so its copy is not a provable no-op. The ROW_COPY shim refuses.`);
  }
}

interface MigrationLike {
  up(runner: QueryRunner): Promise<unknown>;
  down(runner: QueryRunner): Promise<unknown>;
  name?: string;
  transaction?: boolean;
}

/**
 * Wraps a loaded migration instance for the shim. The wrapper keeps the original's name and transaction mode; down() is
 * refused (a shimmed fresh install is never reverted through the shim).
 */
export function shimMigrationInstance<T extends MigrationLike>(migration: string, instance: T): MigrationLike {
  if (!SHIMMED_MIGRATIONS.includes(migration)) throw new RowCopyShimRefusal(`${migration} is not shimmed. Refusing.`);
  const wrapper: MigrationLike = {
    name: instance.name ?? migration,
    transaction: instance.transaction,
    async up(runner: QueryRunner) {
      if (migration === PRIVILEGED_COPY_MIGRATION) {
        await assertPrivilegedCopyIsNoOp(runner);
        return;
      }
      const shim = shimQueryRunner(runner, migration);
      await instance.up(shim.runner);
      shim.finish();
    },
    async down() {
      throw new RowCopyShimRefusal(`${migration}: down() is not available through the ROW_COPY shim.`);
    },
  };
  return wrapper;
}

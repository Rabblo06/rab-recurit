import { createHash } from 'node:crypto';

/**
 * Phase D unit-test fakes (no database): a TenantContextService stand-in that records the bound context and every
 * statement issued inside it, and a scripted responder. Used by the dispatcher specs to prove (a) per_scope mode issues
 * byte-for-byte the pre-Phase-D SQL and (b) global mode runs the SAME scoped transaction restricted to the claimed ids.
 */
export interface RecordedStatement {
  sql: string;
  params: unknown[];
  /** Index of the scoped transaction the statement ran in (-1 = outside any transaction, e.g. a catalogue call). */
  tx: number;
}

export interface BoundContext {
  organisationId: string;
  workspaceId: string | null;
  userId: string;
  role: string;
  actorType?: string;
}

export type Responder = (sql: string, params: unknown[]) => unknown;

export function fakeTenant(respond: Responder) {
  const statements: RecordedStatement[] = [];
  const contexts: BoundContext[] = [];
  const tenant = {
    runInTenantContext: async <T>(ctx: BoundContext, fn: (manager: unknown) => Promise<T>): Promise<T> => {
      const tx = contexts.length;
      contexts.push(ctx);
      const manager = {
        query: async (sql: string, params: unknown[] = []) => {
          statements.push({ sql, params, tx });
          return respond(sql, params);
        },
      };
      return fn(manager);
    },
  };
  const dataSource = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params, tx: -1 });
      return respond(sql, params);
    },
    /** Unscoped catalogue transaction (workspace discovery pages): recorded with tx = -2. */
    transaction: async <T>(fn: (manager: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          statements.push({ sql, params, tx: -2 });
          return respond(sql, params);
        },
      }),
  };
  return { tenant, dataSource, statements, contexts };
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * sha256 of the per-scope claim SQL at main 3654d0b8 (before Phase D), extracted from the HEAD sources with the
 * interpolated constants substituted (PROCESSING 10 min, RETRY 5 min, statement lease 10 min / max attempts 5 / backoff
 * 1 min). Any byte change to a per_scope-mode statement fails the spec that compares against these.
 */
export const PRE_PHASE_D_SQL_SHA256 = Object.freeze({
  emailClaim: '8e81da1a3a857c10dc0ac60d11387dca01ae9a06a579b0d0bbbcf8be757e54ef',
  /**
   * Push claim: 3654d0b8 was 9d3a98da579f7f92837be5ff8bf027258ba19fcf6d997fa882668cee3a9e690e. Changed ON PURPOSE by the
   * lead-requested stale-PENDING fix (select list + `dispatch_generation, queued_at, stale_pending`; WHERE / ORDER /
   * LIMIT / locking unchanged) — see push-dispatch.job.ts PENDING_STALE_MINUTES.
   */
  pushClaim: '806c1be49970cbe12910849ab21629f7bad33bb8f66b08869bccc4cddc7f12c2',
  realtimeClaim: 'b49c95061a63adb2cfc1238e62e5a298643614acb6499b8b882af05601822292',
  statementScan: '13fda1b75bbfd058220d2935b2d714598f6fe7f56a2b9a2e7a31f4589a17466c',
  statementCas: '53b4ec6e8767d72927523b8102a4b7eb72cb3f631244c72f779988e81c441f82',
});

/** Organisation catalogue pages for `organisationIds()`: one page of the given ids, then the empty page that ends it. */
export function catalogue(orgs: string[]): Responder {
  let served = false;
  return (sql) => {
    if (!sql.includes('worker_list_organisations')) return undefined;
    if (served) return [];
    served = true;
    return orgs.map((organisation_id) => ({ organisation_id }));
  };
}

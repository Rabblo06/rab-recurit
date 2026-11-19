import { Client, ClientConfig } from 'pg';

/**
 * Transaction pooler support (owner instruction 2026-11-19, "Pooler like Twenty, only if it's safe"): the pg Client used by
 * the ONE pool that may sit behind a transaction-mode pooler (PgBouncer pool_mode=transaction, Supavisor, RDS Proxy, ...):
 * the API / Worker runtime pool, and only when PG_DATABASE_SESSION_URL names a separate direct connection (pg-config.ts).
 *
 * WHY. Behind a transaction pooler a client connection is NOT a database session: every transaction (and every statement
 * outside one) may run on a different server backend, shared with every other client of the pooler. Two things the runtime
 * relied on are session-level and therefore lost or, worse, shared:
 *   1. the startup `-c` settings (statement_timeout, idle_in_transaction_session_timeout, default_transaction_read_only):
 *      a pooler drops or refuses them (PgBouncer refuses the `options` startup parameter by default);
 *   2. the checkout `RESET ROLE` (session-role-reset.ts): it runs as its own statement, so the pooler may run it on one
 *      backend and the caller's next statement on another. A backend poisoned by a session-level `SET ROLE
 *      rab_secure_owner` (G-09) would then serve a later statement of ANY client as the owner role.
 *
 * WHAT THIS CLIENT GUARANTEES, structurally (every statement goes through `query`):
 *   - every statement runs inside a transaction, and the FIRST statement of every transaction is the preamble below.
 *     A transaction the caller opens (BEGIN / START TRANSACTION) gets the preamble right before its first real statement
 *     (after any `SET TRANSACTION ...`, which must come first). A statement sent outside a transaction is wrapped:
 *     BEGIN; preamble; the statement; COMMIT — the caller sees its result only after COMMIT.
 *   - the preamble, one round trip, constants only:
 *       RESET ROLE                                        drops a session-level SET ROLE left on the backend;
 *       SET LOCAL statement_timeout / idle_in_transaction_session_timeout [/ transaction_read_only]
 *                                                         the per-session startup settings, now per transaction;
 *       SET LOCAL search_path TO DEFAULT                  drops a session-level search_path left on the backend;
 *       DO: current_user = session_user, else RAISE 42501 (fail closed: the transaction is aborted, so the caller's
 *           statement fails and nothing runs); then every RLS GUC (RLS_GUC_NAMES: each `rab.*` name a policy or definer
 *           reads; a spec scans the source so a new one cannot be missed) is set to '' transaction-locally, so a session-level
 *           `set_config('rab.organisation_id', ..., false)` left by an earlier client never reaches this transaction. The
 *           list is explicit because PostgreSQL does NOT list placeholder (custom, never-defined) settings in pg_settings:
 *           the first version iterated pg_settings and the PgBouncer test caught the poisoned rab.organisation_id leaking
 *           through. The tenant binding (TenantContextService) then sets its own values.
 *   - a pooler pins one backend for the whole transaction, so the preamble and the caller's statements share it.
 *
 * REFUSED (fail closed, an Error before anything is sent): a transaction-control statement combined with others in one
 * string (`BEGIN; SELECT ...` would run the SELECT before the preamble), COMMIT AND CHAIN, PREPARE TRANSACTION, and a
 * cursor/stream (submittable) outside a transaction. Not detected: a multi-statement string whose LATER part is a ROLLBACK
 * followed by more SQL (the rolled-back RESET ROLE reverts for that tail). No code sends one; only injected SQL could, and
 * injected SQL can already do anything in its own transaction (accepted residual, THREAT-MODEL.md "Transaction pooler").
 *
 * The client-side transaction state follows the statements in submission order (pg runs them strictly in that order). A
 * transaction-control statement that FAILS leaves that state unknown: the connection is then ended (fail closed; the
 * pool discards it on release), never reused with a guess.
 */

export interface TransactionScopeSettings {
  /** SET LOCAL statement_timeout (ms). 0 = none. */
  statementTimeoutMs: number;
  /** SET LOCAL idle_in_transaction_session_timeout (ms). 0 = none. */
  idleInTransactionTimeoutMs: number;
  /** SET LOCAL transaction_read_only = on. */
  readOnly: boolean;
}

/** The config key that carries the settings (pg-pool passes its whole config to `new Client(config)`; pg ignores it). */
export const TRANSACTION_SCOPE_CONFIG_KEY = 'crewflowTransactionScope';

export type TransactionScopedClientConfig = ClientConfig & { [TRANSACTION_SCOPE_CONFIG_KEY]?: TransactionScopeSettings };

/**
 * Every `rab.*` setting an RLS policy, a definer function or the tenant binding reads. The preamble clears each one
 * transaction-locally. transaction-scoped-client.spec.ts scans the server source for `rab.<name>` and fails when one is
 * missing here. Constants only (they are interpolated into the preamble).
 */
export const RLS_GUC_NAMES = Object.freeze([
  'rab.organisation_id',
  'rab.workspace_id',
  'rab.user_id',
  'rab.role',
  'rab.actor_type',
  'rab.team_shift_id',
  'rab.team_staff_id',
  'rab.admin_scope',
  'rab.upgrade_scope',
  'rab.ai_retention',
  'rab.ai_synthetic_marker',
  'rab.ai_usage_retention',
] as const);

/** SQLSTATE of the preamble's role assertion (insufficient_privilege): the transaction is aborted, nothing else runs. */
export const TRANSACTION_SCOPE_ROLE_SQLSTATE = '42501';
export const TRANSACTION_SCOPE_ROLE_MESSAGE = 'crewflow pool safety: the session still acts as another role after RESET ROLE; refusing the transaction';

function integerMs(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 86_400_000) throw new Error(`${name} must be a whole number of milliseconds.`);
  return value;
}

/** The preamble (exported for the exact-text test). Integers and constants only: nothing request-derived ever reaches it. */
export function transactionScopePreambleSql(settings: TransactionScopeSettings): string {
  for (const name of RLS_GUC_NAMES) if (!/^rab\.[a-z_]+$/.test(name)) throw new Error('RLS_GUC_NAMES holds a name that is not rab.<lowercase>');
  const statement = integerMs('statementTimeoutMs', settings.statementTimeoutMs);
  const idle = integerMs('idleInTransactionTimeoutMs', settings.idleInTransactionTimeoutMs);
  return [
    'RESET ROLE',
    `SET LOCAL statement_timeout = ${statement}`,
    `SET LOCAL idle_in_transaction_session_timeout = ${idle}`,
    ...(settings.readOnly ? ['SET LOCAL transaction_read_only = on'] : []),
    'SET LOCAL search_path TO DEFAULT',
    `DO $crewflow_scope$ DECLARE s text; BEGIN ` +
      `IF current_user OPERATOR(pg_catalog.<>) session_user THEN ` +
      `RAISE EXCEPTION USING ERRCODE = '${TRANSACTION_SCOPE_ROLE_SQLSTATE}', MESSAGE = '${TRANSACTION_SCOPE_ROLE_MESSAGE}'; END IF; ` +
      `FOREACH s IN ARRAY ARRAY[${RLS_GUC_NAMES.map((n) => `'${n}'`).join(', ')}]::text[] LOOP ` +
      `PERFORM pg_catalog.set_config(s, '', true); END LOOP; END $crewflow_scope$`,
  ].join('; ');
}

type StatementKind = 'begin' | 'end' | 'savepoint' | 'set-transaction' | 'refused' | 'other';

/** Leading whitespace and SQL comments removed (only the start of the text matters here). */
function stripLeading(text: string): string {
  let s = text;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) s = s.replace(/^--[^\n]*(\n|$)/, '');
    else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
    }
    if (s === before) return s;
  }
}

const SINGLE_BEGIN = /^(BEGIN|START\s+TRANSACTION)\b[^;]*;?\s*$/i;
const SINGLE_END = /^(COMMIT|END|ROLLBACK|ABORT)(\s+(WORK|TRANSACTION))?\s*;?\s*$/i;
const SINGLE_SAVEPOINT = /^(SAVEPOINT|RELEASE|ROLLBACK\s+(WORK\s+|TRANSACTION\s+)?TO)\b[^;]*;?\s*$/i;
const SINGLE_SET_TRANSACTION = /^SET\s+TRANSACTION\b[^;]*;?\s*$/i;

/** Classifies one query text by its leading keyword. Exported for the unit test. */
export function classifyStatement(text: string): StatementKind {
  const s = stripLeading(text);
  const head = /^[A-Za-z]+(\s+[A-Za-z]+)?/.exec(s)?.[0]?.toUpperCase().replace(/\s+/g, ' ') ?? '';
  const first = head.split(' ')[0] ?? '';
  if (first === 'BEGIN' || head === 'START TRANSACTION') return SINGLE_BEGIN.test(s) ? 'begin' : 'refused';
  if (first === 'SAVEPOINT' || first === 'RELEASE' || /^ROLLBACK\s+((WORK|TRANSACTION)\s+)?TO\b/i.test(s)) {
    return SINGLE_SAVEPOINT.test(s) ? 'savepoint' : 'refused';
  }
  if (first === 'COMMIT' || first === 'END' || first === 'ROLLBACK' || first === 'ABORT') return SINGLE_END.test(s) ? 'end' : 'refused';
  if (head === 'PREPARE TRANSACTION') return 'refused';
  if (head === 'SET TRANSACTION') return SINGLE_SET_TRANSACTION.test(s) ? 'set-transaction' : 'refused';
  return 'other';
}

type Phase = 'autocommit' | 'opening' | 'open' | 'broken';

type QueryCallback = (error: Error | null, result?: unknown) => void;

function isSubmittable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { submit?: unknown }).submit === 'function';
}

function queryText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text;
  return null;
}

export class TransactionScopedClientError extends Error {
  constructor(message: string) {
    super(`transaction-scoped connection: ${message}`);
    this.name = 'TransactionScopedClientError';
  }
}

export class TransactionScopedClient extends Client {
  /** Marker read by isTransactionScopedPool (and the guards that refuse such a pool for session work). */
  static readonly transactionScoped = true;

  private readonly preambleSql: string;
  private phase: Phase = 'autocommit';

  constructor(config: TransactionScopedClientConfig) {
    super(config);
    const settings = config[TRANSACTION_SCOPE_CONFIG_KEY];
    if (!settings) throw new TransactionScopedClientError('no transaction scope settings were given (refusing to run without the per-transaction preamble).');
    this.preambleSql = transactionScopePreambleSql(settings);
  }

  /** The client-side transaction phase (tests). */
  get transactionPhase(): Phase {
    return this.phase;
  }

  // pg's overloads are many; the implementation normalises them (text | config | submittable, values?, callback?).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query(...args: any[]): any {
    const callback: QueryCallback | undefined = typeof args[args.length - 1] === 'function' ? (args.pop() as QueryCallback) : undefined;
    const outcome = this.route(args);
    if (isSubmittable(args[0])) return outcome;
    const promise = outcome as Promise<unknown>;
    if (!callback) return promise;
    promise.then(
      (result) => callback(null, result),
      (error: Error) => callback(error),
    );
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private send(args: any[]): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Client.prototype.query as (...a: any[]) => any).apply(this, args);
  }

  private fail(message: string): Promise<never> {
    return Promise.reject(new TransactionScopedClientError(message));
  }

  /** The state is unknown after a failed transaction-control statement: never reuse the connection with a guess. */
  private breakConnection(): void {
    this.phase = 'broken';
    // end(): pg-pool never hands an ending client out again (it is removed on release); every later query here is refused.
    void this.end().catch(() => undefined);
  }

  private control(args: unknown[], next: Phase): Promise<unknown> {
    this.phase = next;
    return (this.send(args) as Promise<unknown>).catch((error: unknown) => {
      this.breakConnection();
      throw error;
    });
  }

  /** The preamble, then the caller's statement (on the same backend: both inside the open transaction). */
  private withPreamble(args: unknown[]): unknown {
    let preambleError: unknown = null;
    (this.send([this.preambleSql]) as Promise<unknown>).catch((error: unknown) => {
      preambleError = error;
    });
    this.phase = 'open';
    const sent = this.send(args);
    if (isSubmittable(args[0])) return sent;
    return (sent as Promise<unknown>).catch((error: unknown) => {
      // The preamble failed (e.g. the role assertion): the caller's statement then failed with 25P02. Report the cause.
      throw preambleError ?? error;
    });
  }

  private route(args: unknown[]): unknown {
    if (this.phase === 'broken') return this.fail('the connection was closed after a failed transaction-control statement.');
    const first = args[0];
    if (isSubmittable(first)) {
      if (this.phase === 'autocommit') {
        throw new TransactionScopedClientError('a cursor or stream outside a transaction is refused (open a transaction first).');
      }
      return this.phase === 'opening' ? this.withPreamble(args) : this.send(args);
    }
    const text = queryText(first);
    if (text === null) return this.fail('a query without SQL text is refused.');
    const kind = classifyStatement(text);
    if (kind === 'refused') {
      return this.fail(
        'a transaction-control statement must be sent alone (not combined with other statements in one string); COMMIT AND CHAIN and PREPARE TRANSACTION are not supported.',
      );
    }
    switch (this.phase) {
      case 'autocommit':
        if (kind === 'begin') return this.control(args, 'opening');
        // Outside a transaction these are no-ops or errors in PostgreSQL itself; nothing to protect.
        if (kind === 'end' || kind === 'savepoint' || kind === 'set-transaction') return this.send(args);
        return this.wrapAutocommit(args);
      case 'opening':
        if (kind === 'set-transaction') return this.send(args);
        if (kind === 'end') return this.control(args, 'autocommit');
        if (kind === 'begin') return this.send(args); // PostgreSQL: a WARNING, still inside the transaction
        return this.withPreamble(args);
      case 'open':
        if (kind === 'end') return this.control(args, 'autocommit');
        return this.send(args);
    }
  }

  /** A statement outside a transaction: BEGIN; preamble; statement; COMMIT. The result is handed out after COMMIT. */
  private wrapAutocommit(args: unknown[]): Promise<unknown> {
    const begin = this.control(['BEGIN'], 'opening');
    begin.catch(() => undefined);
    const statement = this.withPreamble(args) as Promise<unknown>;
    statement.catch(() => undefined);
    // COMMIT on an aborted transaction rolls it back without an error; a failing COMMIT (deferred constraint, serialization)
    // is the statement's failure.
    const commit = this.control(['COMMIT'], 'autocommit');
    commit.catch(() => undefined);
    return Promise.allSettled([begin, statement, commit]).then(([b, s, c]) => {
      if (b.status === 'rejected') throw b.reason;
      if (s.status === 'rejected') throw s.reason;
      if (c.status === 'rejected') throw c.reason;
      return s.value;
    });
  }
}

/** True for a pg Pool (or a TypeORM driver pool) whose clients are TransactionScopedClient. */
export function isTransactionScopedPool(pool: unknown): boolean {
  const client = (pool as { options?: { Client?: { transactionScoped?: boolean } } } | null)?.options?.Client;
  return client?.transactionScoped === true;
}

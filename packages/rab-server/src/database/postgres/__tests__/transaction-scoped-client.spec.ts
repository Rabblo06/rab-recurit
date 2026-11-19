import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';

import {
  classifyStatement,
  isTransactionScopedPool,
  RLS_GUC_CATALOG_SQL,
  RLS_GUC_NAMES,
  rlsGucNamesMissing,
  TransactionScopedClient,
  TransactionScopedClientError,
  transactionScopePreambleSql,
  TransactionScopeSettings,
} from '../transaction-scoped-client';

// Transaction pooler support: what the transaction-scoped client SENDS, in order, for every shape of call. The real
// PostgreSQL / PgBouncer behaviour is proven by transaction-pooler.integration.spec.ts; this spec pins the routing.
const SETTINGS: TransactionScopeSettings = { statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, readOnly: false };
const PREAMBLE = transactionScopePreambleSql(SETTINGS);

type Sent = string;

function harness(fail: (text: string) => Error | null = () => null) {
  const sent: Sent[] = [];
  const spy = jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; submit?: unknown };
    const text = typeof first === 'string' ? first : (first.text ?? '<submittable>');
    sent.push(text);
    const error = fail(text);
    // Like pg: queries complete in submission order.
    return (error ? Promise.reject(error) : Promise.resolve({ rows: [{ text }], command: text.split(' ')[0] })) as never;
  });
  const client = new TransactionScopedClient({ crewflowTransactionScope: SETTINGS });
  return { client, sent, restore: () => spy.mockRestore() };
}

describe('transaction-scoped client: routing', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h?.restore());

  it('a statement outside a transaction runs as BEGIN; preamble; statement; COMMIT, and its result is handed out after COMMIT', async () => {
    h = harness();
    const result = (await h.client.query('SELECT 1 AS x', [])) as { rows: Array<{ text: string }> };
    expect(h.sent).toEqual(['BEGIN', PREAMBLE, 'SELECT 1 AS x', 'COMMIT']);
    expect(result.rows[0]!.text).toBe('SELECT 1 AS x');
    expect(h.client.transactionPhase).toBe('autocommit');
  });

  it('a caller transaction gets the preamble right before its first real statement (after SET TRANSACTION), once', async () => {
    h = harness();
    await h.client.query('START TRANSACTION');
    await h.client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await h.client.query('SELECT a FROM t WHERE id = $1', [1]);
    await h.client.query('SAVEPOINT typeorm_1');
    await h.client.query('UPDATE t SET a = 2');
    await h.client.query('RELEASE SAVEPOINT typeorm_1');
    await h.client.query('COMMIT');
    await h.client.query('SELECT 2');
    expect(h.sent).toEqual([
      'START TRANSACTION',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      PREAMBLE,
      'SELECT a FROM t WHERE id = $1',
      'SAVEPOINT typeorm_1',
      'UPDATE t SET a = 2',
      'RELEASE SAVEPOINT typeorm_1',
      'COMMIT',
      'BEGIN',
      PREAMBLE,
      'SELECT 2',
      'COMMIT',
    ]);
  });

  it('a savepoint or a ROLLBACK TO as the first statement still gets the preamble first; an empty transaction gets none', async () => {
    h = harness();
    await h.client.query('BEGIN');
    await h.client.query('SAVEPOINT s1');
    await h.client.query('ROLLBACK');
    await h.client.query('BEGIN READ ONLY');
    await h.client.query('COMMIT');
    expect(h.sent).toEqual(['BEGIN', PREAMBLE, 'SAVEPOINT s1', 'ROLLBACK', 'BEGIN READ ONLY', 'COMMIT']);
  });

  it('statements queued without awaiting keep the guarantee (pg runs them in submission order)', async () => {
    h = harness();
    await Promise.all([h.client.query('SELECT 1'), h.client.query('SELECT 2')]);
    expect(h.sent).toEqual(['BEGIN', PREAMBLE, 'SELECT 1', 'COMMIT', 'BEGIN', PREAMBLE, 'SELECT 2', 'COMMIT']);
  });

  it('a failed preamble (the role assertion) fails the caller statement with the PREAMBLE error; nothing is reported as success', async () => {
    const roleError = Object.assign(new Error('crewflow pool safety: ...'), { code: '42501' });
    const aborted = Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    h = harness((text) => (text === PREAMBLE ? roleError : text.startsWith('SELECT') ? aborted : null));
    await expect(h.client.query('SELECT secret FROM t')).rejects.toBe(roleError);
    expect(h.sent).toEqual(['BEGIN', PREAMBLE, 'SELECT secret FROM t', 'COMMIT']);
    await h.client.query('BEGIN');
    await expect(h.client.query('SELECT secret FROM t')).rejects.toBe(roleError);
  });

  it('the callback form works (pg-pool\'s pool.query uses it)', async () => {
    h = harness();
    const result = await new Promise((resolve, reject) => h.client.query('SELECT 3', [], (error: Error | null, r: unknown) => (error ? reject(error) : resolve(r))));
    expect(result).toMatchObject({ rows: [{ text: 'SELECT 3' }] });
    expect(h.sent).toEqual(['BEGIN', PREAMBLE, 'SELECT 3', 'COMMIT']);
  });

  it('a query config object is routed like its text', async () => {
    h = harness();
    await h.client.query({ text: 'SELECT 4', values: [] });
    expect(h.sent).toEqual(['BEGIN', PREAMBLE, 'SELECT 4', 'COMMIT']);
  });

  it.each([
    ['BEGIN; SELECT secret FROM t'],
    ['START TRANSACTION; SELECT 1'],
    ['COMMIT; SELECT 1'],
    ['ROLLBACK; SELECT 1'],
    ['COMMIT AND CHAIN'],
    ['PREPARE TRANSACTION \'x\''],
    ['SAVEPOINT a; SELECT 1'],
  ])('refuses %j before sending anything (fail closed)', async (text) => {
    h = harness();
    await expect(h.client.query(text)).rejects.toBeInstanceOf(TransactionScopedClientError);
    expect(h.sent).toEqual([]);
  });

  it('refuses a cursor or stream outside a transaction', () => {
    h = harness();
    expect(() => h.client.query({ submit: () => undefined } as never)).toThrow(TransactionScopedClientError);
    expect(h.sent).toEqual([]);
  });

  it('a failed transaction-control statement closes the connection: nothing more is sent on it', async () => {
    h = harness((text) => (text === 'BEGIN' ? new Error('connection reset') : null));
    await expect(h.client.query('BEGIN')).rejects.toThrow('connection reset');
    expect(h.client.transactionPhase).toBe('broken');
    await expect(h.client.query('SELECT 1')).rejects.toThrow(/closed after a failed transaction-control statement/);
    expect(h.sent).toEqual(['BEGIN']);
  });

  it('refuses to exist without its settings', () => {
    expect(() => new TransactionScopedClient({})).toThrow(/no transaction scope settings/);
  });
});

describe('transaction-scoped client: the preamble and the classifier', () => {
  it('the preamble: RESET ROLE, the per-transaction settings, search_path, the role assertion and the rab.* neutralisation, constants only', () => {
    expect(PREAMBLE.startsWith('RESET ROLE; RESET ALL; SET LOCAL statement_timeout = 30000; SET LOCAL idle_in_transaction_session_timeout = 60000; DO $crewflow_scope$')).toBe(true);
    // Security review L-4: pg_temp explicitly LAST in search_path, so a temporary table never shadows a real one.
    expect(PREAMBLE).toContain("PERFORM pg_catalog.set_config('search_path', CASE WHEN p OPERATOR(pg_catalog.=) '' THEN 'pg_temp' ELSE p OPERATOR(pg_catalog.||) ', pg_temp' END, true)");
    // The NOTIFY switch travels per transaction (L-1, an always-scoped production pool), never on a read-only one.
    expect(transactionScopePreambleSql({ ...SETTINGS, dispatchNotify: true })).toContain('SET LOCAL crewflow.dispatch_notify = on; DO');
    expect(transactionScopePreambleSql({ ...SETTINGS, dispatchNotify: true, readOnly: true })).not.toContain('dispatch_notify');
    expect(PREAMBLE).not.toContain('dispatch_notify');
    expect(PREAMBLE).toContain("IF current_user OPERATOR(pg_catalog.<>) session_user THEN RAISE EXCEPTION USING ERRCODE = '42501'");
    // Placeholder settings are not in pg_settings, so the RLS GUCs are cleared from an explicit list (the PgBouncer test).
    expect(PREAMBLE).toContain(`FOREACH s IN ARRAY ARRAY['rab.organisation_id', 'rab.workspace_id', 'rab.user_id', 'rab.role'`);
    expect(PREAMBLE).not.toContain('pg_settings');
    expect(PREAMBLE).toContain("PERFORM pg_catalog.set_config(s, '', true)");
    expect(transactionScopePreambleSql({ ...SETTINGS, readOnly: true })).toContain('SET LOCAL transaction_read_only = on; DO');
    expect(transactionScopePreambleSql({ statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0, readOnly: false })).toContain('SET LOCAL statement_timeout = 0;');
    expect(() => transactionScopePreambleSql({ ...SETTINGS, statementTimeoutMs: 1.5 })).toThrow();
    expect(() => transactionScopePreambleSql({ ...SETTINGS, statementTimeoutMs: -1 })).toThrow();
  });

  it.each([
    ['BEGIN', 'begin'],
    ['  begin isolation level serializable read only;', 'begin'],
    ['START TRANSACTION', 'begin'],
    ['/* c */ -- x\nSTART TRANSACTION READ WRITE', 'begin'],
    ['COMMIT', 'end'],
    ['END', 'end'],
    ['ROLLBACK', 'end'],
    ['ABORT WORK', 'end'],
    ['ROLLBACK TO SAVEPOINT typeorm_1', 'savepoint'],
    ['ROLLBACK TO typeorm_1', 'savepoint'],
    ['RELEASE SAVEPOINT typeorm_1', 'savepoint'],
    ['SAVEPOINT typeorm_1', 'savepoint'],
    ['SET TRANSACTION READ ONLY', 'set-transaction'],
    ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'set-transaction'],
    ['SET LOCAL ROLE crewflow', 'other'],
    ['SELECT 1', 'other'],
    ['DO $$ BEGIN PERFORM 1; END $$', 'other'],
    ['RESET ROLE', 'other'],
    ['COMMIT AND CHAIN', 'refused'],
    ['BEGIN; SELECT 1', 'refused'],
  ])('%j is %s', (text, kind) => {
    expect(classifyStatement(text)).toBe(kind);
  });

  it('isTransactionScopedPool reads the pool\'s Client class', () => {
    expect(isTransactionScopedPool({ options: { Client: TransactionScopedClient } })).toBe(true);
    expect(isTransactionScopedPool({ options: { Client } })).toBe(false);
    expect(isTransactionScopedPool({ options: {} })).toBe(false);
    expect(isTransactionScopedPool(undefined)).toBe(false);
  });
});

describe('transaction-scoped client: the RLS GUC list is complete', () => {
  it('every rab.<name> setting any package source (.ts, .sql) reads or sets is cleared by the preamble (security review M-2)', () => {
    const packages = path.resolve(__dirname, '../../../../..');
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', 'dist-cjs', 'dist-esm', '__tests__', '.git'].includes(entry.name)) continue;
          walk(full);
        } else if (/\.(ts|sql)$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          for (const m of text.matchAll(/(?:current_setting|set_config)\(\s*'(rab\.[a-z_]+)'/g)) found.add(m[1]!);
          for (const m of text.matchAll(/SET\s+(?:LOCAL\s+|SESSION\s+)?(rab\.[a-z_]+)/gi)) found.add(m[1]!.toLowerCase());
        }
      }
    };
    for (const pkg of fs.readdirSync(packages, { withFileTypes: true })) {
      const src = path.join(packages, pkg.name, 'src');
      if (pkg.isDirectory() && fs.existsSync(src)) walk(src);
    }
    expect(found.size).toBeGreaterThan(5);
    expect(rlsGucNamesMissing([...found])).toEqual([]);
  });

  it('rlsGucNamesMissing names exactly what the list does not cover (rab.test is the one test-only extra)', () => {
    expect(rlsGucNamesMissing(['rab.organisation_id', 'rab.test', 'rab.ai_retention'])).toEqual([]);
    expect(rlsGucNamesMissing(['rab.zz_probe', 'rab.organisation_id', 'rab.zz_probe'])).toEqual(['rab.zz_probe']);
  });

  it('the catalog query matches whole rab.<name> words in policies and in function bodies and SET clauses', () => {
    expect(RLS_GUC_CATALOG_SQL).toContain('FROM pg_catalog.pg_policies p');
    expect(RLS_GUC_CATALOG_SQL).toContain('f.prosrc');
    expect(RLS_GUC_CATALOG_SQL).toContain('f.proconfig');
    expect(RLS_GUC_CATALOG_SQL).toContain(String.raw`'\m(rab\.[a-z_]+)'`);
  });
});

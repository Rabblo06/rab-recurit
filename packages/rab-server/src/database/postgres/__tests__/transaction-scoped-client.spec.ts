import { Client } from 'pg';

import {
  classifyStatement,
  isTransactionScopedPool,
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
    expect(PREAMBLE.startsWith('RESET ROLE; SET LOCAL statement_timeout = 30000; SET LOCAL idle_in_transaction_session_timeout = 60000; SET LOCAL search_path TO DEFAULT; DO $crewflow_scope$')).toBe(true);
    expect(PREAMBLE).toContain("IF current_user OPERATOR(pg_catalog.<>) session_user THEN RAISE EXCEPTION USING ERRCODE = '42501'");
    expect(PREAMBLE).toContain("FROM pg_catalog.pg_settings WHERE name OPERATOR(pg_catalog.~~) 'rab.%'");
    expect(PREAMBLE).toContain("PERFORM pg_catalog.set_config(s, '', true)");
    expect(transactionScopePreambleSql({ ...SETTINGS, readOnly: true })).toContain('SET LOCAL transaction_read_only = on; SET LOCAL search_path TO DEFAULT');
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

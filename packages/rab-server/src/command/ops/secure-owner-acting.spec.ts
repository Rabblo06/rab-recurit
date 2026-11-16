import * as fs from 'fs';
import * as path from 'path';

import { EntityManager } from 'typeorm';

import { setPgProcessRole } from '../../database/postgres/pg-config';
import { SecureOwnerActingError, withSecureOwner } from './secure-owner-acting';

/** O-2 review: the refusal branches of the owner-acting step, and the import barrier around it. */

interface Script {
  inTransaction?: boolean;
  facts?: Record<string, unknown> | null;
  after?: { acting: string; read_only: string };
  afterReset?: { acting: string; login: string };
}

const GOOD_FACTS = { login: 'crewflow_owner', acting: 'crewflow_owner', exempt: false, can_set: true };

function fakeManager(script: Script): { manager: EntityManager; sql: string[] } {
  const sql: string[] = [];
  const query = jest.fn(async (text: string) => {
    sql.push(text.trim());
    if (text.includes('pg_has_role')) return script.facts === null ? [] : [script.facts ?? GOOD_FACTS];
    if (text.startsWith('SET LOCAL ROLE')) return [];
    if (text.includes('transaction_read_only')) return [script.after ?? { acting: 'rab_secure_owner', read_only: 'off' }];
    if (text === 'RESET ROLE') return [];
    if (text.includes('session_user::text AS login')) return [script.afterReset ?? { acting: 'crewflow_owner', login: 'crewflow_owner' }];
    return [];
  });
  const manager = { query, queryRunner: { isTransactionActive: script.inTransaction ?? true } } as unknown as EntityManager;
  return { manager, sql };
}

const ran = (sql: string[], prefix: string) => sql.some((s) => s.startsWith(prefix));

describe('withSecureOwner (O-2)', () => {
  beforeEach(() => setPgProcessRole('cli'));
  afterEach(() => setPgProcessRole('api'));

  it('narrows, runs fn, then RESET ROLE after fn resolves', async () => {
    const { manager, sql } = fakeManager({});
    const order: string[] = [];
    const result = await withSecureOwner(manager, async () => {
      order.push(`fn after ${sql.filter((s) => s.startsWith('SET LOCAL ROLE')).length} SET`);
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual(['fn after 1 SET']);
    expect(sql.indexOf('SET LOCAL ROLE rab_secure_owner')).toBeLessThan(sql.indexOf('RESET ROLE'));
  });

  it('when fn fails, no further statement is sent (the aborted transaction would raise 25P02; rollback undoes SET LOCAL)', async () => {
    const { manager, sql } = fakeManager({});
    await expect(withSecureOwner(manager, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(ran(sql, 'RESET ROLE')).toBe(false);
  });

  const refusals: Array<[string, Script, RegExp, (() => void)?]> = [
    ['the process is not the CLI (API / Worker share the login)', {}, /process is "api", not the CLI/, () => setPgProcessRole('api')],
    ['the process is the Worker', {}, /process is "worker", not the CLI/, () => setPgProcessRole('worker')],
    ['no open transaction', { inTransaction: false }, /no open transaction/],
    ['the identity cannot be read', { facts: null }, /cannot read the connecting identity/],
    ['the login is not crewflow_owner', { facts: { ...GOOD_FACTS, login: 'crewflow', acting: 'crewflow' } }, /not the owner login crewflow_owner/],
    ['the session already acts as another role', { facts: { ...GOOD_FACTS, acting: 'crewflow' } }, /already acts as "crewflow"/],
    ['the login is SUPERUSER or BYPASSRLS', { facts: { ...GOOD_FACTS, exempt: true } }, /SUPERUSER or BYPASSRLS/],
    ['the login may not SET the role', { facts: { ...GOOD_FACTS, can_set: false } }, /may not SET ROLE rab_secure_owner/],
  ];

  it.each(refusals)('refuses before SET LOCAL ROLE when %s; fn never runs', async (_name, script, message, arrange) => {
    arrange?.();
    const { manager, sql } = fakeManager(script);
    const fn = jest.fn(async () => undefined);
    await expect(withSecureOwner(manager, fn)).rejects.toThrow(SecureOwnerActingError);
    await expect(withSecureOwner(manager, fn)).rejects.toThrow(message);
    expect(fn).not.toHaveBeenCalled();
    expect(ran(sql, 'SET LOCAL ROLE')).toBe(false);
  });

  it('refuses when SET LOCAL ROLE did not take effect; fn never runs', async () => {
    const { manager } = fakeManager({ after: { acting: 'crewflow_owner', read_only: 'off' } });
    const fn = jest.fn(async () => undefined);
    await expect(withSecureOwner(manager, fn)).rejects.toThrow(/did not take effect/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses when READ ONLY was expected but the transaction is read-write; fn never runs', async () => {
    const { manager } = fakeManager({ after: { acting: 'rab_secure_owner', read_only: 'off' } });
    const fn = jest.fn(async () => undefined);
    await expect(withSecureOwner(manager, fn, { expectReadOnly: true })).rejects.toThrow(/not READ ONLY/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws when RESET ROLE did not return the session to its login', async () => {
    const { manager } = fakeManager({ afterReset: { acting: 'rab_secure_owner', login: 'crewflow_owner' } });
    await expect(withSecureOwner(manager, async () => undefined)).rejects.toThrow(/RESET ROLE did not return/);
  });
});

describe('import barrier: only src/command/** may import ops/secure-owner-acting (O-2 review)', () => {
  const REPO = path.resolve(__dirname, '../../../../..');
  const ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src', 'packages/rab-front/src', 'tools'];
  const ALLOWED = 'packages/rab-server/src/command/';
  const IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"][^'"]*secure-owner-acting['"]/;

  function walk(dir: string, out: string[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('dist')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(c|m)?[jt]sx?$/.test(entry.name)) out.push(full);
    }
  }

  it('every importer lives under src/command/, and the three O-2 commands are among them (not vacuous)', () => {
    const files: string[] = [];
    for (const root of ROOTS) walk(path.join(REPO, root), files);
    const importers = files
      .filter((f) => IMPORT.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(REPO, f).split(path.sep).join('/'));
    expect(importers.filter((f) => !f.startsWith(ALLOWED))).toEqual([]);
    expect(importers).toEqual(
      expect.arrayContaining([
        'packages/rab-server/src/command/grant-platform-admin.command.ts',
        'packages/rab-server/src/command/seed.command.ts',
        'packages/rab-server/src/command/storage-migrate-local.command.ts',
      ]),
    );
  });
});

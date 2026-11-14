import { DataSource } from 'typeorm';

import { markNewWorkspaceInitial, UPGRADE_SCOPE_SETTING, upgradeSessionOf, UpgradeSessionError, withUpgradeScope } from './upgrade-migration.service';
import { UpgradeStatusService } from './upgrade-status.service';

type Call = { sql: string; params?: unknown[] };

/** A scripted connection: answers by SQL text; records every call. */
function scripted(answer: (sql: string, params: unknown[] | undefined, n: number) => unknown) {
  const calls: Call[] = [];
  const conn = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return answer(sql, params, calls.length);
    },
  };
  return { conn, calls };
}

describe('withUpgradeScope needs ONE dedicated session (security review L4)', () => {
  it('refuses a pooled connection whose statements land on different backends (rolled back, nothing committed)', async () => {
    let pid = 100;
    const { conn, calls } = scripted((sql) => {
      if (sql.includes('txid_current_if_assigned')) return [{ free: true, fresh: true, scope: '', pid: (pid += 1) }];
      if (sql.includes('pg_backend_pid() AS pid')) return [{ pid: (pid += 1), scope: 'status' }];
      return [];
    });
    await expect(withUpgradeScope(upgradeSessionOf(conn), 'status', async () => 'read')).rejects.toBeInstanceOf(UpgradeSessionError);
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(calls.map((c) => c.sql)).not.toContain('COMMIT');
  });

  it('refuses a session already inside a transaction with a transaction id, or already carrying a scope (before BEGIN)', async () => {
    // R2: also an open READ-ONLY transaction (no transaction id yet, but transaction_timestamp() < statement_timestamp()).
    for (const pre of [
      { free: false, fresh: true, scope: '', pid: 1 },
      { free: true, fresh: false, scope: '', pid: 1 },
      { free: true, fresh: true, scope: 'status', pid: 1 },
    ]) {
      const { conn, calls } = scripted((sql) => (sql.includes('txid_current_if_assigned') ? [pre] : []));
      await expect(withUpgradeScope(upgradeSessionOf(conn), 'upgrade', async () => 1)).rejects.toBeInstanceOf(UpgradeSessionError);
      expect(calls.map((c) => c.sql)).not.toContain('BEGIN');
    }
  });

  it('a dedicated session: BEGIN, the scope, the work, the same backend, COMMIT', async () => {
    const { conn, calls } = scripted((sql) => {
      if (sql.includes('txid_current_if_assigned')) return [{ free: true, fresh: true, scope: '', pid: 7 }];
      if (sql.includes('pg_backend_pid() AS pid')) return [{ pid: 7, scope: 'upgrade' }];
      return [];
    });
    await expect(withUpgradeScope(upgradeSessionOf(conn), 'upgrade', async () => 42)).resolves.toBe(42);
    const order = calls.map((c) => (c.sql.startsWith('SELECT pg_catalog.set_config') ? `scope=${String(c.params?.at(-1))}` : c.sql.split(/\s/)[0]));
    expect(order).toEqual(['SELECT', 'BEGIN', 'scope=upgrade', 'SELECT', 'COMMIT']);
  });

  it('the pre-check is a SIMPLE-protocol statement: no bind parameter, the setting name as a literal equal to the constant', async () => {
    // A bound parameter puts node-pg on the extended protocol, where transaction_timestamp() <> statement_timestamp() even in
    // a fresh autocommit session, so every call was refused (regression after ef7f56c0, caught by the live ci-db).
    const { conn, calls } = scripted((sql) => {
      if (sql.includes('txid_current_if_assigned')) return [{ free: true, fresh: true, scope: '', pid: 9 }];
      if (sql.includes('pg_backend_pid() AS pid')) return [{ pid: 9, scope: 'status' }];
      return [];
    });
    await withUpgradeScope(upgradeSessionOf(conn), 'status', async () => undefined);
    const pre = calls.find((c) => c.sql.includes('txid_current_if_assigned'))!;
    expect(pre.params === undefined || pre.params.length === 0).toBe(true);
    expect(pre.sql).toContain(`pg_catalog.current_setting('${UPGRADE_SCOPE_SETTING}', true)`);
  });

  it('accepts a pg client result shape ({ rows })', async () => {
    const { conn } = scripted((sql) => {
      if (sql.includes('txid_current_if_assigned')) return { rows: [{ free: true, fresh: true, scope: '', pid: 3 }] };
      if (sql.includes('pg_backend_pid() AS pid')) return { rows: [{ pid: 3, scope: 'status' }] };
      return { rows: [] };
    });
    await expect(withUpgradeScope(upgradeSessionOf(conn), 'status', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('markNewWorkspaceInitial (security review L3)', () => {
  const ws = { id: '11111111-1111-4111-8111-111111111111', organisationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };

  it('a failing INSERT surfaces the ORIGINAL error; no restore statement runs on the aborted transaction', async () => {
    const original = Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    const { conn, calls } = scripted((sql) => {
      if (sql.includes('to_regclass')) return [{ exists: true }];
      if (sql.includes("current_setting('rab.organisation_id'")) return [{ org: ws.organisationId }];
      if (sql.includes("current_setting('rab.workspace_id'")) return [{ v: 'prior-ws' }];
      if (sql.startsWith('INSERT')) throw original;
      return [];
    });
    await expect(markNewWorkspaceInitial(conn.query as never, ws)).rejects.toBe(original);
    const afterInsert = calls.slice(calls.findIndex((c) => c.sql.startsWith('INSERT')) + 1);
    expect(afterInsert).toEqual([]);
  });

  it('after success the scope is cleared and rab.workspace_id restored to its earlier value, in the same transaction', async () => {
    const { conn, calls } = scripted((sql) => {
      if (sql.includes('to_regclass')) return [{ exists: true }];
      if (sql.includes("current_setting('rab.organisation_id'")) return [{ org: ws.organisationId }];
      if (sql.includes("current_setting('rab.workspace_id'")) return [{ v: 'prior-ws' }];
      return [];
    });
    await expect(markNewWorkspaceInitial(conn.query as never, ws)).resolves.toBe(true);
    const sets = calls.filter((c) => c.sql.includes('set_config')).map((c) => c.params?.at(-1));
    expect(sets).toEqual(['workspace_init', ws.id, '', 'prior-ws']);
  });

  it('refuses a workspace whose organisation is not the bound one', async () => {
    const { conn } = scripted((sql) => {
      if (sql.includes('to_regclass')) return [{ exists: true }];
      if (sql.includes("current_setting('rab.organisation_id'")) return [{ org: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }];
      return [];
    });
    await expect(markNewWorkspaceInitial(conn.query as never, ws)).rejects.toThrow(/not in the bound organisation/);
  });
});

describe('UpgradeStatusService.status() is single-flight (security review L5)', () => {
  it('50 concurrent calls on an expired cache open ONE query runner', async () => {
    let runners = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const dataSource = {
      createQueryRunner: () => {
        runners += 1;
        return {
          connect: async () => undefined,
          release: async () => undefined,
          query: async () => {
            await gate;
            return [{ exists: false }];
          },
        };
      },
    } as unknown as DataSource;
    const service = new UpgradeStatusService(dataSource);
    const all = Promise.all(Array.from({ length: 50 }, () => service.status()));
    await new Promise((r) => setImmediate(r));
    release();
    const results = await all;
    expect(runners).toBe(1);
    expect(new Set(results.map((r) => r.state))).toEqual(new Set(['none']));
  });
});

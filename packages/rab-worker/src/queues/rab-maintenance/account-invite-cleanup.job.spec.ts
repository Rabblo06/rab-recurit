import { InviteAutoDeleteConfigError, resolveInviteAutoDeleteEnabled, runAccountInviteCleanupCycle } from './account-invite-cleanup.job';
import { MaintenanceScanProcessor } from './maintenance.processors';

/**
 * Phase D F-1 (owner condition D8; docs/plans/PHASE-D-SQL-GATE.md §1786721340000): as the runtime login the cycle sees no `core."user"` /
 * `core.account_invite` rows (RLS, no tenant context), so it has been a silent no-op. Migration 1786721340000 (NOT
 * approved, NOT run) adds three narrow rab_secure_owner definers, EXECUTE crewflow_worker only. The Worker uses them when
 * its live role can EXECUTE all three; otherwise the cycle is exactly today's code (an old / per_scope Worker on
 * crewflow_app is unchanged). Mocked database: the definers are not executed here (SQL gate).
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const WS = '00000000-0000-4000-8000-0000000000a1';
const OTHER_WS = '00000000-0000-4000-8000-0000000000b1';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const ON = { autoDeleteEnabled: true } as const;
const OFF = { autoDeleteEnabled: false } as const;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function harness(opts: {
  usable: boolean;
  expired?: Array<{ user_id: string; organisation_id: string }>;
  candidates?: Array<{ user_id: string; organisation_id: string; cleanup_at: Date; blocking_reason: string | null }>;
  deleteOutcome?: Record<string, string>;
  workspaceDependency?: string; // user id that has a `shift.created_by` row in WS
}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let candidatesServed = false;
  let pageServed = false;
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (sql.includes('has_function_privilege')) return [{ usable: opts.usable }];
    if (sql.includes('core.worker_expire_account_invites')) return opts.expired ?? [];
    if (sql.includes('core.worker_account_invite_cleanup_candidates')) {
      if (candidatesServed) return [];
      candidatesServed = true;
      return opts.candidates ?? [];
    }
    if (sql.includes('core.worker_delete_expired_invited_user')) return [{ outcome: opts.deleteOutcome?.[params[0] as string] ?? 'deleted' }];
    if (sql.includes('core.worker_list_workspaces')) {
      if (pageServed) return [];
      pageServed = true;
      return [
        { workspace_id: WS, organisation_id: ORG },
        { workspace_id: OTHER_WS, organisation_id: OTHER_ORG },
      ];
    }
    if (sql.startsWith('SELECT current_setting')) return [{ org: null, workspace: null }];
    if (sql === `SELECT 1 FROM shift WHERE created_by = $1 LIMIT 1`) return params[0] === opts.workspaceDependency ? [{ '?column?': 1 }] : [];
    if (sql.includes('workspace_schema_registry')) return [];
    return [];
  };
  const counters = { transactions: 0 };
  const dataSource = {
    transaction: async <T>(fn: (m: unknown) => Promise<T>) => {
      counters.transactions += 1;
      return fn({ query });
    },
    // A DataSource-level query (outside a transaction) would also be a database access: counted the same way.
    query: async (sql: string, params: unknown[] = []) => query(sql, params),
  };
  const audits = () =>
    statements
      .filter((s) => s.sql.includes('INSERT INTO core.audit_log'))
      .map((s) => [s.params[2], s.params[1], JSON.parse(s.params[3] as string)]);
  return { statements, dataSource, audits, counters };
}

describe('account invite cleanup — F-1 definer path (WORKER_INVITE_AUTO_DELETE_ENABLED=true AND the live role can EXECUTE the three functions)', () => {
  it('expire: one definer call (bounded 500) instead of SELECT+UPDATE on core."user"; one invite_expired audit per user, under the advisory lock', async () => {
    const h = harness({ usable: true, expired: [{ user_id: U(1), organisation_id: ORG }, { user_id: U(2), organisation_id: ORG }] });
    const result = await runAccountInviteCleanupCycle(h.dataSource as never, ON);
    expect(h.statements[0]!.sql).toBe(`SELECT pg_advisory_xact_lock(hashtext('rab_account_invite_cleanup'))`);
    const expire = h.statements.find((s) => s.sql.includes('FROM core.worker_expire_account_invites('))!;
    expect(expire.sql).toBe('SELECT user_id, organisation_id FROM core.worker_expire_account_invites($1::integer)');
    expect(expire.params).toEqual([500]);
    expect(h.statements.some((s) => /UPDATE core\."user"|DELETE FROM core\."user"|FROM core\."user" u/.test(s.sql))).toBe(false);
    expect(h.audits()).toEqual([
      ['user.invite_expired', U(1), {}],
      ['user.invite_expired', U(2), {}],
    ]);
    expect(result).toEqual({ expired: 2, deleted: 0, retained: 0 });
  });

  it('cleanup: definer candidates (keyset, 50/page); global blocks come from the definer, workspace history checks stay in the Worker under tenant context, delete through the definer', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const h = harness({
      usable: true,
      candidates: [
        { user_id: U(10), organisation_id: ORG, cleanup_at: at, blocking_reason: 'platform_admin' },
        { user_id: U(11), organisation_id: ORG, cleanup_at: at, blocking_reason: null },
        { user_id: U(12), organisation_id: ORG, cleanup_at: at, blocking_reason: null },
        { user_id: U(13), organisation_id: ORG, cleanup_at: at, blocking_reason: null },
      ],
      deleteOutcome: { [U(12)]: 'referenced' },
      workspaceDependency: U(13),
    });
    const result = await runAccountInviteCleanupCycle(h.dataSource as never, ON);
    const page = h.statements.find((s) => s.sql.includes('FROM core.worker_account_invite_cleanup_candidates('))!;
    expect(page.sql).toBe(
      'SELECT user_id, organisation_id, cleanup_at, blocking_reason FROM core.worker_account_invite_cleanup_candidates($1::integer, $2::timestamptz, $3::uuid)',
    );
    expect(page.params).toEqual([50, null, null]);
    // The definer reported the global blocks: the Worker no longer reads core.platform_admin / manager_workspace / refresh_token.
    expect(h.statements.some((s) => /core\.platform_admin|core\.refresh_token|FROM core\.manager_workspace/.test(s.sql))).toBe(false);
    // Workspace history checks ran bound to the candidate's own organisation and workspace (only ORG's workspace).
    const binds = h.statements.filter((s) => s.sql.startsWith(`SELECT set_config('rab.organisation_id',$1,true), set_config('rab.workspace_id',$2,true)`)).map((s) => s.params);
    expect(binds).toContainEqual([ORG, WS]);
    expect(binds).not.toContainEqual([OTHER_ORG, OTHER_WS]);
    // Deletes only through the definer, never for a blocked candidate.
    const deletes = h.statements.filter((s) => s.sql.includes('core.worker_delete_expired_invited_user($1')).map((s) => s.params[0]);
    expect(deletes).toEqual([U(11), U(12)]);
    expect(h.audits()).toEqual([
      ['user.invite_cleanup_skipped', U(10), { reason: 'platform_admin' }],
      ['user.invite_cleaned_up', null, { deletedUserId: U(11) }],
      ['user.invite_cleanup_skipped', U(12), { reason: 'referenced' }],
      ['user.invite_cleanup_skipped', U(13), { reason: 'shift' }],
    ]);
    expect(result).toEqual({ expired: 0, deleted: 1, retained: 3 });
  });

  it('each candidate runs in its own savepoint (one failure rolls back only that candidate and is audited as failed)', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const h = harness({ usable: true, candidates: [{ user_id: U(20), organisation_id: ORG, cleanup_at: at, blocking_reason: null }] });
    const original = h.dataSource.transaction;
    h.dataSource.transaction = async <T>(fn: (m: unknown) => Promise<T>) =>
      original(async (m: unknown) => {
        const inner = m as { query: (sql: string, p?: unknown[]) => Promise<unknown> };
        return fn({
          query: async (sql: string, p?: unknown[]) => {
            if (sql.includes('core.worker_delete_expired_invited_user($1')) {
              await inner.query(sql, p);
              throw new TypeError('boom');
            }
            return inner.query(sql, p);
          },
        });
      });
    const result = await runAccountInviteCleanupCycle(h.dataSource as never, ON);
    const sql = h.statements.map((s) => s.sql);
    expect(sql).toContain('SAVEPOINT sp_invite_cleanup_candidate');
    expect(sql).toContain('ROLLBACK TO SAVEPOINT sp_invite_cleanup_candidate');
    expect(h.audits()).toEqual([['user.invite_cleanup_failed', U(20), { reason: 'TypeError' }]]);
    expect(result).toEqual({ expired: 0, deleted: 0, retained: 0 });
  });
});

describe('account invite cleanup — legacy path (flag ON but the role cannot EXECUTE: crewflow_app / functions absent)', () => {
  it('probes privilege without failing when the functions do not exist (to_regprocedure), then runs today\'s SQL unchanged', async () => {
    const h = harness({ usable: false });
    await runAccountInviteCleanupCycle(h.dataSource as never, ON);
    const probe = h.statements.find((s) => s.sql.includes('has_function_privilege'))!;
    for (const fn of [
      'core.worker_expire_account_invites(integer)',
      'core.worker_account_invite_cleanup_candidates(integer, timestamp with time zone, uuid)',
      'core.worker_delete_expired_invited_user(uuid)',
    ]) {
      expect(probe.sql).toContain(`to_regprocedure('${fn}')`);
    }
    expect(h.statements.some((s) => /worker_expire_account_invites\(\$1|worker_account_invite_cleanup_candidates\(\$1|worker_delete_expired_invited_user\(\$1/.test(s.sql))).toBe(false);
    const legacyExpire = h.statements.find((s) => s.sql.includes(`WHERE u.status = 'invited'`))!;
    expect(legacyExpire.sql).toContain('FROM core."user" u');
    expect(legacyExpire.params).toEqual([500]);
    expect(h.statements.some((s) => s.sql.includes(`WHERE u.status = 'invite_expired'`))).toBe(true);
  });

  it('ON + not executable: the legacy statement sequence is pinned exactly (advisory lock, probe, expire SELECT, cleanup SELECT)', async () => {
    const h = harness({ usable: false });
    await runAccountInviteCleanupCycle(h.dataSource as never, ON);
    expect(h.statements.map((s) => s.sql)).toEqual([
      `SELECT pg_advisory_xact_lock(hashtext('rab_account_invite_cleanup'))`,
      expect.stringContaining('has_function_privilege'),
      MAIN_EXPIRE_SQL,
      MAIN_CLEANUP_SQL,
    ]);
    expect(h.statements[2]!.params).toEqual([500]);
    expect(h.statements[3]!.params).toEqual([50, null, null]);
  });
});

/**
 * Phase D wave 2 — retention gate (owner decision 2026-11-01): WORKER_INVITE_AUTO_DELETE_ENABLED, default false.
 *
 * D-1 (Twenty Mode M0, HIGH): OFF used to run the pre-Phase-D direct-SQL cycle and relied on the runtime login being
 * crewflow_app (RLS, no tenant context ⇒ a silent no-op). On any owner-member login (an owner of the NOT-FORCE
 * core."user" / core.account_invite, a superuser, or Twenty Mode's crewflow_owner) that same OFF path expired invites and
 * DELETED accounts across every tenant. OFF now means OFF: the cycle returns before it opens a transaction, so no
 * statement at all reaches the database, whatever the login can see or execute.
 */
const MAIN_EXPIRE_SQL = `SELECT u.id, u.organisation_id
         FROM core."user" u
         JOIN core.account_invite ai ON ai.user_id = u.id
        WHERE u.status = 'invited'
          AND ai.send_number = 3
          AND ai.accepted_at IS NULL
          AND ai.revoked_at IS NULL
          AND ai.expires_at < now()
        ORDER BY ai.expires_at ASC, u.id ASC
        LIMIT $1`;
const MAIN_CLEANUP_SQL = `SELECT u.id, u.organisation_id, ai.cleanup_at
           FROM core."user" u
           JOIN core.account_invite ai ON ai.user_id = u.id
          WHERE u.status = 'invite_expired'
            AND ai.send_number = 3
            AND ai.cleanup_at IS NOT NULL
            AND ai.cleanup_at < now()
            AND ($2::timestamptz IS NULL OR ai.cleanup_at > $2 OR (ai.cleanup_at = $2 AND u.id > $3))
          ORDER BY ai.cleanup_at ASC, u.id ASC
          LIMIT $1`;
const DEFINER_CALL = /core\.worker_(expire_account_invites|account_invite_cleanup_candidates|delete_expired_invited_user)\s*\(\$/;

describe('account invite cleanup — retention gate OFF (WORKER_INVITE_AUTO_DELETE_ENABLED=false, the default)', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const definersPresent = () =>
    harness({
      usable: true, // the 1786721340000 definers exist and this login could EXECUTE them
      expired: [{ user_id: U(1), organisation_id: ORG }],
      candidates: [{ user_id: U(30), organisation_id: ORG, cleanup_at: at, blocking_reason: null }],
    });

  it('OFF + definers executable ⇒ zero definer calls (expire, candidates, delete), zero deletes, zero audits', async () => {
    const h = definersPresent();
    const result = await runAccountInviteCleanupCycle(h.dataSource as never, OFF);
    expect(h.statements.some((s) => DEFINER_CALL.test(s.sql))).toBe(false);
    expect(h.statements.some((s) => /DELETE FROM|worker_delete_expired_invited_user/.test(s.sql))).toBe(false);
    expect(h.audits()).toEqual([]);
    expect(result).toEqual({ expired: 0, deleted: 0, retained: 0 });
  });

  it('D-1: OFF opens no transaction and sends no statement at all — not the advisory lock, not the legacy expire/cleanup SQL', async () => {
    const h = definersPresent();
    expect(await runAccountInviteCleanupCycle(h.dataSource as never, OFF)).toEqual({ expired: 0, deleted: 0, retained: 0 });
    expect(h.counters.transactions).toBe(0);
    expect(h.statements).toEqual([]);
  });

  it('D-1: OFF on a login that WOULD see every tenant (owner-member / superuser: the legacy SELECTs return rows) still changes nothing', async () => {
    // A harness that answers the legacy SQL the way an owner-member login does (RLS not applied to the table owner).
    const statements: string[] = [];
    let transactions = 0;
    const ownerQuery = async (sql: string) => {
      statements.push(sql);
      if (sql.includes(`WHERE u.status = 'invited'`)) return [{ id: U(40), organisation_id: ORG }, { id: U(41), organisation_id: OTHER_ORG }];
      if (sql.includes(`WHERE u.status = 'invite_expired'`)) return [{ id: U(42), organisation_id: ORG, cleanup_at: at }];
      return [];
    };
    const ownerDataSource = {
      transaction: async <T>(fn: (m: unknown) => Promise<T>) => {
        transactions += 1;
        return fn({ query: ownerQuery });
      },
      query: ownerQuery,
    };
    for (let tick = 0; tick < 3; tick += 1) {
      expect(await runAccountInviteCleanupCycle(ownerDataSource as never, OFF)).toEqual({ expired: 0, deleted: 0, retained: 0 });
    }
    expect(transactions).toBe(0);
    expect(statements).toEqual([]);
  });

  it('no options (any caller that does not pass the flag) is OFF — fail closed, no statement', async () => {
    const h = definersPresent();
    expect(await runAccountInviteCleanupCycle(h.dataSource as never)).toEqual({ expired: 0, deleted: 0, retained: 0 });
    expect(h.counters.transactions).toBe(0);
    expect(h.statements).toEqual([]);
  });

  it('only the boolean true enables it: truthy non-boolean values passed by a careless caller stay OFF', async () => {
    for (const value of ['true', 1, {}, 'yes'] as unknown[]) {
      const h = definersPresent();
      expect(await runAccountInviteCleanupCycle(h.dataSource as never, { autoDeleteEnabled: value as boolean })).toEqual({ expired: 0, deleted: 0, retained: 0 });
      expect(h.statements).toEqual([]);
    }
  });

  it('ON + definers executable ⇒ the Phase D definer path (expire + candidates + delete through the definers)', async () => {
    const h = definersPresent();
    const result = await runAccountInviteCleanupCycle(h.dataSource as never, ON);
    const sql = h.statements.map((s) => s.sql);
    expect(sql.some((q) => q.includes('has_function_privilege'))).toBe(true);
    expect(sql.some((q) => q.includes('FROM core.worker_expire_account_invites($1'))).toBe(true);
    expect(sql.some((q) => q.includes('FROM core.worker_account_invite_cleanup_candidates($1'))).toBe(true);
    expect(sql.some((q) => q.includes('core.worker_delete_expired_invited_user($1'))).toBe(true);
    expect(result).toEqual({ expired: 1, deleted: 1, retained: 0 });
  });
});

describe('resolveInviteAutoDeleteEnabled (WORKER_INVITE_AUTO_DELETE_ENABLED, read like WORKER_CLAIM_MODE)', () => {
  const env = (value: unknown, nodeEnv = 'test') => ({
    get: (key: string) => (key === 'WORKER_INVITE_AUTO_DELETE_ENABLED' ? value : key === 'NODE_ENV' ? nodeEnv : undefined),
  });

  it('unset / false / "false" ⇒ OFF (the default)', () => {
    for (const value of [undefined, null, '', false, 'false']) expect(resolveInviteAutoDeleteEnabled(env(value))).toBe(false);
  });

  it('true / "true" ⇒ ON outside production', () => {
    for (const value of [true, 'true']) expect(resolveInviteAutoDeleteEnabled(env(value))).toBe(true);
  });

  it('anything else refuses to start (fail closed, never guessed)', () => {
    for (const value of ['yes', '1', 1, 'TRUE ', {}]) expect(() => resolveInviteAutoDeleteEnabled(env(value))).toThrow(InviteAutoDeleteConfigError);
  });

  it('ON in production refuses to start until the owner approves it (grace period, eligibility, audit wording, retention policy)', () => {
    expect(() => resolveInviteAutoDeleteEnabled(env(true, 'production'))).toThrow(/owner approval/);
    expect(resolveInviteAutoDeleteEnabled(env(false, 'production'))).toBe(false);
  });
});

/**
 * D-1 through the real Worker entry: the scheduled `account-invite-cleanup` processor reads the flag on every cycle and
 * passes the RUNTIME data source. With the flag unset or false the data source is never touched — whatever login it is
 * (in Twenty Mode it is the schema-owning crewflow_owner, which sees every tenant's core."user" row).
 */
describe('D-1: MaintenanceScanProcessor.accountInviteCleanup with the flag OFF never touches the runtime data source', () => {
  for (const flag of [undefined, false, 'false', '']) {
    it(`WORKER_INVITE_AUTO_DELETE_ENABLED=${JSON.stringify(flag)} ⇒ no transaction, no statement, nothing logged`, async () => {
      const touched: string[] = [];
      const runtimeDataSource = {
        transaction: async () => {
          touched.push('transaction');
          throw new Error('the OFF cycle must not open a transaction');
        },
        query: async (sql: string) => {
          touched.push(sql);
          throw new Error('the OFF cycle must not send a statement');
        },
      };
      const logged: string[] = [];
      const deps = {
        get: () => ({
          runtimeDataSource,
          environmentService: { get: (key: string) => (key === 'WORKER_INVITE_AUTO_DELETE_ENABLED' ? flag : key === 'NODE_ENV' ? 'production' : undefined) },
          logger: { log: (m: string) => logged.push(m) },
        }),
      };
      await new MaintenanceScanProcessor(deps as never).accountInviteCleanup();
      expect(touched).toEqual([]);
      expect(logged).toEqual([]);
    });
  }
});

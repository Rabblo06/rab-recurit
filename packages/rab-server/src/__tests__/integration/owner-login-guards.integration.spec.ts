import { Client, Pool } from 'pg';

import { ownerLoginObjectPostureProblems, ownerLoginRolePostureProblems } from '../../database/boot-checks/owner-login-posture';
import { installSessionRoleResetOnAcquire } from '../../database/postgres/session-role-reset';
import { readSemanticPosture, semanticDriftFromSnapshot } from '../../database/posture-drift/semantic-posture';
import { GRANT_PARITY_TARGETS } from '../../database/typeorm/core/grant-parity-guard-sql';
import { PREAUTH_FORCE_TABLES } from '../../database/typeorm/core/preauth-force-sql';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

/**
 * Owner-login guards on REAL PostgreSQL (disposable PG16 / PG18 built with the owner-login bootstrap), as crewflow_owner:
 *   - the in-place guard rules hold on the healthy database and refuse planted backdoors (G-12 / G-04);
 *   - M-T1: the 16 pre-auth tables are FORCE with their definer policy; the owner login sees zero rows without context;
 *     the definers still see every row (rab_secure_owner);
 *   - M-T2 + grant parity (PAY-1): the owner login itself is refused (42501) where crewflow_app was; crewflow passes;
 *   - pool safety: a session-level SET ROLE on connection N does not reach the next checkout;
 *   - the semantic posture monitor sees the four planted backdoors (ALTER POLICY USING (true), a trojaned definer, an
 *     extra LOGIN member, a disabled MFA trigger);
 *   - injection payloads executed as BOUND values change nothing.
 * Every planted change is inside a transaction that is ROLLED BACK. Skipped (NOT a pass) unless TEST_DATABASE_URL is the
 * owner login.
 */
const env = (() => {
  try {
    return resolveIntegrationTestDatabase(process.env);
  } catch {
    return null;
  }
})();
const appUser = (() => {
  try {
    return decodeURIComponent(new URL(process.env.TEST_DATABASE_URL ?? '').username);
  } catch {
    return '';
  }
})();
const OWNER = appUser === 'crewflow_owner' && env !== null;
const suite = OWNER ? describe : describe.skip;
if (!OWNER) console.warn('[owner-login guards] SKIPPED: TEST_DATABASE_URL is not the owner login crewflow_owner (NOT a pass).'); // eslint-disable-line no-console

type Rows = Array<Record<string, unknown>>;

suite('owner-login guards (real PostgreSQL, as crewflow_owner)', () => {
  let owner: Client;
  let admin: Client;
  const q = (c: Client) => async (sql: string, params?: unknown[]): Promise<Rows> => (await c.query(sql, params as unknown[] | undefined)).rows;
  const tx = async <T>(c: Client, fn: () => Promise<T>): Promise<T> => {
    await c.query('BEGIN');
    try {
      return await fn();
    } finally {
      await c.query('ROLLBACK');
    }
  };
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    admin = new Client({ connectionString: env!.adminUrl });
    await owner.connect();
    await admin.connect();
  });
  afterAll(async () => {
    await owner?.end();
    await admin?.end();
  });

  describe('in-place guard rules', () => {
    it('the healthy owner-login database passes the role and object posture', async () => {
      expect(await ownerLoginRolePostureProblems(q(owner))).toEqual([]);
      expect(await ownerLoginObjectPostureProblems(q(owner))).toEqual([]);
    });

    it('refuses planted backdoors: a LOGIN member of rab_secure_owner, an ADMIN-only grant, an owner role turned LOGIN, a member of crewflow_worker', async () => {
      await tx(owner, async () => {
        await owner.query('CREATE ROLE g_backdoor LOGIN');
        await owner.query('GRANT rab_secure_owner TO g_backdoor');
        await owner.query('CREATE ROLE g_admin_only NOLOGIN');
        await owner.query('GRANT crewflow TO g_admin_only WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
        await owner.query('ALTER ROLE rab_owner LOGIN');
        const out = (await ownerLoginRolePostureProblems(q(owner))).join('; ');
        expect(out).toMatch(/"g_backdoor" is a member of owner role "rab_secure_owner"/);
        expect(out).toMatch(/"g_admin_only" is a member of owner role "crewflow" \(admin=true inherit=false set=false\)/);
        expect(out).toMatch(/owner role "rab_owner" is LOGIN/);
      });
      await tx(owner, async () => {
        await owner.query('GRANT crewflow_worker TO crewflow_owner');
        expect((await ownerLoginRolePostureProblems(q(owner))).join('; ')).toMatch(/member of "crewflow_worker"/);
      });
    });

    it('the reachability walk refuses a reachable BYPASSRLS / predefined role (planted by the superuser; the login cannot create one)', async () => {
      await tx(admin, async () => {
        await admin.query('CREATE ROLE g_bypass NOLOGIN BYPASSRLS');
        await admin.query('GRANT g_bypass TO rab_app WITH INHERIT FALSE, SET FALSE');
        await admin.query('GRANT pg_read_all_data TO rab_owner WITH INHERIT FALSE, SET FALSE');
        const out = (await ownerLoginRolePostureProblems(async (sql, params) => {
          // Evaluate as the owner login's session_user inside the superuser's transaction (catalog reads only).
          await admin.query(`SET LOCAL ROLE crewflow_owner`);
          try {
            return (await admin.query(sql.replace(/session_user/g, `'crewflow_owner'::name`), params as unknown[] | undefined)).rows;
          } finally {
            await admin.query('RESET ROLE');
          }
        })).join('; ');
        expect(out).toMatch(/"g_bypass" has BYPASSRLS and is reachable from crewflow_owner \(crewflow_owner>rab_app>g_bypass\)/);
        expect(out).toMatch(/predefined role "pg_read_all_data" is reachable/);
      });
    });

    // Agent 5's negative controls NEG-1..NEG-5 (twenty-refusals.integration.spec.ts, same setup SQL), run through the
    // REAL in-place gate rules (the function the boot gate, assertRuntimeDbRole and check-rls-coverage call).
    it.each([
      ['NEG-1', ['CREATE ROLE twa_t7_fake_bypass NOLOGIN BYPASSRLS', 'GRANT twa_t7_fake_bypass TO crewflow_owner WITH INHERIT FALSE, SET TRUE'], /"twa_t7_fake_bypass" has BYPASSRLS/],
      ['NEG-2', ['CREATE ROLE twa_t7_fake_super NOLOGIN SUPERUSER', 'GRANT twa_t7_fake_super TO crewflow WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'], /"twa_t7_fake_super" has SUPERUSER and is reachable from crewflow_owner \(crewflow_owner>crewflow>twa_t7_fake_super\)/],
      ['NEG-3', ['GRANT pg_read_all_data TO crewflow_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'], /predefined role "pg_read_all_data"/],
      ['NEG-4', ['CREATE ROLE neon_superuser NOLOGIN CREATEROLE', 'GRANT neon_superuser TO crewflow_owner'], /provider administrator role "neon_superuser"/],
      ['NEG-5', ['GRANT pg_execute_server_program TO rab_secure_owner'], /predefined role "pg_execute_server_program" is reachable from crewflow_owner \(crewflow_owner>rab_secure_owner>pg_execute_server_program\)/],
    ] as const)('%s: the boot-gate role rules refuse the planted path', async (_id, setup, pattern) => {
      await tx(admin, async () => {
        for (const sql of setup) await admin.query(sql);
        // Evaluated for the owner login inside the superuser's open transaction (it sees the uncommitted grants).
        const out = await ownerLoginRolePostureProblems(async (sql, params) =>
          (await admin.query(sql.replace(/session_user/g, `'crewflow_owner'::name`).replace(/current_user/g, `'crewflow_owner'::name`), params as unknown[] | undefined)).rows,
        );
        expect(out.join('; ')).toMatch(pattern);
      });
      expect(await ownerLoginRolePostureProblems(q(owner))).toEqual([]);
    });

    it('the object posture refuses NO FORCE on a pre-auth table, a dropped definer policy and an object owned by the login', async () => {
      await tx(owner, async () => {
        await owner.query(`ALTER TABLE core.user_session NO FORCE ROW LEVEL SECURITY`);
        await owner.query(`DROP POLICY member_invitation_secure_owner_definer ON core.member_invitation`);
        await owner.query(`CREATE TABLE public.g_owned (id int)`);
        const out = (await ownerLoginObjectPostureProblems(q(owner))).join('; ');
        expect(out).toMatch(/not-forced\|core\.user_session/);
        expect(out).toMatch(/core\.member_invitation: owner-only definer policy member_invitation_secure_owner_definer is missing/);
        expect(out).toMatch(/public-object\|public\.g_owned\|crewflow_owner/);
      });
    });
  });

  describe('M-T1 (pre-auth tables)', () => {
    it('all 16 are ENABLE + FORCE with their definer policy', async () => {
      const rows = await q(owner)(
        `SELECT c.relname AS t, c.relrowsecurity AS e, c.relforcerowsecurity AS f,
                EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = c.relname || '_secure_owner_definer') AS p
           FROM pg_class c WHERE c.relnamespace = 'core'::regnamespace AND c.relname = ANY($1::text[]) ORDER BY 1`,
        [[...PREAUTH_FORCE_TABLES]],
      );
      expect(rows).toHaveLength(16);
      expect(rows.filter((r) => !(r.e && r.f && r.p))).toEqual([]);
    });

    it('without tenant context the owner login sees zero rows in every pre-auth table; as rab_secure_owner (a definer) it sees them all', async () => {
      for (const t of PREAUTH_FORCE_TABLES) {
        const [{ n }] = await q(owner)(`SELECT count(*)::int AS n FROM core."${t}"`);
        expect({ t, n }).toEqual({ t, n: 0 });
      }
      const all = await q(admin)(`SELECT count(*)::int AS n FROM core.organisation`);
      const viaDefinerRole = await tx(owner, async () => {
        await owner.query('SET LOCAL ROLE rab_secure_owner');
        return q(owner)(`SELECT count(*)::int AS n FROM core.organisation`);
      });
      expect(viaDefinerRole).toEqual(all);
    });

    it('the pre-auth definers still work as the owner login (a session lookup by an unknown hash returns nothing, without error)', async () => {
      await expect(q(owner)(`SELECT * FROM core.auth_find_session_by_web_token_hash($1)`, ['0'.repeat(64)])).resolves.toEqual([]);
    });
  });

  describe('M-T2 and grant parity (PAY-1)', () => {
    it.each(['payroll_run_line', 'payslip_document', 'payroll_calendar_period', 'payroll_record'])('%s: TRUNCATE by the owner login itself is refused with 42501', async (table) => {
      // Statement-level TRUNCATE fires even on an empty table (CASCADE so a referencing table is not the first error).
      expect(await tx(owner, () => code(owner.query(`TRUNCATE core.${table} CASCADE`)))).toBe('42501');
    });

    it.each(['payroll_run_line', 'payslip_document'])('%s: the same TRUNCATE passes after SET LOCAL ROLE crewflow (the migrator / provisioner path)', async (table) => {
      expect(await tx(owner, async () => {
        await owner.query('SET LOCAL ROLE crewflow');
        return code(owner.query(`TRUNCATE core.${table}`));
      })).toBe('ok');
    });

    it('row-level UPDATE / DELETE guards: a planted payroll_run_line row cannot be changed or deleted by the owner login (PAY-1)', async () => {
      // Plant through the superuser (bypasses RLS and triggers' role check), then act as the owner login with the row's tenant bound.
      const [row] = await q(admin)(`SELECT id, organisation_id FROM core.payroll_run_line LIMIT 1`);
      if (!row) {
        // No payroll fixtures on a migrations-only database: prove the trigger wiring instead (UPDATE / DELETE on every row).
        const [t] = await q(owner)(
          `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'core.payroll_run_line'::regclass AND tgname IN ('payroll_run_line_grant_parity_update', 'payroll_run_line_grant_parity_delete')`,
        );
        expect(t!.n).toBe(2);
        return;
      }
      const result = await tx(owner, async () => {
        await owner.query(`SELECT set_config('rab.organisation_id', $1, true)`, [row.organisation_id]);
        return code(owner.query(`UPDATE core.payroll_run_line SET amount_pence = 1 WHERE id = $1`, [row.id]));
      });
      expect(result).toBe('42501');
    });

    it('every reviewed parity trigger exists and is enabled', async () => {
      const rows = await q(owner)(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE '%\\_grant\\_parity\\_%' AND tgenabled = 'O'`);
      expect(rows[0]!.n).toBe(Object.values(GRANT_PARITY_TARGETS).reduce((n, ops) => n + ops.length, 0));
    });

    it('the registry guard body is the M-T2 allow-list', async () => {
      const [r] = await q(owner)(`SELECT prosrc FROM pg_proc WHERE oid = 'core.workspace_schema_registry_versioning_guard()'::regprocedure`);
      expect(String(r!.prosrc)).toMatch(/current_user IN \('crewflow'::name, 'rab_secure_owner'::name\)/);
    });
  });

  describe('pool safety (G-09)', () => {
    it('a session-level SET ROLE on the only pooled connection never reaches the next checkout', async () => {
      const make = () => new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      // Control: without the reset the poisoned role survives COMMIT and release.
      const bare = make();
      try {
        const c1 = await bare.connect();
        await c1.query(`BEGIN; SELECT set_config('role', 'rab_secure_owner', false); COMMIT`);
        c1.release();
        const c2 = await bare.connect();
        expect((await c2.query('SELECT current_user::text AS u')).rows[0].u).toBe('rab_secure_owner');
        await c2.query('RESET ROLE');
        c2.release();
      } finally {
        await bare.end();
      }
      const safe = make();
      installSessionRoleResetOnAcquire(safe);
      try {
        const c1 = await safe.connect();
        await c1.query('SET ROLE rab_secure_owner');
        c1.release();
        const c2 = await safe.connect();
        expect((await c2.query('SELECT current_user::text AS u, session_user::text AS s')).rows[0]).toEqual({ u: 'crewflow_owner', s: 'crewflow_owner' });
        c2.release();
      } finally {
        await safe.end();
      }
    });
  });

  describe('semantic posture monitor: planted backdoors are detected', () => {
    it.each([
      ['ALTER POLICY … USING (true)', `ALTER POLICY user_select ON core."user" USING (true)`, /\[core\] \+ policy\|user\|user_select/],
      [
        'a trojaned SECURITY DEFINER body',
        `CREATE OR REPLACE FUNCTION core.auth_find_session_by_web_token_hash(p text) RETURNS SETOF core.user_session LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$ SELECT * FROM core.user_session $f$`,
        /function\|auth_find_session_by_web_token_hash/,
      ],
      ['an extra LOGIN member', `CREATE ROLE g_monitor_agent LOGIN; GRANT rab_secure_owner TO g_monitor_agent`, /\[roles\] \+ member\|rab_secure_owner\|g_monitor_agent/],
      ['a disabled MFA trigger', `ALTER TABLE core."user" DISABLE TRIGGER user_mfa_columns_guard`, /trigger\|user\|user_mfa_columns_guard\|enabled=D/],
      ['NO FORCE on a tenant table', `ALTER TABLE core.shift NO FORCE ROW LEVEL SECURITY`, /rls\|shift\|enable=true\|force=false/],
      ['an audit_log re-grant', `GRANT UPDATE, DELETE ON core.audit_log TO crewflow`, /acl\|audit_log\|crewflow:(UPDATE|DELETE)/],
    ])('%s', async (_label, plant, pattern) => {
      const baseline = await readSemanticPosture(q(owner));
      const drift = await tx(owner, async () => {
        for (const sql of plant.split('; ')) await owner.query(sql);
        return semanticDriftFromSnapshot(baseline, await readSemanticPosture(q(owner), { ownTransaction: false }));
      });
      const text = drift.flatMap((d) => [...d.missing.map((l) => `[${d.section}] - ${l}`), ...d.unexpected.map((l) => `[${d.section}] + ${l}`)]).join('\n');
      expect(text).toMatch(pattern);
      // Read only: after the rollback the posture is exactly the baseline again (the monitor never rewrote anything).
      expect((await readSemanticPosture(q(owner))).sha256).toBe(baseline.sha256);
    });
  });

  describe('injection payloads as bound values change nothing', () => {
    it.each(["'; DROP SCHEMA core CASCADE; --", "x'); SET ROLE rab_secure_owner; --", "' OR '1'='1"])('%p', async (payload) => {
      const before = (await readSemanticPosture(q(owner))).sha256;
      await q(owner)(`SELECT count(*) FROM core.organisation WHERE name = $1 OR id::text = $1`, [payload]);
      await q(owner)(`SELECT set_config('rab.organisation_id', $1, true)`, [payload]).catch(() => undefined);
      expect((await q(owner)('SELECT current_user::text AS u'))[0]!.u).toBe('crewflow_owner');
      expect((await readSemanticPosture(q(owner))).sha256).toBe(before);
    });
  });
});

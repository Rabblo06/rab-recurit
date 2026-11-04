/**
 * T7 refusals + negative controls on a REAL chain database. The MEMBER-semantics reachability walk (M0 §6.4 #7, G-12) must
 * flag every privileged role the Option A login could reach by INHERIT, SET **or ADMIN**, including predefined pg_* roles
 * and provider super-roles (neon_superuser simulation). Each negative control is created inside a transaction on the
 * fixture superuser's connection and rolled back; the walk runs on that same transaction so it sees the uncommitted grant.
 *
 * The SQL here is the REFERENCE ORACLE (REACHABILITY_SQL in scripts/twenty-mode-check.ts). The same negative controls are
 * then run against the REAL in-place gate, Agent 3's ownerLoginRolePostureProblems (boot-checks/owner-login-posture.ts),
 * on the owner login's own connection: each must be refused. That part runs only on a real owner-login install
 * (TWENTY_DB_SOURCE=bootstrap) and only once twa/security is merged; until then it is SKIPPED BY NAME, never reported passed.
 * Gated: see twenty-kit.ts.
 */
import { Client } from 'pg';

import { REACHABILITY_SQL } from '../../../database/typeorm/scripts/twenty-mode-check';
import { ADMIN_URL, connect, controlHolds, describeTwenty, OWNER_URL, TWENTY_DB_SOURCE } from './twenty-kit';

type PostureQuery = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
/** Agent 3's in-place gate, when it exists in this checkout (twa/security merged); null otherwise. */
function loadRolePostureGate(): ((query: PostureQuery) => Promise<string[]>) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../database/boot-checks/owner-login-posture') as { ownerLoginRolePostureProblems?: (q: PostureQuery) => Promise<string[]> };
    return mod.ownerLoginRolePostureProblems ?? null;
  } catch {
    return null;
  }
}
const ROLE_POSTURE_GATE = loadRolePostureGate();
const GATE_RUN = ROLE_POSTURE_GATE !== null && TWENTY_DB_SOURCE === 'bootstrap';

jest.setTimeout(60_000);

describeTwenty('Twenty refusals: reachability walk and negative controls (crewflow_owner)', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await connect(ADMIN_URL!, 'twenty-t7-refusals');
  });
  afterAll(async () => {
    await admin?.end();
  });

  const walk = async () => (await admin.query(REACHABILITY_SQL, ['crewflow_owner'])).rows.map((r) => `${r.rolname} via ${r.path}`);

  async function inTx(setup: string[]): Promise<string[]> {
    await admin.query('BEGIN');
    try {
      for (const s of setup) await admin.query(s);
      return await walk();
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  it('baseline: crewflow_owner reaches no superuser, BYPASSRLS, REPLICATION, predefined or provider super-role', async () => {
    const problems = await walk();
    expect(problems).toEqual([]);
    const attrs = (await admin.query(`SELECT rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'crewflow_owner'`)).rows[0];
    expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false, rolreplication: false, rolcreatedb: false, rolcreaterole: true });
    controlHolds('REF-0', 'crewflow_owner: NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB, no privileged role reachable', 'walk empty');
  });

  const controls: Array<{ id: string; what: string; setup: string[]; teardown: string[]; flags: RegExp }> = [
    {
      id: 'NEG-1', what: 'a SET-only grant of a BYPASSRLS role (INHERIT FALSE)',
      setup: ['CREATE ROLE twa_t7_fake_bypass NOLOGIN BYPASSRLS', 'GRANT twa_t7_fake_bypass TO crewflow_owner WITH INHERIT FALSE, SET TRUE'],
      teardown: ['REVOKE twa_t7_fake_bypass FROM crewflow_owner', 'DROP ROLE IF EXISTS twa_t7_fake_bypass'],
      flags: /twa_t7_fake_bypass/,
    },
    {
      id: 'NEG-2', what: 'a SUPERUSER role reachable only through ADMIN on an intermediate role (crewflow)',
      setup: ['CREATE ROLE twa_t7_fake_super NOLOGIN SUPERUSER', 'GRANT twa_t7_fake_super TO crewflow WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'],
      teardown: ['REVOKE twa_t7_fake_super FROM crewflow', 'DROP ROLE IF EXISTS twa_t7_fake_super'],
      flags: /twa_t7_fake_super via crewflow_owner>crewflow>twa_t7_fake_super/,
    },
    {
      id: 'NEG-3', what: 'an ADMIN-only path to the predefined pg_read_all_data role',
      setup: ['GRANT pg_read_all_data TO crewflow_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'],
      teardown: ['REVOKE pg_read_all_data FROM crewflow_owner'],
      flags: /pg_read_all_data/,
    },
    {
      id: 'NEG-4', what: 'a provider super-role by name (neon_superuser simulation: CREATEROLE NOLOGIN, not itself superuser)',
      setup: ['CREATE ROLE neon_superuser NOLOGIN CREATEROLE', 'GRANT neon_superuser TO crewflow_owner'],
      teardown: ['REVOKE neon_superuser FROM crewflow_owner', 'DROP ROLE IF EXISTS neon_superuser'],
      flags: /neon_superuser/,
    },
    {
      id: 'NEG-5', what: 'pg_execute_server_program granted to a role the owner can SET into',
      setup: ['GRANT pg_execute_server_program TO rab_secure_owner'],
      teardown: ['REVOKE pg_execute_server_program FROM rab_secure_owner'],
      flags: /pg_execute_server_program via crewflow_owner>rab_secure_owner/,
    },
  ];

  it.each(controls)('negative control $id is flagged: $what', async ({ setup, flags }) => {
    const problems = await inTx(setup);
    expect(problems.join('\n')).toMatch(flags);
    // ...and the baseline is clean again after the rollback (the control never leaks into the next case).
    expect(await walk()).toEqual([]);
  });

  it('B3 negative control: a membership of crewflow_worker is detectable (members must stay 0)', async () => {
    const members = async () => Number((await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid = 'crewflow_worker'::regrole`)).rows[0].n);
    expect(await members()).toBe(0);
    await admin.query('BEGIN');
    try {
      await admin.query('GRANT crewflow_worker TO crewflow_owner WITH INHERIT FALSE, SET FALSE');
      expect(await members()).toBe(1);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await members()).toBe(0);
  });

  describe(`the in-place role posture gate (ownerLoginRolePostureProblems)${GATE_RUN ? '' : ' (SKIPPED: needs twa/security merged and TWENTY_DB_SOURCE=bootstrap)'}`, () => {
    const gateIt = GATE_RUN ? it : it.skip;
    let owner: Client;
    const asOwner: PostureQuery = async (sql, params) => (await owner.query(sql, params as unknown[])).rows;
    beforeAll(async () => {
      if (GATE_RUN) owner = await connect(OWNER_URL!, 'twenty-t7-posture-gate');
    });
    afterAll(async () => {
      await owner?.end();
    });

    gateIt('baseline: the real gate finds no problem on a real owner-login install', async () => {
      expect(await ROLE_POSTURE_GATE!(asOwner)).toEqual([]);
      controlHolds('REF-GATE-0', 'ownerLoginRolePostureProblems: empty on a real owner-login install', '[]');
    });

    // Each control is COMMITTED (the owner's own connection must see it), then reverted in finally; disposable cluster only.
    gateIt.each(controls)('negative control $id makes the real gate refuse: $what', async ({ id, setup, teardown }) => {
      await admin.query('BEGIN');
      for (const stmt of setup) await admin.query(stmt);
      await admin.query('COMMIT');
      try {
        const problems = await ROLE_POSTURE_GATE!(asOwner);
        expect(problems.length).toBeGreaterThan(0);
        controlHolds(`${id}/gate`, 'the in-place role posture gate refuses the negative control', problems.slice(0, 2).join('; ').slice(0, 200));
      } finally {
        for (const stmt of teardown) await admin.query(stmt).catch(() => undefined);
      }
      expect(await walk()).toEqual([]);
      expect(await ROLE_POSTURE_GATE!(asOwner)).toEqual([]);
    });
  });
});

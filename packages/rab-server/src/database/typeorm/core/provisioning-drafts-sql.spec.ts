import { migrationSourceViolations } from './migration-source-rules';
import {
  DYNAMIC_SQL_SECURE_DEFINERS_SQL,
  R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS,
  R4_TABLES_SQL,
  REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS,
} from './secure-owner-invariants';
import { VenueTeamOrgAdmin1786721090000 } from './migrations/1786721090000-VenueTeamOrgAdmin';
import { ProvisionWorkspaceGuards1786721210000 } from './migrations/1786721210000-ProvisionWorkspaceGuards';
import { ProvisioningHealth1786721220000 } from './migrations/1786721220000-ProvisioningHealth';
import {
  GUARDS_PROVISION_APP_VERSION,
  GUARDS_THROUGH_VERSION,
  PREVIOUS_PROVISION_APP_VERSION,
  provisionWorkspaceGuardsDownSql,
  provisionWorkspaceGuardsUpSql,
  SHARED_PROVISIONING_LOCK_SQL,
} from './provision-workspace-guards-sql';
import {
  PROVISIONING_HEALTH_DOWN_SQL,
  PROVISIONING_HEALTH_EXPECTED_STATE,
  PROVISIONING_HEALTH_GOLDEN_LINES,
  PROVISIONING_HEALTH_UP_SQL,
} from './workspace-provisioning-health-sql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../workspace-schema/workspace-schema-modules';

/**
 * Phase B P8 migrations 1786721210000 (owner decision B) and 1786721220000 (owner decision C: counts-only health ONLY; the
 * drift wrapper is deferred as an HWS prerequisite): pure unit tests, no database. The applied behaviour is covered by
 * src/__tests__/integration/provisioning-drafts.integration.spec.ts on the harness-built database.
 */

/** Runs a migration method against a fake QueryRunner and returns every SQL statement it sent, in order. */
async function capture(run: (runner: never) => Promise<void>, answer: (sql: string) => unknown[] = () => [], stopAfter?: (sql: string) => boolean): Promise<string[]> {
  const sql: string[] = [];
  const STOP = new Error('stop');
  const runner = {
    isTransactionActive: true,
    query: async (q: string) => {
      sql.push(q);
      if (stopAfter?.(q)) throw STOP;
      return answer(q);
    },
  };
  await run(runner as never).catch((e) => {
    if (e !== STOP) throw e;
  });
  return sql;
}

const isProvisionDdl = (q: string) => /OR REPLACE FUNCTION core\.provision_workspace\(/.test(q);

/** Catalog answers of a database where every Phase 0b secure-owner invariant holds (no violation, frozen lists as reviewed). */
function invariantsHold(q: string): unknown[] | undefined {
  if (q === R4_TABLES_SQL) return R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS.map((relname) => ({ relname }));
  if (q === DYNAMIC_SQL_SECURE_DEFINERS_SQL) return REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS.map((fn) => ({ fn }));
  return undefined;
}

describe('ProvisionWorkspaceGuards1786721210000: provision_workspace v3', () => {
  it('is authored against the latest module composition (re-base this draft if a module migration lands first)', () => {
    expect(GUARDS_THROUGH_VERSION).toBe(LATEST_WORKSPACE_MODULE_VERSION);
  });

  it('down() restores byte-for-byte the statement VenueTeamOrgAdmin1786721090000 itself sends (captured, not re-typed)', async () => {
    const venueTeam = await capture(
      (r) => new VenueTeamOrgAdmin1786721090000().up(r),
      () => [],
      isProvisionDdl,
    );
    const emitted = venueTeam.find(isProvisionDdl);
    expect(emitted).toBeDefined();
    expect(provisionWorkspaceGuardsDownSql()).toBe(emitted);
    expect(emitted).toContain(PREVIOUS_PROVISION_APP_VERSION);
  });

  it('up() = that exact body plus ONLY the three insertions (shared lock, CWP01, CWP02) and its own app_version', () => {
    const up = provisionWorkspaceGuardsUpSql();
    const down = provisionWorkspaceGuardsDownSql();
    const stripped = up
      .replace(/      -- Phase B P8 \(E6 gate 8\)[\s\S]*?pg_advisory_xact_lock_shared[^\n]*\n/, '')
      .replace(/\n      -- Phase B P8 \(E6 gates 3-4[\s\S]*?USING ERRCODE = 'CWP02';\n      END IF;\n/, '')
      .split(GUARDS_PROVISION_APP_VERSION)
      .join(PREVIOUS_PROVISION_APP_VERSION);
    expect(stripped).toBe(down);
    expect(up.split(SHARED_PROVISIONING_LOCK_SQL)).toHaveLength(2);
    expect(up.match(/ERRCODE = 'CWP01'/g)).toHaveLength(1);
    expect(up.match(/ERRCODE = 'CWP02'/g)).toHaveLength(1);
  });

  it('keeps the privilege shape text: CREATE OR REPLACE, DEFINER, pinned search_path and lock_timeout; the added lines grant nothing', () => {
    const up = provisionWorkspaceGuardsUpSql();
    const before = new Set(provisionWorkspaceGuardsDownSql().split('\n'));
    const added = up.split('\n').filter((line) => !before.has(line));
    expect(added.length).toBeGreaterThan(0);
    expect(added.join('\n')).not.toMatch(/\b(GRANT|REVOKE|OWNER|ROLE|SECURITY)\b|EXECUTE\s|SET\s+search_path/i);
    expect(up).toMatch(/^\s*CREATE OR REPLACE FUNCTION core\.provision_workspace\(p_workspace_id uuid\)\n\s*RETURNS text\n\s*LANGUAGE plpgsql\n\s*SECURITY DEFINER\n\s*SET search_path = pg_catalog, pg_temp\n\s*SET lock_timeout = '30s'/);
  });

  it('the shared lock is the worker provisioner\'s exact key (int4 hashtext widened to bigint), taken BEFORE the per-workspace lock', () => {
    const up = provisionWorkspaceGuardsUpSql();
    const worker = readFileSync(join(__dirname, '../../../../../rab-worker/src/queues/rab-maintenance/workspace-provisioning.job.ts'), 'utf8');
    expect(worker).toContain("const PROVISIONING_LOCK_SQL_KEY = `hashtext('rab_workspace_provisioning')`;");
    expect(worker).toContain('pg_try_advisory_lock(${PROVISIONING_LOCK_SQL_KEY})');
    const shared = up.indexOf("pg_advisory_xact_lock_shared(pg_catalog.hashtext('rab_workspace_provisioning')::bigint)");
    const perWorkspace = up.indexOf("pg_advisory_xact_lock(pg_catalog.hashtext('rab_workspace_provisioning'), pg_catalog.hashtext(p_workspace_id::text))");
    expect(shared).toBeGreaterThan(0);
    expect(perWorkspace).toBeGreaterThan(shared);
  });

  it('suspension / account checks run AFTER the ownership check (a foreign id stays P0002) and BEFORE any lifecycle change', () => {
    const up = provisionWorkspaceGuardsUpSql();
    const ownership = up.indexOf("v_owner::text IS DISTINCT FROM v_bound_uid THEN");
    const org = up.indexOf("ERRCODE = 'CWP01'");
    const account = up.indexOf("ERRCODE = 'CWP02'");
    const begin = up.indexOf('PERFORM core.begin_workspace_schema_attempt(p_workspace_id);');
    const ready = up.indexOf("IF v_status = 'READY' THEN");
    expect(ownership).toBeGreaterThan(0);
    expect(org).toBeGreaterThan(ownership);
    expect(account).toBeGreaterThan(org);
    expect(ready).toBeGreaterThan(account);
    expect(begin).toBeGreaterThan(ready);
    expect(up).toContain("FROM core.organisation o WHERE o.id = v_org AND o.suspended_at IS NULL");
    expect(up).toContain(`FROM core."user" u WHERE u.id = v_owner AND u.status = 'active'`);
  });

  it('up() refuses unless the installed body is the 1786721090000 one, and re-verifies shape + invariants after the change', async () => {
    const migration = new ProvisionWorkspaceGuards1786721210000();
    const wrongBody = capture((r) => migration.up(r), (q) => (q.includes('is_previous_body') ? [{ is_previous_body: false, has_guards: false }] : []));
    await expect(wrongBody).rejects.toThrow(/not the VenueTeamOrgAdmin1786721090000 body/);

    let installed = false;
    const sent = await capture(
      (r) => migration.up(r),
      (q) => {
        if (isProvisionDdl(q)) installed = true;
        if (q.includes('is_previous_body')) {
          return [{ owner: 'crewflow', definer: true, path_ok: true, lock_timeout_ok: true, executors: 'crewflow,crewflow_app',
            is_previous_body: !installed, is_guarded_body: installed, has_guards: installed }];
        }
        return invariantsHold(q) ?? []; // secure-owner invariants: no violation rows, frozen lists as reviewed
      },
    );
    expect(sent.filter(isProvisionDdl)).toEqual([provisionWorkspaceGuardsUpSql()]);
    expect(sent.some((q) => q.includes('reachable-function-owner'))).toBe(true);
  });

  it('down() sends exactly the restore statement and fails closed if the guards are still present afterwards', async () => {
    const migration = new ProvisionWorkspaceGuards1786721210000();
    const restored = { owner: 'crewflow', definer: true, path_ok: true, lock_timeout_ok: true, executors: 'crewflow,crewflow_app', is_previous_body: true, is_guarded_body: false, has_guards: false };
    const sent = await capture((r) => migration.down(r), (q) => (q.includes('is_previous_body') ? [restored] : invariantsHold(q) ?? []));
    expect(sent.filter(isProvisionDdl)).toEqual([provisionWorkspaceGuardsDownSql()]);
    await expect(capture((r) => migration.down(r), (q) => (q.includes('is_previous_body') ? [{ ...restored, has_guards: true }] : []))).rejects.toThrow(/guards present/);
  });

  it('passes the post-Phase-0b source rules (in core/migrations/, so every runner and the harness load it)', () => {
    expect(migrationSourceViolations(readFileSync(join(__dirname, 'migrations/1786721210000-ProvisionWorkspaceGuards.ts'), 'utf8'))).toEqual([]);
  });
});

describe('ProvisioningHealth1786721220000: counts-only health definer (the drift wrapper is deferred)', () => {
  const health = PROVISIONING_HEALTH_UP_SQL[0]!;

  it('health: rab_secure_owner SECURITY DEFINER, pinned search_path, counts only (no id / org / name / email / error column)', () => {
    expect(health).toMatch(/RETURNS TABLE \(creating_over_10_min integer, failed integer\)/);
    expect(health).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp/);
    expect(health).not.toMatch(/\b(id|organisation_id|owner_user_id|name|subdomain|email|schema_last_error)\b\s*(,|\n|FROM)/);
    expect(health).toContain("w.schema_status = 'CREATING'");
    expect(health).toContain("w.created_at < pg_catalog.now() - interval '10 minutes'");
    expect(health).toContain("w.schema_status = 'FAILED'");
    expect(health).toContain("WHERE w.status = 'active'");
    expect(PROVISIONING_HEALTH_UP_SQL).toContain('ALTER FUNCTION core.worker_workspace_provisioning_health() OWNER TO rab_secure_owner');
    expect(PROVISIONING_HEALTH_UP_SQL).toContain('GRANT EXECUTE ON FUNCTION core.worker_workspace_provisioning_health() TO crewflow_app');
    expect(PROVISIONING_HEALTH_UP_SQL.join('\n')).not.toMatch(/TO PUBLIC|TO crewflow\b(?!_app)/);
  });

  it('health body names no core function and no crewflow-owned table (Phase 0b reachability / R4 lists unchanged)', () => {
    const body = health.slice(health.indexOf('$health$') + 8, health.lastIndexOf('$health$'));
    expect(body).not.toMatch(/\bcore\.\w+\s*\(/);
    expect(body.match(/\bcore\.(\w+)/g)).toEqual(['core.manager_workspace']);
  });

  it('owner decision C: no drift wrapper, no crewflow CREATE window, nothing crewflow-owned (deferred as an HWS prerequisite)', () => {
    const src = readFileSync(join(__dirname, 'migrations/1786721220000-ProvisioningHealth.ts'), 'utf8');
    const sql = readFileSync(join(__dirname, 'workspace-provisioning-health-sql.ts'), 'utf8');
    for (const text of [src, PROVISIONING_HEALTH_UP_SQL.join('\n'), PROVISIONING_HEALTH_DOWN_SQL.join('\n')]) {
      expect(text).not.toMatch(/worker_record_workspace_schema_drift|withCrewflowCoreCreate|OWNER TO crewflow\b|GRANT CREATE/);
    }
    expect(sql).not.toMatch(/CREATE FUNCTION core\.worker_record_workspace_schema_drift/);
    expect(PROVISIONING_HEALTH_UP_SQL.filter((q) => q.startsWith('CREATE'))).toHaveLength(1);
  });

  it('up(): creates the one definer, hands it to rab_secure_owner, grants crewflow_app, self-checks; down() drops it', async () => {
    const migration = new ProvisioningHealth1786721220000();
    const sent = await capture(
      (r) => migration.up(r),
      (q) => {
        if (q.includes('worker_workspace_provisioning_health') && q.includes('aclexplode')) return [...PROVISIONING_HEALTH_EXPECTED_STATE];
        return invariantsHold(q) ?? [];
      },
    );
    const create = sent.indexOf(PROVISIONING_HEALTH_UP_SQL[0]!);
    const owner = sent.indexOf('ALTER FUNCTION core.worker_workspace_provisioning_health() OWNER TO rab_secure_owner');
    const grant = sent.indexOf('GRANT EXECUTE ON FUNCTION core.worker_workspace_provisioning_health() TO crewflow_app');
    expect(create).toBeGreaterThan(0);
    expect(owner).toBeGreaterThan(create);
    expect(grant).toBeGreaterThan(owner);
    expect(sent.some((q) => /GRANT CREATE ON SCHEMA core/.test(q))).toBe(false);
    expect(sent.some((q) => q.includes('reachable-function-owner'))).toBe(true);

    await expect(capture((r) => migration.up(r), () => [])).rejects.toThrow(/unexpected function state/);

    const down = await capture((r) => migration.down(r), (q) => (q.includes('AS gone') ? [{ gone: true }] : []));
    for (const sql of PROVISIONING_HEALTH_DOWN_SQL) expect(down).toContain(sql);
    await expect(capture((r) => migration.down(r), (q) => (q.includes('AS gone') ? [{ gone: false }] : []))).rejects.toThrow(/remain after down/);
  });

  it('golden posture lines: exactly 4 function lines, sorted, all present in security-posture.golden.txt', () => {
    expect(PROVISIONING_HEALTH_GOLDEN_LINES).toHaveLength(4);
    expect([...PROVISIONING_HEALTH_GOLDEN_LINES].sort()).toEqual([...PROVISIONING_HEALTH_GOLDEN_LINES]);
    const golden = readFileSync(join(__dirname, 'security-posture.golden.txt'), 'utf8').split('\n');
    for (const line of PROVISIONING_HEALTH_GOLDEN_LINES) expect(golden).toContain(line);
    expect(golden.filter((l) => l.includes('worker_record_workspace_schema_drift'))).toEqual([]);
  });

  it('passes the post-Phase-0b source rules (in core/migrations/)', () => {
    expect(migrationSourceViolations(readFileSync(join(__dirname, 'migrations/1786721220000-ProvisioningHealth.ts'), 'utf8'))).toEqual([]);
  });
});

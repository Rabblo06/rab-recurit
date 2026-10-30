import { BOOT_FACTS_SQL, FORCE_RLS_SPOT_CHECK_TABLES, FORCE_RLS_SQL, RLS_DISABLED_TENANT_TABLES_SQL } from '../../boot-checks/database-boot-gate-rules';
import { MARKER_PRESENT_SQL, MARKER_READ_SQL } from '../../deployment-identity/deployment-identity';
import { IN_RECOVERY_SQL, LEDGER_HEAD_SQL, ReplicaConfigurationError, ReplicaQuery, SYSTEM_IDENTIFIER_SQL, validateReplica } from './replica-validation';

type Side = {
  inRecovery?: boolean;
  facts?: Record<string, unknown>;
  database?: string;
  systemId?: string | 'denied';
  forced?: boolean;
  marker?: 'absent' | 'unbound' | { environment: string; deploymentId: string; boundDatabase?: string; boundHosts?: string[] };
  head?: string;
};

const goodFacts = {
  who: 'crewflow_app',
  login: 'crewflow_app',
  super: false,
  bypassrls: false,
  login_privileged: false,
  owner_roles: null,
  server_version_num: 160004,
  database: 'crewflow',
  extensions: 'btree_gist,citext,pg_trgm,pgcrypto,unaccent',
  ssl: false,
};

function fake(side: Side): ReplicaQuery {
  return async (sql) => {
    if (sql === IN_RECOVERY_SQL) return [{ in_recovery: side.inRecovery ?? false }];
    if (sql === BOOT_FACTS_SQL) return [{ ...goodFacts, database: side.database ?? 'crewflow', ...(side.facts ?? {}) }];
    if (sql.includes('current_database()::text AS database') && !sql.includes('pg_roles')) return [{ database: side.database ?? 'crewflow' }];
    if (sql === SYSTEM_IDENTIFIER_SQL) {
      if (side.systemId === 'denied') throw Object.assign(new Error('permission denied'), { code: '42501' });
      return [{ id: side.systemId ?? '7300000000000000001' }];
    }
    if (sql === FORCE_RLS_SQL) return FORCE_RLS_SPOT_CHECK_TABLES.map((t) => ({ relname: t, enabled: true, forced: side.forced ?? true }));
    if (sql === RLS_DISABLED_TENANT_TABLES_SQL) return [];
    if (sql === MARKER_PRESENT_SQL) return [{ present: side.marker !== undefined && side.marker !== 'absent', database: 'crewflow' }];
    if (sql === MARKER_READ_SQL) {
      const m = side.marker;
      return m && typeof m === 'object'
        ? [{ environment: m.environment, deployment_id: m.deploymentId, bound_database: m.boundDatabase ?? 'crewflow', bound_hosts: m.boundHosts ?? ['db.primary.internal'] }]
        : [];
    }
    if (sql === LEDGER_HEAD_SQL) return [{ name: side.head ?? 'NavigationLayoutCrewflowOwner1786721110000' }];
    throw new Error(`unexpected SQL in fake: ${sql.slice(0, 60)}`);
  };
}

const primary = (o: Side = {}) => fake({ inRecovery: false, ...o });
const standby = (o: Side = {}) => fake({ inRecovery: true, ...o });

describe('replica validation (B4)', () => {
  it('accepts a standby with the runtime role, same cluster, FORCE RLS, same identity and ledger head', async () => {
    await expect(validateReplica({ primary: primary(), replica: standby(), production: false })).resolves.toEqual({ ok: true, warnings: [] });
  });

  it('refuses a writable primary given as the replica URL', async () => {
    await expect(validateReplica({ primary: primary(), replica: primary(), production: false })).rejects.toThrow(/writable primary/);
  });

  it.each([
    ['a superuser login', { super: true }],
    ['a BYPASSRLS login', { bypassrls: true }],
    ['another role', { who: 'crewflow', login: 'crewflow' }],
    ['an owner-role member', { owner_roles: 'rab_secure_owner' }],
    ['SET ROLE', { login: 'someone_else' }],
  ])('refuses %s on the replica', async (_label, facts) => {
    const error = await validateReplica({ primary: primary(), replica: standby({ facts }), production: false }).catch((e) => e);
    expect(error).toBeInstanceOf(ReplicaConfigurationError);
    expect(error.check).toBe('role');
  });

  it('refuses plaintext in production', async () => {
    const error = await validateReplica({ primary: primary(), replica: standby(), production: true }).catch((e) => e);
    expect(error).toMatchObject({ check: 'tls' });
  });

  it('refuses another cluster or another database; only warns when pg_control_system() is not permitted', async () => {
    await expect(validateReplica({ primary: primary(), replica: standby({ systemId: '999' }), production: false })).rejects.toMatchObject({ check: 'cluster' });
    await expect(validateReplica({ primary: primary(), replica: standby({ database: 'other' }), production: false })).rejects.toMatchObject({ check: 'cluster' });
    const r = await validateReplica({ primary: primary({ systemId: 'denied' }), replica: standby(), production: false });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/not permitted/);
  });

  it('refuses FORCE RLS drift on the replica', async () => {
    await expect(validateReplica({ primary: primary(), replica: standby({ forced: false }), production: false })).rejects.toMatchObject({ check: 'force-rls' });
  });

  it('deployment identity: different bound ids refuse; primary bound + replica not yet is transient; both absent is fine', async () => {
    const a = { environment: 'staging', deploymentId: '11111111-1111-4111-8111-111111111111' };
    const b = { environment: 'staging', deploymentId: '22222222-2222-4222-8222-222222222222' };
    await expect(validateReplica({ primary: primary({ marker: a }), replica: standby({ marker: b }), production: false })).rejects.toMatchObject({ check: 'identity' });
    await expect(validateReplica({ primary: primary({ marker: 'unbound' }), replica: standby({ marker: b }), production: false })).rejects.toMatchObject({
      check: 'identity',
    });
    await expect(validateReplica({ primary: primary({ marker: a }), replica: standby({ marker: 'unbound' }), production: false })).resolves.toMatchObject({
      ok: false,
      reason: 'identity-not-replayed',
    });
    await expect(validateReplica({ primary: primary({ marker: a }), replica: standby({ marker: a }), production: false })).resolves.toMatchObject({ ok: true });
    // Same id but a different recorded location (bound database or host set): not the same marker row -> refused.
    await expect(
      validateReplica({ primary: primary({ marker: a }), replica: standby({ marker: { ...a, boundHosts: ['db.other.internal'] } }), production: false }),
    ).rejects.toMatchObject({ check: 'identity' });
    await expect(
      validateReplica({ primary: primary({ marker: a }), replica: standby({ marker: { ...a, boundDatabase: 'crewflow_copy' } }), production: false }),
    ).rejects.toMatchObject({ check: 'identity' });
  });

  it('a migration ledger behind the primary is transient (not validated), not a configuration error', async () => {
    await expect(validateReplica({ primary: primary(), replica: standby({ head: 'Older1786721100000' }), production: false })).resolves.toEqual({
      ok: false,
      reason: 'ledger-behind',
      warnings: [],
    });
  });
});

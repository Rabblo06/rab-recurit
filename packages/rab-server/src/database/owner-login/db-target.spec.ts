/**
 * The credential-free database target (Twenty Helm model). Writer side (dbTargetFromRuntimeUrl: no login, no password, rebuilds
 * the same connection) and reader side (strict schema, same URL policy as the admin-URL path). Generated test values only.
 */
import { parsePgUrl } from '../postgres/pg-url-policy';
import {
  DB_TARGET_MESSAGES,
  type DbTarget,
  DbTargetError,
  dbTargetFromRuntimeUrl,
  parseDbTarget,
  runtimeUrlFromDbTarget,
  serializeDbTarget,
  validateDbTarget,
} from './db-target';
import { buildRuntimeDatabaseUrl, generateOwnerPassword } from './owner-credential';

const ADMIN_PASSWORD = 'adminSentinel7f3a91';
const DERIVED = generateOwnerPassword();
const APP_SECRET = 'never-part-of-a-database-credential-0123';

/** The target the bootstrap child publishes for this URL and the stored password. */
function targetFor(adminUrl: string) {
  return dbTargetFromRuntimeUrl(buildRuntimeDatabaseUrl(adminUrl, DERIVED), DERIVED);
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DbTargetError) return error.message;
    throw error;
  }
  throw new Error('expected a DbTargetError');
}

const good: DbTarget = { v: 1, host: 'db', port: 5432, database: 'crewflow', params: { sslmode: 'verify-full' } };

describe('db target: the writer side (dbTargetFromRuntimeUrl)', () => {
  it('keeps host, port, database and the kept parameters; drops application_name; carries no credential', () => {
    const admin = `postgres://dbadmin:${ADMIN_PASSWORD}@DB.Example.internal:6543/crewflow_prod?sslmode=verify-full&channel_binding=require&application_name=psql&connect_timeout=10`;
    const target = targetFor(admin);
    expect(target).toEqual({
      v: 1,
      host: 'db.example.internal',
      port: 6543,
      database: 'crewflow_prod',
      params: { sslmode: 'verify-full', channel_binding: 'require', connect_timeout: '10' },
    });
    const text = serializeDbTarget(target);
    for (const forbidden of [ADMIN_PASSWORD, DERIVED, APP_SECRET, 'dbadmin', 'crewflow_owner', '@', 'application_name', 'psql', 'password', 'user']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toBe('{"v":1,"host":"db.example.internal","port":6543,"database":"crewflow_prod","params":{"channel_binding":"require","connect_timeout":"10","sslmode":"verify-full"}}\n');
  });

  it('rebuilding the target gives the same connection as the admin-URL path (also for IPv6 and a Neon endpoint token)', () => {
    for (const admin of [
      `postgres://postgres:${ADMIN_PASSWORD}@db:5432/crewflow?sslmode=verify-full`,
      `postgresql://postgres:${ADMIN_PASSWORD}@[::1]:5433/crewflow`,
      `postgres://neondb_owner:${ADMIN_PASSWORD}@ep-cool-name-123456.eu-west-2.aws.neon.tech/neondb?sslmode=require&options=endpoint%3Dep-cool-name-123456`,
    ]) {
      const fromTarget = parsePgUrl(runtimeUrlFromDbTarget(targetFor(admin), DERIVED), 't');
      const direct = parsePgUrl(buildRuntimeDatabaseUrl(admin, DERIVED), 'd');
      expect(fromTarget.canonicalKey).toBe(direct.canonicalKey);
      expect(fromTarget.password === DERIVED).toBe(true);
      expect(fromTarget.sslmode).toBe(direct.sslmode);
      expect(fromTarget.providerOptions).toBe(direct.providerOptions);
      expect(fromTarget.user).toBe('crewflow_owner');
    }
  });
});

describe('db target: the reader side (strict)', () => {
  it('accepts exactly the canonical text the writer produces', () => {
    expect(parseDbTarget(serializeDbTarget(good))).toEqual(good);
    expect(parseDbTarget(serializeDbTarget({ ...good, params: {} }))).toEqual({ ...good, params: {} });
  });

  it.each([
    ['not JSON', 'not json', DB_TARGET_MESSAGES.notJson],
    ['an array', '[]', DB_TARGET_MESSAGES.shape],
    ['null', 'null', DB_TARGET_MESSAGES.shape],
    ['an extra key (user)', JSON.stringify({ ...good, user: 'crewflow_owner' }), DB_TARGET_MESSAGES.shape],
    ['an extra key (password)', JSON.stringify({ ...good, password: 'x' }), DB_TARGET_MESSAGES.shape],
    ['a missing key', JSON.stringify({ v: 1, host: 'db', port: 5432, params: {} }), DB_TARGET_MESSAGES.shape],
    ['v 2', JSON.stringify({ ...good, v: 2 }), DB_TARGET_MESSAGES.version],
    ['v "1"', JSON.stringify({ ...good, v: '1' }), DB_TARGET_MESSAGES.version],
    ['userinfo in host', JSON.stringify({ ...good, host: 'evil@db' }), DB_TARGET_MESSAGES.host],
    ['a path in host', JSON.stringify({ ...good, host: 'db/x' }), DB_TARGET_MESSAGES.host],
    ['brackets in host', JSON.stringify({ ...good, host: '[::1]' }), DB_TARGET_MESSAGES.host],
    ['an empty host', JSON.stringify({ ...good, host: '' }), DB_TARGET_MESSAGES.host],
    ['a port string', JSON.stringify({ ...good, port: '5432' }), DB_TARGET_MESSAGES.port],
    ['port 0', JSON.stringify({ ...good, port: 0 }), DB_TARGET_MESSAGES.port],
    ['port 70000', JSON.stringify({ ...good, port: 70000 }), DB_TARGET_MESSAGES.port],
    ['port 1.5', JSON.stringify({ ...good, port: 1.5 }), DB_TARGET_MESSAGES.port],
    ['an empty database', JSON.stringify({ ...good, database: '' }), DB_TARGET_MESSAGES.database],
    ['a 64-byte database', JSON.stringify({ ...good, database: 'd'.repeat(64) }), DB_TARGET_MESSAGES.database],
    ['a control character in database', JSON.stringify({ ...good, database: 'a\nb' }), DB_TARGET_MESSAGES.database],
    ['params as an array', JSON.stringify({ ...good, params: [] }), DB_TARGET_MESSAGES.params],
    ['application_name', JSON.stringify({ ...good, params: { application_name: 'x' } }), DB_TARGET_MESSAGES.params],
    ['sslrootcert', JSON.stringify({ ...good, params: { sslrootcert: '/etc/x.pem' } }), DB_TARGET_MESSAGES.params],
    ['host as a param', JSON.stringify({ ...good, params: { host: 'elsewhere' } }), DB_TARGET_MESSAGES.params],
    ['password as a param', JSON.stringify({ ...good, params: { password: 'x' } }), DB_TARGET_MESSAGES.params],
    ['__proto__ as a param', '{"v":1,"host":"db","port":5432,"database":"crewflow","params":{"__proto__":"x"}}', DB_TARGET_MESSAGES.params],
    ['a non-string param', JSON.stringify({ ...good, params: { sslmode: 1 } }), DB_TARGET_MESSAGES.params],
    ['an empty param', JSON.stringify({ ...good, params: { sslmode: '' } }), DB_TARGET_MESSAGES.params],
    ['a repeated key (last-wins hidden)', '{"v":1,"host":"other","host":"db","port":5432,"database":"crewflow","params":{"sslmode":"verify-full"}}', DB_TARGET_MESSAGES.canonical],
    ['a different key order', '{"host":"db","v":1,"port":5432,"database":"crewflow","params":{"sslmode":"verify-full"}}', DB_TARGET_MESSAGES.canonical],
    ['oversized', `${serializeDbTarget(good)}${' '.repeat(5000)}`, DB_TARGET_MESSAGES.tooLarge],
  ])('refuses %s with fixed text', (_what, text, message) => {
    const got = messageOf(() => parseDbTarget(text));
    expect(got).toBe(message);
    for (const echoed of ['evil', 'elsewhere', '/etc/x.pem', 'other']) expect(got).not.toContain(echoed);
  });

  it('refuses, through the shared URL policy, a value the policy refuses (never echoing it)', () => {
    for (const params of [{ sslmode: 'bogus-mode' }, { options: '-c role=rab_owner' }, { target_session_attrs: 'read-write' }, { connect_timeout: 'ten' }]) {
      const got = messageOf(() => runtimeUrlFromDbTarget(validateDbTarget({ ...good, params }), DERIVED));
      expect(got.startsWith('The database target file names a connection the URL policy refuses:')).toBe(true);
      for (const v of Object.values(params)) expect(got).not.toContain(v);
    }
    // A transaction pooler is refused like the admin-URL path refuses it (the runtime needs session locks).
    expect(() => runtimeUrlFromDbTarget(validateDbTarget({ ...good, host: 'ep-x-pooler.eu-west-2.aws.neon.tech' }), DERIVED)).toThrow(DbTargetError);
  });

  it('refuses an unusable stored password (empty, control characters, oversized); accepts any other', () => {
    for (const bad of ['', 'line\nbreak', 'x'.repeat(1025)]) expect(() => runtimeUrlFromDbTarget(good, bad)).toThrow(DbTargetError);
    expect(parsePgUrl(runtimeUrlFromDbTarget(good, 'p@ss:w/rd'), 't').password).toBe('p@ss:w/rd');
  });

  it('a database name that would not survive the URL round trip is refused, never silently changed', () => {
    expect(() => runtimeUrlFromDbTarget(validateDbTarget({ ...good, database: 'a/b%2F' }), DERIVED)).toThrow(DbTargetError);
  });
});

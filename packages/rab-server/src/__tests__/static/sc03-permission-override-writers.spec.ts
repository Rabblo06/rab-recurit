import * as fs from 'fs';
import * as path from 'path';

import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthContextCacheService } from '../../engine/core-modules/auth/services/auth-context-cache.service';
import { SecurityVersionVector } from '../../engine/core-modules/auth/services/security-version.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';

/**
 * SC-03 (Phase X Stage 0, S0-C-caches.md): `core.user_permission_override` decides effective permissions (an override
 * beats every role) but has no version column, so the auth-context cache key could not see an override change and a
 * revoke stayed cached for up to 900 s. The fix is a CONTENT fingerprint of the user's override rows in
 * `SecurityVersionService.readVector` (no writer can forget to bump it). This static test pins both halves:
 *
 *   1. the fingerprint really feeds the auth-context cache key (behavioural: two vectors that differ ONLY in it give two
 *      keys), readVector really reads it, and the realtime vector comparison uses it;
 *   2. every writer of `core.user_permission_override` anywhere in the repository (specs and test directories excluded;
 *      migrations scanned separately for SECURITY DEFINER functions) is known. Today: none in production code, one e2e seed
 *      script. A new writer is covered automatically by the content fingerprint (any INSERT / UPDATE / DELETE changes it,
 *      proven against PostgreSQL in sc03-override-fingerprint.integration.spec.ts), but it must be reviewed and listed
 *      here: it is a permission write path (layer-2 check, audit, a step-up like role edits).
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SERVER_SRC = path.join(REPO_ROOT, 'packages/rab-server/src');

/** Reviewed writers of core.user_permission_override (repository-relative), with why each is acceptable. */
const KNOWN_OVERRIDE_WRITERS: Readonly<Record<string, string>> = {
  // E2E fixture seed (disposable e2e databases only): revokes payroll.view for one seeded AI-test user.
  'packages/rab-e2e-testing/ai/seed-ai-e2e.ts': 'e2e fixture seed',
};
/** Reviewed SECURITY DEFINER functions (in migrations) that write core.user_permission_override. None today. */
const KNOWN_DEFINER_WRITERS: readonly string[] = [];

// An optional schema qualifier: `core.`, `"core".`, or a templated `${schema}.` / `"${schema}".`.
const QUALIFIER = String.raw`(?:(?:"?[A-Za-z_]\w*"?|"?\$\{[^}]+\}"?)\.)?`;
const TABLE = String.raw`"?user_permission_override"?\b`;
const SQL_WRITE = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM(?:\s+ONLY)?|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?|COPY)\s+${QUALIFIER}${TABLE}`,
  'i',
);
const ORM_WRITE = new RegExp(
  [
    String.raw`\.(?:insert|save|update|delete|remove|upsert|softDelete|softRemove|restore|recover|increment|decrement|clear)\(\s*UserPermissionOverride\b`,
    String.raw`\.into\(\s*UserPermissionOverride\b`, // qb.insert().into(...)
    String.raw`\.delete\(\s*\)\s*\.from\(\s*UserPermissionOverride\b`, // qb.delete().from(...)
    String.raw`getRepository\(\s*UserPermissionOverride\s*\)`,
    String.raw`InjectRepository\(\s*UserPermissionOverride\s*\)`, // then repo.save / insert / delete
    String.raw`Repository<\s*UserPermissionOverride\s*>`,
    String.raw`\bnew\s+UserPermissionOverride\s*\(`,
  ].join('|'),
);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'coverage', '__tests__', 'migrations', 'build', 'android', 'ios']);
function sources(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      sources(full, out);
    } else if (/\.(ts|tsx|js|cjs|mjs|sql)$/.test(entry.name) && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
function migrationFiles(dir = path.join(SERVER_SRC, 'database'), out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) migrationFiles(full, out);
    else if (full.split(path.sep).includes('migrations') && /\.(ts|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
const isWriter = (text: string) => SQL_WRITE.test(text) || ORM_WRITE.test(text);

/** Every `CREATE [OR REPLACE] FUNCTION … $tag$ body $tag$` that is SECURITY DEFINER (before or after the body) and writes the table. */
function definerFunctionsWriting(text: string): string[] {
  const found: string[] = [];
  const fn = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)([\s\S]*?)(\$\w*\$)([\s\S]*?)\3(?=([\s\S]{0,400}))/gi;
  for (let m = fn.exec(text); m; m = fn.exec(text)) {
    const header = m[2]!;
    const trailer = m[5]!.split(/;|CREATE\s/i)[0]!;
    if ((/SECURITY\s+DEFINER/i.test(header) || /SECURITY\s+DEFINER/i.test(trailer)) && SQL_WRITE.test(m[4]!)) found.push(m[1]!);
  }
  return found;
}

describe('SC-03 permission overrides: content fingerprint in the version vector, every writer known', () => {
  const vector = (fingerprint: string): SecurityVersionVector => ({
    sessionVersion: 1, userVersion: 2, rolePermissionVersion: 3, workspaceMembershipVersion: 4, platformAdminVersion: 0, organisationVersion: 5, permissionOverrideFingerprint: fingerprint,
  });
  const env = { get: (k: string) => ({ NODE_ENV: 'test', APP_SECRET: 'a'.repeat(64), AUTH_CONTEXT_CACHE_ENABLED: true } as Record<string, unknown>)[k] };
  const cache = new AuthContextCacheService(env as unknown as EnvironmentService, { client: {} } as unknown as AuthCacheRedisClientProvider);
  const keyFor = (v: SecurityVersionVector) => cache.buildKey({ sid: 'sid-1', organisationId: 'org-1', workspaceId: 'ws-1', versions: v });

  it('the fingerprint feeds the auth-context cache key: vectors differing ONLY in it give different keys', () => {
    expect(keyFor(vector('0-0'))).toBe(keyFor(vector('0-0')));
    const fingerprints = ['0-0', '1-0cc175b9c0f1b6a831c399e269772661', '1-92eb5ffee6ae2fec3ad71c777531578f', '2-0cc175b9c0f1b6a831c399e269772661', 'x'];
    expect(new Set(fingerprints.map((f) => keyFor(vector(f)))).size).toBe(fingerprints.length);
  });

  it('readVector reads the fingerprint in its single statement, and the realtime comparison uses it', () => {
    const src = fs.readFileSync(path.join(SERVER_SRC, 'engine/core-modules/auth/services/security-version.service.ts'), 'utf8');
    expect(src).toMatch(/FROM core\.user_permission_override o WHERE o\.user_id = \$2\) AS permission_override_fingerprint/);
    expect(src).toMatch(/permissionOverrideFingerprint: row\?\.permission_override_fingerprint \?\? 'x'/);
    const realtime = fs.readFileSync(path.join(SERVER_SRC, 'engine/core-modules/realtime/realtime-gateway.controller.ts'), 'utf8');
    expect(realtime).toMatch(/a\.permissionOverrideFingerprint === b\.permissionOverrideFingerprint/);
  });

  it('every writer of core.user_permission_override in the repository is reviewed', () => {
    const writers = [...sources(path.join(REPO_ROOT, 'packages')), ...sources(path.join(REPO_ROOT, 'tools'))]
      .filter((file) => isWriter(fs.readFileSync(file, 'utf8')))
      .map(rel)
      .sort();
    expect(writers).toEqual(Object.keys(KNOWN_OVERRIDE_WRITERS).sort());
  });

  it('every SECURITY DEFINER function in a migration that writes core.user_permission_override is reviewed (none today)', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(200); // the scan really reaches the migration chain
    const definers = files.flatMap((file) => definerFunctionsWriting(fs.readFileSync(file, 'utf8')).map((name) => `${rel(file)}#${name}`));
    expect(definers.sort()).toEqual([...KNOWN_DEFINER_WRITERS].sort());
  });

  describe('the detector itself (one fixture per write form)', () => {
    it.each([
      'INSERT INTO core.user_permission_override (user_id) VALUES ($1)',
      'insert into user_permission_override (user_id) values ($1)',
      'UPDATE core.user_permission_override SET effect = $1',
      'UPDATE ONLY core.user_permission_override SET effect = $1',
      'DELETE FROM user_permission_override WHERE user_id = $1',
      'DELETE FROM ONLY core.user_permission_override WHERE user_id = $1',
      'delete from core."user_permission_override"',
      'DELETE FROM "core"."user_permission_override" WHERE true',
      'INSERT INTO ${schema}.user_permission_override (user_id) VALUES ($1)',
      'UPDATE "${schemaName}".user_permission_override SET effect = $2',
      'MERGE INTO core.user_permission_override AS t USING s ON true',
      'TRUNCATE core.user_permission_override',
      'TRUNCATE TABLE ONLY core.user_permission_override',
      'COPY core.user_permission_override FROM STDIN',
    ])('SQL: %s', (sql) => expect(isWriter(sql)).toBe(true));

    it.each([
      'm.insert(UserPermissionOverride, {})',
      'manager.save(UserPermissionOverride, row)',
      'm.delete(UserPermissionOverride, { userId })',
      'm.upsert(UserPermissionOverride, rows, ["userId", "permissionId"])',
      'ds.getRepository(UserPermissionOverride)',
      'constructor(@InjectRepository(UserPermissionOverride) private readonly repo) {}',
      'private readonly overrides!: Repository<UserPermissionOverride>;',
      'qb.insert().into(UserPermissionOverride).values(rows).execute()',
      'qb.delete().from(UserPermissionOverride).where("user_id = :id", { id }).execute()',
      'qb.update(UserPermissionOverride).set({ effect }).execute()',
      'const row = new UserPermissionOverride();',
    ])('ORM: %s', (code) => expect(isWriter(code)).toBe(true));

    it.each([
      'SELECT 1 FROM core.user_permission_override o',
      "createQueryBuilder(UserPermissionOverride, 'upo')",
      "qb.select('x').from(UserPermissionOverride, 'upo')",
      'policy|user_permission_override|user_permission_override_delete|PERMISSIVE',
      'JOIN core.user_permission_override upo ON true',
    ])('not a write: %s', (text) => expect(isWriter(text)).toBe(false));

    it('finds a SECURITY DEFINER function that writes the table, in either clause order, and ignores readers and INVOKER ones', () => {
      const definerFirst = 'CREATE OR REPLACE FUNCTION core.grant_override(u uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = core AS $fn$ BEGIN INSERT INTO core.user_permission_override (user_id) VALUES (u); END $fn$;';
      const definerLast = 'CREATE FUNCTION core.drop_override(u uuid) RETURNS void AS $$ BEGIN DELETE FROM ONLY core.user_permission_override WHERE user_id = u; END $$ LANGUAGE plpgsql SECURITY DEFINER;';
      const others = `CREATE FUNCTION core.read_override(u uuid) RETURNS int AS $$ SELECT 1 FROM core.user_permission_override $$ LANGUAGE sql SECURITY DEFINER;
        CREATE FUNCTION core.inv(u uuid) RETURNS void AS $$ BEGIN DELETE FROM core.user_permission_override; END $$ LANGUAGE plpgsql;`;
      expect(definerFunctionsWriting(definerFirst)).toEqual(['core.grant_override']);
      expect(definerFunctionsWriting(definerLast)).toEqual(['core.drop_override']);
      expect(definerFunctionsWriting(others)).toEqual([]);
      expect(definerFunctionsWriting(`${others}\n${definerLast}`)).toEqual(['core.drop_override']);
    });
  });
});

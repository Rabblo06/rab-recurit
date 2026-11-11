import * as fs from 'fs';
import * as path from 'path';

/**
 * SC-03 (Phase X Stage 0, S0-C-caches.md): `core.user_permission_override` decides effective permissions (an override
 * beats every role) but has no version column, so the auth-context cache key could not see an override change and a
 * revoke stayed cached for up to 900 s. The fix is a CONTENT fingerprint of the user's override rows in
 * `SecurityVersionService.readVector` (no writer can forget to bump it). This static test pins both halves:
 *
 *   1. readVector really carries the override term, and the cache key and the realtime vector comparison really use it;
 *   2. every production writer of `core.user_permission_override` is known. Today there are none. A new writer is
 *      automatically covered by the content fingerprint (any INSERT / UPDATE / DELETE changes it, proven against
 *      PostgreSQL in sc03-override-fingerprint.integration.spec.ts), but it must be reviewed and listed here: it is a
 *      permission write path (layer-2 permission check, audit, a step-up like role edits).
 *
 * Migrations are excluded (they are reviewed SQL and run before any cache entry for the new schema can exist).
 */
const SERVER_SRC = path.resolve(__dirname, '../..');
const WORKER_SRC = path.resolve(__dirname, '../../../../rab-worker/src');

/** Reviewed production writers of core.user_permission_override (file paths relative to the repository's packages/). */
const KNOWN_OVERRIDE_WRITERS: readonly string[] = [];

const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(\s+TABLE)?)\s+(core\.)?"?user_permission_override"?\b/i;
const ORM_WRITE = /\.(insert|save|update|delete|remove|upsert|softDelete|increment|decrement)\(\s*UserPermissionOverride\b|getRepository\(\s*UserPermissionOverride\s*\)|\bnew\s+UserPermissionOverride\s*\(/;

function productionSources(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['__tests__', 'migrations', 'node_modules', 'dist'].includes(entry.name)) continue;
      productionSources(full, out);
    } else if (/\.(ts|js|cjs|mjs|sql)$/.test(entry.name) && !/\.(spec|test)\.[cm]?[jt]s$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const relative = (file: string) => path.relative(path.resolve(SERVER_SRC, '../..'), file).split(path.sep).join('/');

describe('SC-03 permission overrides: content fingerprint in the version vector, every writer known', () => {
  it('readVector reads the override fingerprint in its single statement', () => {
    const src = fs.readFileSync(path.join(SERVER_SRC, 'engine/core-modules/auth/services/security-version.service.ts'), 'utf8');
    expect(src).toMatch(/FROM core\.user_permission_override o WHERE o\.user_id = \$2\) AS permission_override_fingerprint/);
    expect(src).toMatch(/permissionOverrideFingerprint: row\?\.permission_override_fingerprint \?\? 'x'/);
  });

  it('the auth-context cache key and the realtime vector comparison both include it', () => {
    const cache = fs.readFileSync(path.join(SERVER_SRC, 'engine/core-modules/auth/services/auth-context-cache.service.ts'), 'utf8');
    expect(cache).toMatch(/v\.permissionOverrideFingerprint,\s*\n\s*\]\.join\('\.'\)/);
    const realtime = fs.readFileSync(path.join(SERVER_SRC, 'engine/core-modules/realtime/realtime-gateway.controller.ts'), 'utf8');
    expect(realtime).toMatch(/a\.permissionOverrideFingerprint === b\.permissionOverrideFingerprint/);
  });

  it('every production writer of core.user_permission_override is reviewed (none today)', () => {
    const writers = [...productionSources(SERVER_SRC), ...productionSources(WORKER_SRC)]
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return SQL_WRITE.test(text) || ORM_WRITE.test(text);
      })
      .map(relative)
      .sort();
    expect(writers).toEqual([...KNOWN_OVERRIDE_WRITERS].sort());
  });

  it('the detector itself recognises the write forms it guards against', () => {
    for (const sql of [
      'INSERT INTO core.user_permission_override (user_id) VALUES ($1)',
      'UPDATE core.user_permission_override SET effect = $1',
      'DELETE FROM user_permission_override WHERE user_id = $1',
      'delete from core."user_permission_override"',
    ]) expect(SQL_WRITE.test(sql)).toBe(true);
    for (const orm of ['m.insert(UserPermissionOverride, {})', 'manager.save(UserPermissionOverride, row)', 'ds.getRepository(UserPermissionOverride)', 'm.delete(UserPermissionOverride, { userId })'])
      expect(ORM_WRITE.test(orm)).toBe(true);
    expect(SQL_WRITE.test('SELECT 1 FROM core.user_permission_override o')).toBe(false);
    expect(ORM_WRITE.test("createQueryBuilder(UserPermissionOverride, 'upo')")).toBe(false);
  });
});

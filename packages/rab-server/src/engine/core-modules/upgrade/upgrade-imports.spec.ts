import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Security review L2(a) (OWNER-DB-ULTIMATE Part B): the upgrade logbook's access is a code-path convention the database
 * enforces through `rab.upgrade_scope`. This guard keeps the code paths that may reach the logbook's read / write helpers to
 * the reviewed list, so an ordinary request handler cannot start calling them without a reviewed change here.
 */
const SRC = join(__dirname, '..', '..', '..');
const WORKER_SRC = join(SRC, '..', '..', 'rab-worker', 'src');

/** The logbook modules nothing else may import. */
const PROTECTED = ['upgrade-migration.service', 'upgrade-status.service', 'upgrade-runner', 'workspace-command-runner'];

/** Who may import them (path prefixes relative to rab-server/src). Specs and __tests__ are always allowed. */
const ALLOWED_PREFIXES = [
  'engine/core-modules/upgrade/',
  'engine/core-modules/health/',
  'engine/core-modules/platform-admin/admin-health.service.ts',
  'command/upgrade.command.ts',
  'database/typeorm/scripts/migrate/owner-login/migrate-on-start.ts',
  'database/typeorm/core/upgrade-migration-ledger-sql.spec.ts',
  'modules/manager-workspace/services/manager-workspace.service.ts',
];

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/** Pure: the protected modules a source text imports (by module basename). */
export function protectedImportsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1]!;
    const base = spec.split('/').pop()!.replace(/\.(ts|js)$/, '');
    if (PROTECTED.includes(base)) out.push(base);
  }
  return out;
}

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : files(p);
    return /\.ts$/.test(name) ? [p] : [];
  });
}

const isTest = (rel: string) => rel.includes('__tests__/') || rel.endsWith('.spec.ts');

describe('upgrade logbook import allowlist (security review L2a)', () => {
  it('the scanner fires on a fixture import (static, dynamic and require forms)', () => {
    expect(protectedImportsOf(`import { recordUpgradeMigration } from '../upgrade/upgrade-migration.service';`)).toEqual(['upgrade-migration.service']);
    expect(protectedImportsOf(`const m = await import('../../engine/core-modules/upgrade/upgrade-status.service');`)).toEqual(['upgrade-status.service']);
    expect(protectedImportsOf(`const r = require('./upgrade-runner');`)).toEqual(['upgrade-runner']);
    expect(protectedImportsOf(`import { readAppVersion } from '../upgrade/upgrade-version';`)).toEqual([]);
  });

  it('only the reviewed code paths import the logbook helpers', () => {
    const offenders: string[] = [];
    for (const [root, label] of [
      [SRC, ''],
      [WORKER_SRC, 'rab-worker/'],
    ] as const) {
      for (const file of files(root)) {
        const rel = label + relative(root, file).replace(/\\/g, '/');
        if (isTest(rel)) continue;
        const hits = protectedImportsOf(readFileSync(file, 'utf8'));
        if (hits.length && !ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) offenders.push(`${rel}: ${hits.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist names files that exist (no stale entry silently widening it)', () => {
    for (const p of ALLOWED_PREFIXES) {
      expect(statSync(join(SRC, p)).isFile() || statSync(join(SRC, p)).isDirectory()).toBe(true);
    }
  });
});

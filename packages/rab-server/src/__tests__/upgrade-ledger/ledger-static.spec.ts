/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B2/B3), static: what must NOT exist anywhere in the source tree. No database.
 *
 *   ST-1  no UPDATE / DELETE / TRUNCATE / MERGE of core.upgrade_migration in any production file (rab-server, rab-worker), and
 *         no TypeORM update/delete/remove/upsert on its entity: rows are deleted only by the workspace FK cascade (Part B2).
 *   ST-2  no SECURITY DEFINER writer or status function for the ledger (Part B2: plain queries, like Twenty's repository).
 *   ST-3  `--force` is unreachable from any environment variable: no env key, `process.env` read or compose / env-file /
 *         shell-script line names an upgrade "force"; only the manual command entry parses `--force` (Part B3).
 *   ST-5  a request handler cannot set `rab.upgrade_scope` (interface §1): the setting is named only in the upgrade module, the
 *         migrate path, the ledger migration, the health / status read and the workspace-creation service, always with a
 *         literal scope value (never a variable that could carry API input), and never in the tenant context, a controller,
 *         a resolver or a DTO.
 *   ST-4  the version per release: root package.json is MAJOR.MINOR.PATCH (Part B3), and once the ledger is on the branch,
 *         at least 0.6.0, the first ledger release.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FIRST_LEDGER_VERSION, LEDGER_MIGRATION_ON_BRANCH, VERSION_RE } from './ledger-contract';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SERVER_SRC = join(REPO_ROOT, 'packages', 'rab-server', 'src');
const WORKER_SRC = join(REPO_ROOT, 'packages', 'rab-worker', 'src');
const DOCKER = join(REPO_ROOT, 'packages', 'rab-docker');

function walk(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === 'dist-cjs' || e === 'dist-esm' || e === 'coverage' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

const isProductionTs = (p: string) => /\.ts$/.test(p) && !/\.(spec|test)\.ts$/.test(p) && !/[\\/]__tests__[\\/]/.test(p) && !/\.d\.ts$/.test(p);
const isMigration = (p: string) => /[\\/]database[\\/]typeorm[\\/]core[\\/]migrations[\\/]/.test(p);
const rel = (p: string) => relative(REPO_ROOT, p).replace(/\\/g, '/');
/** Comments removed, so a sentence ABOUT the rule never trips it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const productionFiles = [...walk(SERVER_SRC, isProductionTs), ...walk(WORKER_SRC, isProductionTs)];

describe('the upgrade logbook: static guarantees (Part B2/B3)', () => {
  it('ST-1 no production code updates, deletes, truncates or merges core.upgrade_migration (only the FK cascade deletes)', () => {
    const sqlWrite = /\b(UPDATE\s+(ONLY\s+)?("?core"?\s*\.\s*)?"?upgrade_migration"?\b|DELETE\s+FROM\s+(ONLY\s+)?("?core"?\s*\.\s*)?"?upgrade_migration"?\b|TRUNCATE\s+(TABLE\s+)?[^;]*\bupgrade_migration\b|MERGE\s+INTO\s+("?core"?\s*\.\s*)?"?upgrade_migration"?\b)/i;
    const offenders: string[] = [];
    for (const f of productionFiles) {
      if (isMigration(f)) continue;
      const text = code(readFileSync(f, 'utf8'));
      if (sqlWrite.test(text)) offenders.push(`${rel(f)}: SQL write`);
      // The entity (whatever B1 names it: *UpgradeMigration*) written through TypeORM's mutating APIs.
      const entities = [...text.matchAll(/class\s+(\w*UpgradeMigration\w*)\b/g)].map((m) => m[1]!);
      const mentioned = entities.length ? entities : /\bUpgradeMigration\w*\b/.test(text) ? ['UpgradeMigration'] : [];
      for (const ent of mentioned) {
        const ormWrite = new RegExp(`\\.(update|delete|remove|softDelete|softRemove|upsert|restore)\\(\\s*${ent}\\w*\\b|getRepository\\(\\s*${ent}\\w*\\s*\\)\\s*\\.(update|delete|remove|softDelete|softRemove|upsert|restore)\\(|\\.update\\(\\s*${ent}\\w*\\s*\\)|\\.delete\\(\\)\\s*\\.from\\(\\s*${ent}`);
        if (ormWrite.test(text)) offenders.push(`${rel(f)}: TypeORM write on ${ent}`);
      }
      // A repository injected for the entity whose update/delete is then called.
      if (/@InjectRepository\(\s*\w*UpgradeMigration\w*\s*\)/.test(text) && /\b\w*[Rr]epo\w*\s*\.\s*(update|delete|remove|softDelete|softRemove|upsert|restore)\(/.test(text)) {
        offenders.push(`${rel(f)}: repository update/delete next to an injected UpgradeMigration repository`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ST-2 no SECURITY DEFINER function writes or reads the ledger (plain queries like Twenty\'s repository)', () => {
    const offenders: string[] = [];
    const files = walk(SERVER_SRC, (p) => /\.(ts|sql)$/.test(p) && !/\.(spec|test)\.ts$/.test(p) && !/[\\/]__tests__[\\/]/.test(p));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!/\bupgrade_migration\b/.test(text)) continue;
      // Each CREATE FUNCTION body that mentions the table: a SECURITY DEFINER one is the forbidden shape.
      for (const m of text.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION[\s\S]*?(\$[A-Za-z_]*\$)[\s\S]*?\2[\s\S]*?;/gi)) {
        if (/\bupgrade_migration\b/.test(m[0]) && /SECURITY\s+DEFINER/i.test(m[0])) offenders.push(rel(f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ST-3 --force is unreachable from the environment (no variable, no env read, no compose / env-file / shell line)', () => {
    const forceName = /\b[A-Z0-9_]*(UPGRADE[A-Z0-9_]*FORCE|FORCE[A-Z0-9_]*UPGRADE)[A-Z0-9_]*\b/;
    const offenders: string[] = [];
    for (const f of productionFiles) {
      const text = code(readFileSync(f, 'utf8'));
      if (forceName.test(text)) offenders.push(`${rel(f)}: ${forceName.exec(text)![0]}`);
      // An environment read that could carry "force" into the upgrade decision.
      if (/process\.env(\.\w*FORCE\w*|\[\s*['"`]\w*FORCE\w*['"`]\s*\])/i.test(text) && /upgrade/i.test(rel(f))) offenders.push(`${rel(f)}: reads a *FORCE* environment variable`);
    }
    const deployFiles = walk(DOCKER, (p) => /(\.ya?ml|\.env(\.example)?|\.sh|Dockerfile[^\\/]*)$/.test(p) && !/[\\/](deploy-order-tests|upgrade-ledger-tests)[\\/]/.test(p));
    for (const f of deployFiles) {
      const text = readFileSync(f, 'utf8');
      const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));
      for (const l of lines) {
        if (forceName.test(l)) offenders.push(`${rel(f)}: ${l.trim().slice(0, 120)}`);
        // The start path must never pass --force to the upgrade: only the documented manual `docker compose run` does.
        if (/\bupgrade\b[^#\n]*--force\b/.test(l)) offenders.push(`${rel(f)}: ${l.trim().slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ST-3 the env schema has no variable that names an upgrade force', () => {
    const schema = readFileSync(join(SERVER_SRC, 'engine', 'core-modules', 'environment', 'environment-variables.ts'), 'utf8');
    const keys = [...code(schema).matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*[!?]?\s*:/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((k) => /FORCE/.test(k) && /UPGRADE|MIGRAT/.test(k))).toEqual([]);
  });

  it('ST-5 rab.upgrade_scope is set only by the allow-listed upgrade code paths, with literal values only', () => {
    const ALLOWED = [
      /^packages\/rab-server\/src\/engine\/core-modules\/upgrade\//,
      /^packages\/rab-server\/src\/database\/typeorm\/scripts\/migrate\//,
      /^packages\/rab-server\/src\/database\/typeorm\/core\/migrations\/1786721470000-UpgradeMigrationLedger\.ts$/,
      /^packages\/rab-server\/src\/database\/typeorm\/core\/upgrade-migration[\w-]*\.ts$/,
      /^packages\/rab-server\/src\/engine\/core-modules\/health\//,
      /^packages\/rab-server\/src\/modules\/manager-workspace\/services\/manager-workspace\.service\.ts$/,
      /^packages\/rab-server\/src\/command\//,
    ];
    const FORBIDDEN_KIND = /(\.controller|\.resolver|\.dto|[\/]dto[\/]|tenant-context)/;
    const offenders: string[] = [];
    for (const f of productionFiles) {
      const text = code(readFileSync(f, 'utf8'));
      if (!/upgrade_scope/.test(text)) continue;
      const r = rel(f);
      // Security review L2 (B1, 04bd8b0b): the tenant binding CLEARS the scope (`set_config('rab.upgrade_scope', '', true)`),
      // so a request transaction can never inherit one. Outside the allow-list that clearing form is the ONLY admitted mention.
      const outside = !ALLOWED.some((a) => a.test(r)) || FORBIDDEN_KIND.test(r);
      if (outside && /upgrade_scope/.test(text.replace(/set_config\(\s*'rab\.upgrade_scope'\s*,\s*''\s*,\s*true\s*\)/g, ''))) {
        offenders.push(`${r}: names upgrade_scope outside the allow-list (other than clearing it)`);
      }
      // Every set_config of the scope outside the module's single helper must carry a literal value.
      for (const m of text.matchAll(/set_config\(\s*'rab\.upgrade_scope'\s*,\s*([^,)]+)/g)) {
        if (!/^'(upgrade|status|workspace_init|)'$/.test(m[1]!.trim()) && !/^\$\d+$/.test(m[1]!.trim())) offenders.push(`${r}: set_config('rab.upgrade_scope', ${m[1]!.trim()})`);
      }
    }
    // Callers of B1's helper (withUpgradeScope(query, scope, fn)) pass a literal scope: never a value that could come from a request.
    for (const f of productionFiles) {
      const text = code(readFileSync(f, 'utf8'));
      for (const m of text.matchAll(/withUpgradeScope\(\s*[^,]+,\s*([^,]+),/g)) {
        const arg = m[1]!.trim();
        if (/:/.test(arg)) continue; // the helper's own typed signature
        if (/^(scope|s)$/.test(arg) && /engine[\\/]core-modules[\\/]upgrade[\\/]upgrade-migration\.service\.ts$/.test(f)) continue;
        if (!/^'(upgrade|status|workspace_init)'$/.test(arg)) offenders.push(`${rel(f)}: withUpgradeScope(..., ${arg}, ...)`);
      }
      if (/withUpgradeScope\(/.test(text) && FORBIDDEN_KIND.test(rel(f))) offenders.push(`${rel(f)}: a request-facing file enters an upgrade scope`);
    }
    expect(offenders).toEqual([]);
  });

  it('ST-4 the release version is MAJOR.MINOR.PATCH (and at least the first ledger release once the ledger is on the branch)', () => {
    const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version as string;
    expect(version).toMatch(VERSION_RE);
    if (LEDGER_MIGRATION_ON_BRANCH) {
      const n = (v: string) => v.split('.').map(Number) as [number, number, number];
      const [a, b] = [n(version), n(FIRST_LEDGER_VERSION)];
      expect(a[0] * 1e6 + a[1] * 1e3 + a[2]).toBeGreaterThanOrEqual(b[0] * 1e6 + b[1] * 1e3 + b[2]);
    }
  });
});

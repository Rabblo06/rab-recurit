import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Foundation fix P3 (2026-10-22) — static regression guard for the `core.navigation_layout` ownership defect.
 *
 * Phase-B migrations run as the bootstrap SUPERUSER, and PostgreSQL makes the connecting role the owner of whatever it
 * creates. `NavigationLayout1786718600000` created a table without `OWNER TO`, so every fresh install had a
 * superuser-owned table until someone ran `ALTER TABLE ... OWNER TO crewflow` by hand.
 * `ReconcileSuperuserOwnedCoreObjects1786719600000` repairs everything created up to it; from then on, every migration
 * that creates a `core` table, view, sequence, function or type must also state that object's owner in the same file.
 * (The integration suite `core-object-ownership` checks the resulting database itself.)
 */
const MIGRATIONS_DIR = join(__dirname, 'migrations');
const RECONCILED_THROUGH = 1786719600000;

const CREATE = /CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|FUNCTION|PROCEDURE|TYPE|DOMAIN)\s+(?:IF\s+NOT\s+EXISTS\s+)?core\.("?[a-z_][a-z0-9_]*"?)/gi;

function ownedObjects(source: string): Set<string> {
  const owned = new Set<string>();
  const re = /ALTER\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|FUNCTION|PROCEDURE|TYPE|DOMAIN)\s+core\.("?[a-z_][a-z0-9_]*"?)[^;`]*?OWNER\s+TO\s+(crewflow|rab_secure_owner)\b/gi;
  for (const m of source.matchAll(re)) owned.add(m[1]!.replace(/"/g, '').toLowerCase());
  return owned;
}

describe('core migrations state the owner of every object they create (P3 regression)', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{13}-.+\.ts$/.test(f));

  it('finds the migrations directory and the reconcile migration', () => {
    expect(files.some((f) => f.startsWith(`${RECONCILED_THROUGH}-`))).toBe(true);
  });

  it('flags the historical defect: NavigationLayout1786718600000 creates a table without OWNER TO (repaired by the reconcile migration)', () => {
    const source = readFileSync(join(MIGRATIONS_DIR, files.find((f) => f.startsWith('1786718600000-'))!), 'utf8');
    expect([...source.matchAll(CREATE)].map((m) => m[2])).toContain('navigation_layout');
    expect(ownedObjects(source).has('navigation_layout')).toBe(false);
  });

  it('every migration after the reconcile migration sets an owner for each core object it creates', () => {
    const problems: string[] = [];
    for (const file of files) {
      if (Number(file.slice(0, 13)) <= RECONCILED_THROUGH) continue;
      const source = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const owned = ownedObjects(source);
      for (const m of source.matchAll(CREATE)) {
        const name = m[2]!.replace(/"/g, '').toLowerCase();
        if (!owned.has(name)) problems.push(`${file}: CREATE ${m[1]!.toUpperCase()} core.${name} has no ALTER ... OWNER TO crewflow|rab_secure_owner`);
      }
    }
    expect(problems).toEqual([]);
  });
});

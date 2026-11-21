import * as fs from 'node:fs';
import * as path from 'node:path';

import { PREAUTH_DEFINER_POLICY_SQL } from '../../database/boot-checks/owner-login-posture';
import { SEMANTIC_OBJECT_SQL } from '../../database/posture-drift/semantic-posture';

/**
 * Restore drill (M9, RESTORE-DRILL.md, MEDIUM): `string_agg(x, ',' ORDER BY 1)` does NOT order by the first column. Inside an
 * aggregate an integer literal is a constant, so every row has the same sort key and the output follows input order — for a
 * policy's roles that is pg_policy.polroles order, which a pg_dump / restore onto a new cluster changes. The semantic-posture
 * boot gate then refused a restored database that had not changed. (In a plain `SELECT … ORDER BY 1`, including a
 * subquery `array(SELECT … ORDER BY 1)`, 1 IS the first output column; that form is fine and is not flagged.)
 *
 * This guard fails on any aggregate call `name(... ORDER BY <integer>)` in production SQL of rab-server.
 */
const SRC = path.resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'migrations']); // migrations are frozen (never edited after merge)
const isTestFile = (name: string) => /\.(spec|test)\.ts$/.test(name);
const isScanned = (name: string) => (name.endsWith('.ts') || name.endsWith('.sql')) && !isTestFile(name);

/**
 * Known, reviewed exceptions (relative to packages/rab-server/src). Each is either frozen or not a posture renderer.
 *  - workspace-schema-fingerprint.ts: FROZEN with migration WorkspaceSchemaMigrationLedger1786719800000 (a change is a new
 *    migration re-creating core.workspace_schema_fingerprint_lines). Same pattern on the policy roles, but every workspace
 *    policy is `TO PUBLIC` (one role, security-posture.workspace.pg*.golden.txt: `{public}`), so a one-element list cannot
 *    reorder and no released structure-level fingerprint depends on it. A multi-role workspace policy must fix it first.
 *  - workspace-step-checks-sql.ts: SESSION_CLEAN_SQL lists this session's advisory locks; compared with a baseline read on
 *    the same backend, not with a stored value. Reported to its owner lane, not changed here.
 */
const ALLOWED = new Map<string, number>([
  ['database/typeorm/workspace-schema/workspace-schema-fingerprint.ts', 1],
  ['engine/core-modules/upgrade/workspace-step-checks-sql.ts', 1],
]);

function* walk(dir: string): Generator<string> {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* walk(full);
    else if (isScanned(name)) yield full;
  }
}

/**
 * Comments blanked to spaces (same length, so positions stay valid): `--` SQL and `//` TS line comments (not the `//` of a
 * `scheme://`), and block comments. An apostrophe in a comment ("don't") would otherwise flip the quote tracking below.
 */
function blankComments(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank).replace(/(^|[^:])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
}

/**
 * Positions of an aggregate ORDER BY whose (first) key is an integer constant: `ORDER BY 1)`, `ORDER BY 1 DESC)`,
 * `ORDER BY 2 NULLS FIRST)`, `ORDER BY 1, x)` ..., inside a function call that is not a subquery.
 */
function aggregateOrderByConstant(source: string): number[] {
  const text = blankComments(source);
  const hits: number[] = [];
  const re = /ORDER\s+BY\s+\d+(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?\s*[),]/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Walk back to the '(' that encloses this ORDER BY (skipping single-quoted literals).
    let depth = 0;
    let inQuote = false;
    let open = -1;
    for (let i = m.index; i >= 0; i -= 1) {
      const ch = text[i];
      if (ch === "'") inQuote = !inQuote;
      if (inQuote) continue;
      // A statement or template-literal boundary: this ORDER BY is not inside a call (a top-level `ORDER BY 1, 2` is positional).
      if (ch === '`' || ch === ';') break;
      if (ch === ')') depth += 1;
      else if (ch === '(') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    if (open < 0) continue;
    const isCall = /[A-Za-z_][A-Za-z0-9_]*\s*$/.test(text.slice(Math.max(0, open - 64), open));
    const isSubquery = /^\s*(SELECT|WITH|VALUES)\b/i.test(text.slice(open + 1, open + 32));
    if (isCall && !isSubquery) hits.push(m.index);
  }
  return hits;
}

describe('no aggregate ORDER BY <constant> in production SQL (restore drill MEDIUM)', () => {
  it('the detector: flags an aggregate, not a positional ORDER BY in a (sub)query', () => {
    expect(aggregateOrderByConstant(`string_agg(CASE WHEN x = 0 THEN 'public' ELSE n END, ',' ORDER BY 1)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`(SELECT pg_catalog.array_agg(pg_catalog.pg_get_userbyid(x) ORDER BY 1) FROM t)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`array(SELECT pg_get_userbyid(r) FROM unnest(polroles) r ORDER BY 1)`)).toEqual([]);
    expect(aggregateOrderByConstant(`SELECT a FROM t ORDER BY 1`)).toEqual([]);
    expect(aggregateOrderByConstant(`string_agg(pr.n, ',' ORDER BY pr.n COLLATE "C")`)).toEqual([]);
    // Security review L (PR #321): direction, NULLS and a constant first key of a list are flagged too.
    expect(aggregateOrderByConstant(`string_agg(n, ',' ORDER BY 1 DESC)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`array_agg(n ORDER BY 1 ASC NULLS FIRST)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`array_agg(n ORDER BY 2 NULLS LAST)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`string_agg(n, ',' ORDER BY 1, n)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`array(SELECT n FROM t ORDER BY 1 DESC, n)`)).toEqual([]);
    expect(aggregateOrderByConstant(`string_agg(n, ',' ORDER BY n, 1)`)).toEqual([]); // the first key decides; not a constant here
    expect(aggregateOrderByConstant('q.query(`SELECT a, b FROM t ORDER BY 1, 2`, [x]);')).toEqual([]); // top-level: positional
    expect(aggregateOrderByConstant(`f(x); SELECT a FROM t ORDER BY 1, 2;`)).toEqual([]);
    // Apostrophes in comments no longer flip the quote tracking (SQL, TS line and block comments).
    expect(aggregateOrderByConstant(`string_agg(n, ',' -- don't
 ORDER BY 1)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`string_agg(n, ',' /* it's */ ORDER BY 1)`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`// isn't
const q = \`string_agg(n, ',' ORDER BY 1)\`;`)).toHaveLength(1);
    expect(aggregateOrderByConstant(`-- ORDER BY 1)
SELECT 1`)).toEqual([]); // a commented-out form is not code
  });

  it('the source scan covers .sql files as well as .ts (minus spec / test files)', () => {
    expect(isScanned('workspace-schema-v1.sql')).toBe(true);
    expect(isScanned('semantic-posture.ts')).toBe(true);
    expect(isScanned('semantic-posture.spec.ts')).toBe(false);
  });

  it('the posture renderers sort policy roles by name', () => {
    expect(aggregateOrderByConstant(SEMANTIC_OBJECT_SQL)).toEqual([]);
    expect(aggregateOrderByConstant(PREAUTH_DEFINER_POLICY_SQL)).toEqual([]);
    expect(SEMANTIC_OBJECT_SQL).toContain(`string_agg(pr.n, ',' ORDER BY pr.n COLLATE "C")`);
    expect(PREAUTH_DEFINER_POLICY_SQL).toContain(`array_agg(pr.n ORDER BY pr.n COLLATE "C")`);
  });

  it('source scan: no other production file aggregates with ORDER BY <constant> (frozen / reviewed exceptions listed)', () => {
    const found = new Map<string, number>();
    let scanned = 0;
    for (const file of walk(SRC)) {
      scanned += 1;
      const n = aggregateOrderByConstant(fs.readFileSync(file, 'utf8')).length;
      if (n) found.set(path.relative(SRC, file).replace(/\\/g, '/'), n);
    }
    expect(scanned).toBeGreaterThan(300);
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(ALLOWED));
  });
});

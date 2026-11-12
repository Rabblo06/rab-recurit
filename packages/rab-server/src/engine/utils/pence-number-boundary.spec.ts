import * as fs from 'fs';
import * as path from 'path';

import { assertSafePence } from '@rab/shared';
import * as ts from 'typescript';

/**
 * Static guard: a money value read from the database as a bigint becomes a JS number only through `assertSafePence`
 * (`@rab/shared` money.ts). Entity columns get that from the `bigintAsNumber` transformer; raw `manager.query` rows do
 * not, because pg returns bigint and numeric as strings and `Number(string)` silently rounds anything past 2^53 - 1 to a
 * different, plausible-looking amount.
 *
 * This spec parses the server and Worker source (TypeScript AST, so comments and strings never match) and finds every
 * `Number(<expression>)` whose expression names pence or a gross total. Each one must be the first argument of an
 * `assertSafePence(...)` call. BASELINE lists the hits that are allowed to remain, with the reason; a file may only have
 * fewer hits than its baseline, never more, and a new file is never allowed one.
 */
const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src'];
const MONEY = /pence|gross/i;

const BASELINE: Record<string, { hits: number; why: string }> = {
  // Guarded on the next line by `Number.isSafeInteger(gross)` (throws RangeError), not by assertSafePence.
  'packages/rab-server/src/modules/payroll/services/payroll-assistant.service.ts': { hits: 1, why: 'Number.isSafeInteger check follows' },
  // The approved shift statement (PDF). Guarded by assertSafePence on the PDF integration branches (#57 → #62/#63),
  // which rewrite this loader; not duplicated here to avoid a conflicting edit. Lowered to 0 when those merge.
  'packages/rab-worker/src/queues/rab-reports/shift-statement.job.ts': { hits: 2, why: 'guarded on worker/pdf-native-payroll (#57)' },
};

function isTestFile(rel: string): boolean {
  return /(^|\/)__tests__\//.test(rel) || /\.(spec|test)\.ts$/.test(rel) || /\/jest-[^/]*\.ts$/.test(rel);
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
}

/** `Number(x)` calls on a money expression that are NOT the first argument of `assertSafePence(...)`. */
function unguardedMoneyNumberCalls(source: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Number' && node.arguments.length === 1) {
      const arg = node.arguments[0]!.getText(source);
      if (MONEY.test(arg)) {
        const parent = node.parent;
        const guarded =
          ts.isCallExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === 'assertSafePence' &&
          parent.arguments[0] === node;
        if (!guarded) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          hits.push(`${line + 1}: Number(${arg})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function scan(): Map<string, string[]> {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(REPO, root), files);
  const found = new Map<string, string[]>();
  for (const file of files) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (isTestFile(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('Number(')) continue;
    const hits = unguardedMoneyNumberCalls(ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true));
    if (hits.length) found.set(rel, hits);
  }
  return found;
}

describe('bigint pence enter a JS number only through assertSafePence', () => {
  it('no raw Number(...) on a pence or gross value outside the baseline', () => {
    const violations: string[] = [];
    for (const [file, hits] of scan()) {
      const allowed = BASELINE[file]?.hits ?? 0;
      if (hits.length > allowed) violations.push(`${file} (${hits.length} > ${allowed}):\n    ${hits.join('\n    ')}`);
    }
    expect(violations).toEqual([]);
  });

  it('the scanner sees what it must (positive control)', () => {
    const probe = ts.createSourceFile(
      'probe.ts',
      `const a = Number(r.amount_pence);
       const b = assertSafePence(Number(r.amount_pence), 'x');
       const c = Number(t?.gross ?? 0);
       const d = Number(r.worked_minutes);
       const e = assertSafePence(1, Number(r.net_pence) as never);`,
      ts.ScriptTarget.ES2022,
      true,
    );
    expect(unguardedMoneyNumberCalls(probe)).toEqual(['1: Number(r.amount_pence)', '3: Number(t?.gross ?? 0)', '5: Number(r.net_pence)']);
  });

  it('the guard it requires refuses exactly what Number() would round', () => {
    expect(assertSafePence(Number('9007199254740991'))).toBe(Number.MAX_SAFE_INTEGER);
    for (const stored of ['9007199254740992', '9007199254740993', '-9007199254740993', '12.5', 'abc']) {
      expect(() => assertSafePence(Number(stored), 'stored')).toThrow(RangeError);
    }
  });
});

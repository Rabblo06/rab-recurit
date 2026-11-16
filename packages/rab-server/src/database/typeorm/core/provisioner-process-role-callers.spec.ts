/**
 * X5.1: the separate provisioner process (rab-worker workspace-provisioner.main.ts) was removed; the Worker provisions
 * in-process on the owner login. The 'provisioner' process role still exists in the runtime guards (the
 * `allowedIn: ['provisioner']` exemption in never-in-runtime-env.ts, the elevated endpoint in database-boot-gates.ts, the
 * login check skipped in runtime-database-guard.ts). That exemption is removed with the legacy names (X3.5-S8). Until then
 * this structural scan (no database) proves it has NO live caller: no production source file passes 'provisioner' to
 * runDatabaseBootGates / assertRuntimeDatabaseIdentity / resolveRuntimeDatabase / runtimeEnvRefusal. A new caller that
 * re-opens the exemption fails here and must be reviewed instead.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const SOURCE_ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src'];

/** Guard entry points and which argument names the process role. */
const GUARDED_CALLS: Record<string, { argIndex: number; property?: string }> = {
  runDatabaseBootGates: { argIndex: 0 },
  assertRuntimeDatabaseIdentity: { argIndex: 0 },
  resolveRuntimeDatabase: { argIndex: 0, property: 'processName' },
  runtimeEnvRefusal: { argIndex: 1 },
};

/** Files that define the guards and pass their own `processName` parameter through (never a literal). */
const PASS_THROUGH_FILES = new Set([
  'packages/rab-server/src/database/typeorm/core/runtime-database-guard.ts',
  'packages/rab-server/src/database/boot-checks/database-boot-gates.ts',
]);

export interface GuardCall {
  file: string;
  line: number;
  callee: string;
  /** The literal process role, or null when the argument is not a string literal. */
  role: string | null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function roleOf(arg: ts.Expression | undefined, property: string | undefined): string | null {
  if (!arg) return null;
  if (property === undefined) return ts.isStringLiteralLike(arg) ? arg.text : null;
  if (!ts.isObjectLiteralExpression(arg)) return null;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === property) {
      return ts.isStringLiteralLike(p.initializer) ? p.initializer.text : null;
    }
  }
  return null;
}

/** Every guard call in one source text. Pure. */
export function guardCallsIn(file: string, source: string): GuardCall[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: GuardCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      // Own keys only: a plain-object lookup would also match Object.prototype members (`x.toString(...)`).
      const spec = name && Object.prototype.hasOwnProperty.call(GUARDED_CALLS, name) ? GUARDED_CALLS[name] : undefined;
      if (name && spec) {
        out.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          callee: name,
          role: roleOf(node.arguments[spec.argIndex], spec.property),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Problems for a set of calls: a 'provisioner' literal anywhere, or a non-literal role outside the pass-through files. */
export function provisionerRoleProblems(calls: GuardCall[]): string[] {
  const problems: string[] = [];
  for (const c of calls) {
    if (c.role === 'provisioner') problems.push(`${c.file}:${c.line}: ${c.callee}('provisioner') re-opens the provisioner exemption`);
    else if (c.role === null && !PASS_THROUGH_FILES.has(c.file)) problems.push(`${c.file}:${c.line}: ${c.callee} with a non-literal process role (cannot prove it is not 'provisioner')`);
  }
  return problems;
}

function productionSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'migrations') continue;
        walk(rel);
      } else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  return out;
}

describe("X5.1: the 'provisioner' process role has no live caller", () => {
  const calls = productionSourceFiles().flatMap((file) => guardCallsIn(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));

  it('the scan is not vacuous: it sees the API, Worker and CLI boot calls', () => {
    const seen = (file: string, callee: string, role: string) => calls.some((c) => c.file === file && c.callee === callee && c.role === role);
    expect(seen('packages/rab-server/src/main.ts', 'runDatabaseBootGates', 'api')).toBe(true);
    expect(seen('packages/rab-server/src/main.ts', 'assertRuntimeDatabaseIdentity', 'api')).toBe(true);
    expect(seen('packages/rab-worker/src/main.ts', 'runDatabaseBootGates', 'worker')).toBe(true);
    expect(seen('packages/rab-worker/src/main.ts', 'assertRuntimeDatabaseIdentity', 'worker')).toBe(true);
    expect(seen('packages/rab-server/src/command/main.ts', 'runDatabaseBootGates', 'cli')).toBe(true);
  });

  it("no production source passes 'provisioner' (or an unprovable role) to a runtime guard", () => {
    expect(provisionerRoleProblems(calls)).toEqual([]);
  });

  it('the scanner itself: positive and negative fixtures', () => {
    const f = 'packages/rab-worker/src/fixture.ts';
    expect(provisionerRoleProblems(guardCallsIn(f, "await runDatabaseBootGates('worker'); assertRuntimeDatabaseIdentity('api');"))).toEqual([]);
    expect(provisionerRoleProblems(guardCallsIn(f, "resolveRuntimeDatabase({ processName: 'api', env });"))).toEqual([]);
    // Unrelated calls whose names are Object.prototype members are not guard calls.
    expect(guardCallsIn(f, 'value.toString(16); a.hasOwnProperty(k); o.valueOf();')).toEqual([]);
    for (const bad of [
      "await runDatabaseBootGates('provisioner');",
      "await guards.assertRuntimeDatabaseIdentity('provisioner');",
      "resolveRuntimeDatabase({ processName: 'provisioner', env, dotenvValues });",
      "runtimeEnvRefusal(process.env, 'provisioner');",
      'runDatabaseBootGates(role);',
      'resolveRuntimeDatabase({ processName, env });',
    ]) {
      expect({ bad, flagged: provisionerRoleProblems(guardCallsIn(f, bad)).length }).toEqual({ bad, flagged: 1 });
    }
    // A defining file may pass its own parameter through.
    expect(provisionerRoleProblems(guardCallsIn('packages/rab-server/src/database/typeorm/core/runtime-database-guard.ts', 'runtimeEnvRefusal(env, processName);'))).toEqual([]);
  });
});

import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

import { REPLICA_READ_REGISTER } from './replica-read-register';

/**
 * B4: the replica register is the ONLY place a read may opt into the replica. This parses every production source file
 * (TypeScript AST) and finds each object literal property `useReplica` that is not the literal `false`, together with
 * its enclosing method. The set must equal the register exactly; nothing in rab-worker may use it at all.
 */
const REPO = path.resolve(__dirname, '../../../../../..');
const ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src'];
const DEFINITION_FILES = new Set([
  'packages/rab-server/src/engine/core-modules/tenant/tenant-context.service.ts',
  'packages/rab-server/src/database/runtime/replica/replica-read-register.ts',
]);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const isTestFile = (rel: string) => /\/__tests__\//.test(rel) || /\.(spec|test)\.ts$/.test(rel);

export function findReplicaOptIns(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const enclosing = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
    }
    return '(top level)';
  };
  const visit = (node: ts.Node): void => {
    const isOptIn =
      (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'useReplica' && node.initializer.kind !== ts.SyntaxKind.FalseKeyword) ||
      (ts.isShorthandPropertyAssignment(node) && node.name.text === 'useReplica');
    if (isOptIn) found.push(enclosing(node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('read-replica opt-in register (B4)', () => {
  it('the scanner sees property opt-ins and their method, and ignores false and comments', () => {
    const text = [
      'class A {',
      '  list() { return t.run(ctx, fn, { useReplica: true }); }',
      '  get() { return t.run(ctx, fn, { useReplica: false }); }',
      '  // useReplica: true in a comment',
      '  other() { const useReplica = flag; return t.run(ctx, fn, { useReplica }); }',
      '}',
    ].join('\n');
    expect(findReplicaOptIns('a.ts', text)).toEqual(['list', 'other']);
  });

  it('every useReplica call site is in the register, and every register entry exists (nothing in rab-worker)', () => {
    const actual: string[] = [];
    for (const root of ROOTS) {
      for (const file of listFiles(path.join(REPO, root))) {
        const rel = path.relative(REPO, file).split(path.sep).join('/');
        if (isTestFile(rel) || DEFINITION_FILES.has(rel)) continue;
        for (const method of findReplicaOptIns(rel, fs.readFileSync(file, 'utf8'))) actual.push(`${rel}#${method}`);
      }
    }
    const expected = REPLICA_READ_REGISTER.map((e) => `${e.file}#${e.method}`);
    expect(actual.filter((x) => x.startsWith('packages/rab-worker/'))).toEqual([]);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('never registers a path the owner kept on the primary', () => {
    const forbidden = [/payroll/i, /audit/i, /platform-admin/i, /\/auth\//, /mfa/i, /permission/i, /session/i, /timeline/i, /notification/i, /navigation/i, /modules\/manager\//];
    for (const entry of REPLICA_READ_REGISTER) {
      for (const pattern of forbidden) expect(`${entry.file}#${entry.method}`).not.toMatch(pattern);
    }
    const keptOnPrimary = ['staff.service.ts#list', 'staff.service.ts#get', 'offer.service.ts#listMine', 'offer.service.ts#getBatch', 'attendance.service.ts#getActive', 'attendance.service.ts#list'];
    const registered = REPLICA_READ_REGISTER.map((e) => `${path.basename(e.file)}#${e.method}`);
    for (const key of keptOnPrimary) expect(registered).not.toContain(key);
  });
});

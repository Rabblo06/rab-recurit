import * as fs from 'fs';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as ts from 'typescript';

import { applyGlobalValidationPipe, GLOBAL_VALIDATION_PIPE_OPTIONS } from '../../engine/utils/global-validation-pipe';

/**
 * XA-11 (Phase X2, X6.3c): a Nest application built in a test must validate requests exactly as production does.
 * main.ts applies the global ValidationPipe (whitelist + forbidNonWhitelisted + transform, the anti-mass-assignment
 * control); a test that builds the app with `createNestApplication()` and skips it runs the API WITHOUT that control, so
 * a test can pass on a body production would refuse with 400. Before this change 13 specs did that, and one spec built a
 * second app without it.
 *
 * The rule is per CALL SITE, checked on the TypeScript AST of every .ts file under rab-server/src (specs AND test helpers
 * such as the AI test kit): every `<x>.createNestApplication(...)` must be the direct first argument of
 * `applyGlobalValidationPipe(...)`. There is no other accepted form (no inline copy of the options, no helper exemption),
 * and main.ts must use the same helper, so production and every test share one definition.
 */
const SRC = path.resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist']);
const SELF = path.resolve(__filename);

function* tsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && path.resolve(full) !== SELF) yield full;
  }
}

/** Every `<x>.createNestApplication(...)` call in a file, with whether it is wrapped as `applyGlobalValidationPipe(<call>)`. */
function createNestApplicationCalls(file: string, source: string): Array<{ line: number; wrapped: boolean }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: Array<{ line: number; wrapped: boolean }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'createNestApplication'
    ) {
      const parent = node.parent;
      const wrapped =
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'applyGlobalValidationPipe' &&
        parent.arguments[0] === node;
      calls.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, wrapped });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

describe('the global ValidationPipe in every spec that builds a Nest application (XA-11)', () => {
  it('the shared options are exactly whitelist + forbidNonWhitelisted + transform', () => {
    expect({ ...GLOBAL_VALIDATION_PIPE_OPTIONS }).toEqual({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    expect(Object.isFrozen(GLOBAL_VALIDATION_PIPE_OPTIONS)).toBe(true);
  });

  it('applyGlobalValidationPipe installs one ValidationPipe with those options', () => {
    const pipes: unknown[] = [];
    const app = { useGlobalPipes: (...p: unknown[]) => pipes.push(...p) } as unknown as INestApplication;
    expect(applyGlobalValidationPipe(app)).toBe(app);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]).toBeInstanceOf(ValidationPipe);
    const pipe = pipes[0] as unknown as { validatorOptions: Record<string, unknown>; isTransformEnabled: boolean };
    expect(pipe.validatorOptions).toMatchObject({ whitelist: true, forbidNonWhitelisted: true });
    expect(pipe.isTransformEnabled).toBe(true);
  });

  it('main.ts applies the pipe through the shared helper (one definition for production and tests)', () => {
    const main = fs.readFileSync(path.join(SRC, 'main.ts'), 'utf8');
    expect(main).toMatch(/applyGlobalValidationPipe\(app\)/);
    expect(main).not.toMatch(/new ValidationPipe\(/);
  });

  it('every createNestApplication() call site, in specs and test helpers, is wrapped in applyGlobalValidationPipe()', () => {
    const offenders: string[] = [];
    let files = 0;
    let sites = 0;
    for (const file of tsFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('createNestApplication')) continue;
      const calls = createNestApplicationCalls(file, source);
      if (calls.length) files += 1;
      sites += calls.length;
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      for (const call of calls) if (!call.wrapped) offenders.push(`${rel}:${call.line}`);
    }
    expect(files).toBeGreaterThan(150);
    expect(sites).toBeGreaterThanOrEqual(files);
    expect(offenders).toEqual([]);
  });

  it('no inline copy of the global pipe remains anywhere under src (the helper is the only definition)', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      if (/useGlobalPipes\(/.test(source)) offenders.push(path.relative(SRC, file).split(path.sep).join('/'));
    }
    expect(offenders).toEqual(['engine/utils/global-validation-pipe.ts']);
  });

  it('the AST rule itself: an unwrapped call, a wrapped one, and a call merely near the helper are told apart', () => {
    const sample = [
      'a = applyGlobalValidationPipe(m.createNestApplication());',
      'b = m.createNestApplication();',
      'applyGlobalValidationPipe(other); c = m.createNestApplication();',
      '// d = m.createNestApplication(); (comment, not a call)',
    ].join('\n');
    expect(createNestApplicationCalls('sample.ts', sample)).toEqual([
      { line: 1, wrapped: true },
      { line: 2, wrapped: false },
      { line: 3, wrapped: false },
    ]);
  });
});

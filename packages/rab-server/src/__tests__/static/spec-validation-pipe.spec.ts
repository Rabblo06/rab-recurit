import * as fs from 'fs';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';

import { applyGlobalValidationPipe, GLOBAL_VALIDATION_PIPE_OPTIONS } from '../../engine/utils/global-validation-pipe';

/**
 * XA-11 (Phase X2, X6.3c): a Nest application built in a spec must validate requests exactly as production does.
 * main.ts applies the global ValidationPipe (whitelist + forbidNonWhitelisted + transform, the anti-mass-assignment
 * control); a spec that builds the app with `createNestApplication()` and skips it runs the API WITHOUT that control, so
 * a test can pass on a body production would refuse with 400. Before this change 13 of the server's specs did that.
 *
 * Every spec under rab-server/src that calls `createNestApplication(` must also apply the pipe through the shared helper
 * (`applyGlobalValidationPipe`), through the AI test kit (which applies it itself), or through the identical inline call
 * the older specs use. main.ts must use the helper, so the production pipe and the test pipe are one definition.
 */
const SRC = path.resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist']);
const INLINE_PRODUCTION_PIPE = /useGlobalPipes\(\s*new ValidationPipe\(\{\s*whitelist: true,\s*forbidNonWhitelisted: true,\s*transform: true,?\s*\}\),?\s*\)/;
const SELF = path.basename(__filename);

function* specFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* specFiles(full);
    else if (/\.(spec|test)\.ts$/.test(entry.name) && entry.name !== SELF) yield full;
  }
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

  it('every spec that calls createNestApplication() applies the production pipe', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of specFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('createNestApplication(')) continue;
      scanned += 1;
      const applies = source.includes('applyGlobalValidationPipe(') || source.includes('bootAiKit(') || INLINE_PRODUCTION_PIPE.test(source);
      if (!applies) offenders.push(path.relative(SRC, file).split(path.sep).join('/'));
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});

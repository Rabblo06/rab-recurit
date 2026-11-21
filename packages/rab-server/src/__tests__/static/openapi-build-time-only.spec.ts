import * as fs from 'fs';
import * as path from 'path';

/**
 * The OpenAPI document is a build artefact, never a runtime surface (no public /docs route, no document served). These
 * pin the three things that keep it that way:
 *   1. only the build-time generator (src/__tests__/contract/openapi/) imports @nestjs/swagger: nothing the app build
 *      compiles (tsconfig.app.json excludes src/__tests__) can reach it;
 *   2. main.ts mounts no Swagger UI or document route;
 *   3. @nestjs/swagger is a devDependency, which the runtime image never installs (`yarn workspaces focus
 *      @rab/server --production`, packages/rab-docker/rab/Dockerfile).
 */
const SERVER = path.resolve(__dirname, '../../..');
const SRC = path.join(SERVER, 'src');
const GENERATOR_DIR = path.join(SRC, '__tests__', 'contract', 'openapi');
const SELF = path.resolve(__filename);

function* tsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield full;
  }
}

describe('OpenAPI is build-time only (no runtime document, no /docs route)', () => {
  it('only the build-time generator imports @nestjs/swagger', () => {
    const importers = [...tsFiles(SRC)]
      .filter((file) => path.resolve(file) !== SELF && !path.resolve(file).startsWith(GENERATOR_DIR + path.sep))
      .filter((file) => /from\s+['"]@nestjs\/swagger['"]|require\(\s*['"]@nestjs\/swagger['"]\s*\)|import\(\s*['"]@nestjs\/swagger['"]\s*\)/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SERVER, file));
    expect(importers).toEqual([]);
  });

  it('the generator lives where the app build never compiles it', () => {
    const tsconfig = fs.readFileSync(path.join(SERVER, 'tsconfig.app.json'), 'utf8');
    expect(tsconfig).toContain('"src/__tests__/**"');
    expect(fs.existsSync(path.join(GENERATOR_DIR, 'generate-openapi.ts'))).toBe(true);
  });

  it('main.ts serves no OpenAPI document or Swagger UI', () => {
    const main = fs.readFileSync(path.join(SRC, 'main.ts'), 'utf8');
    expect(main).not.toMatch(/swagger|openapi|SwaggerModule|redoc/i);
  });

  it('@nestjs/swagger is a devDependency of @rab/server only (never a runtime dependency of any workspace)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    expect(pkg.dependencies?.['@nestjs/swagger']).toBeUndefined();
    expect(pkg.devDependencies?.['@nestjs/swagger']).toBeDefined();
    const packagesDir = path.resolve(SERVER, '..');
    const runtimeUsers = fs
      .readdirSync(packagesDir)
      .map((name) => path.join(packagesDir, name, 'package.json'))
      .filter((file) => fs.existsSync(file))
      .filter((file) => {
        const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
        return p.dependencies?.['@nestjs/swagger'] !== undefined || p.optionalDependencies?.['@nestjs/swagger'] !== undefined;
      })
      .map((file) => path.relative(packagesDir, file));
    expect(runtimeUsers).toEqual([]);
  });
});

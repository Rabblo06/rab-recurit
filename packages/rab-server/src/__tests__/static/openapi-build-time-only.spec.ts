import * as fs from 'fs';
import * as path from 'path';

/**
 * The OpenAPI document is a CI artefact, never a runtime surface and never committed (the repository is public; the
 * document adds nothing an attacker could not read from the source, but there is no reason to publish or serve it).
 * These pin what keeps it that way:
 *   1. no OpenAPI / Swagger library is imported anywhere in the API or the worker, and none is a dependency of any
 *      workspace: the generator (src/__tests__/contract/openapi/) is this repository's own code;
 *   2. nothing outside src/__tests__ imports the generator, and the app build (tsconfig.app.json) excludes src/__tests__;
 *   3. neither main.ts mounts a document or a UI route;
 *   4. no generated document is committed.
 */
const PACKAGES = path.resolve(__dirname, '../../../..');
const SERVER = path.join(PACKAGES, 'rab-server');
const SCANNED = [path.join(SERVER, 'src'), path.join(PACKAGES, 'rab-worker', 'src')];
const GENERATOR_DIR = path.join(SERVER, 'src', '__tests__', 'contract', 'openapi');
const SELF = path.resolve(__filename);
const OPENAPI_LIBRARIES = /['"](@nestjs\/swagger|swagger-ui-express|swagger-ui-dist|swagger-jsdoc|redoc[^'"]*|@fastify\/swagger[^'"]*|openapi3-ts|nestjs-redoc)['"]/;

function* files(dir: string, accept: (name: string) => boolean): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full, accept);
    else if (accept(entry.name)) yield full;
  }
}

const tsFiles = (dir: string) => files(dir, (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));

describe('OpenAPI is a build-time CI artefact (no runtime document, no /docs route, nothing committed)', () => {
  it('no OpenAPI or Swagger library is imported in rab-server or rab-worker', () => {
    const importers = SCANNED.flatMap((dir) => [...tsFiles(dir)])
      .filter((file) => path.resolve(file) !== SELF && OPENAPI_LIBRARIES.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(PACKAGES, file));
    expect(importers).toEqual([]);
  });

  it('no workspace depends on an OpenAPI or Swagger library', () => {
    const manifests = [path.resolve(PACKAGES, '..', 'package.json'), ...fs.readdirSync(PACKAGES).map((name) => path.join(PACKAGES, name, 'package.json'))].filter((file) => fs.existsSync(file));
    const offenders = manifests.flatMap((file) => {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
      return Object.keys(deps).filter((name) => OPENAPI_LIBRARIES.test(`'${name}'`)).map((name) => `${path.relative(PACKAGES, file)}: ${name}`);
    });
    expect(offenders).toEqual([]);
  });

  it('only src/__tests__ imports the generator, and the app build never compiles src/__tests__', () => {
    const importers = SCANNED.flatMap((dir) => [...tsFiles(dir)])
      .filter((file) => !path.resolve(file).startsWith(path.join(SERVER, 'src', '__tests__') + path.sep))
      .filter((file) => /contract\/openapi\//.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(PACKAGES, file));
    expect(importers).toEqual([]);
    expect(fs.readFileSync(path.join(SERVER, 'tsconfig.app.json'), 'utf8')).toContain('"src/__tests__/**"');
    expect(fs.existsSync(path.join(GENERATOR_DIR, 'generate-openapi.ts'))).toBe(true);
  });

  it('neither main.ts serves an OpenAPI document or a Swagger UI', () => {
    for (const main of [path.join(SERVER, 'src', 'main.ts'), path.join(PACKAGES, 'rab-worker', 'src', 'main.ts')].filter((file) => fs.existsSync(file))) {
      expect([path.relative(PACKAGES, main), /swagger|openapi|redoc/i.test(fs.readFileSync(main, 'utf8'))]).toEqual([path.relative(PACKAGES, main), false]);
    }
  });

  it('no generated OpenAPI document is committed under packages/', () => {
    const committed = [...files(PACKAGES, (name) => /openapi\.(json|ya?ml)$/i.test(name))].map((file) => path.relative(PACKAGES, file));
    expect(committed).toEqual([]);
  });
});

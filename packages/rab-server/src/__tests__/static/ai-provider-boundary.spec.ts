import * as fs from 'fs';
import * as path from 'path';

/**
 * Static boundary checks for the AI provider (security 4.1, owner decision 2, REAL_PROVIDER_PLAN conflicts m / ag / ah).
 * There is no ESLint in this repository ("lint" = tsc), so the rules are a jest scan of the sources:
 *
 *   1. A provider SDK (`@ai-sdk/<provider>`) is imported by exactly ONE file: modules/ai/gateway/provider-factory.ts.
 *      Tests included — a test can never construct a real provider.
 *   2. The spec/type packages (`@ai-sdk/provider`, `@ai-sdk/provider-utils`) appear in production code only inside
 *      modules/ai/gateway/; tests may use TYPE-only imports (no runtime code).
 *   3. From `@ai-sdk/anthropic` only `createAnthropic` is imported — never the default `anthropic` instance, which reads
 *      ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL from the environment by itself — and never through `require` or `* as`.
 *      The same holds for EVERY provider package (`@ai-sdk/openai`, `google`, `mistral`, `xai`, ...): only a `create<X>`
 *      factory, never its default instance (TP-8: their key names are inert in Phase 1, no SDK installed, D5).
 *   4. Nothing sets `AI_SDK_DEFAULT_PROVIDER` (a string model id would then route to that provider / the Vercel gateway).
 *   5. Only the gateway calls `streamText` / `generateText` / `streamObject` / `generateObject` in production code.
 *   6. EVERY provider key's variable-name literal (ANTHROPIC_, OPENAI_, GOOGLE_, MISTRAL_, XAI_API_KEY) lives in ONE
 *      constant (provider-keys.ts) plus its schema declaration (environment-variables.ts); no source reads a `*_BASE_URL`
 *      provider fallback, and no production source reads a provider key from `process.env`.
 *   7. No client package depends on `ai` or `@ai-sdk/*`.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SERVER_SRC = path.join(REPO_ROOT, 'packages/rab-server/src');
const SCAN_ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src', 'packages/rab-shared/src', 'packages/rab-front/src', 'packages/rab-ui/src', 'packages/rab-e2e-testing', 'tools'];
const CODE = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'build', '.git', 'coverage']);
const PROVIDER_FACTORY = 'packages/rab-server/src/modules/ai/gateway/provider-factory.ts';
const GATEWAY_DIR = 'packages/rab-server/src/modules/ai/gateway/';
const GATEWAY = 'packages/rab-server/src/modules/ai/gateway/model-gateway.service.ts';
const THIS_FILE = path.relative(REPO_ROOT, __filename).replace(/\\/g, '/');

function* walk(entry: string): Generator<string> {
  if (!fs.existsSync(entry)) return;
  const stat = fs.statSync(entry);
  if (stat.isFile()) {
    yield entry;
    return;
  }
  for (const name of fs.readdirSync(entry)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(path.join(entry, name));
  }
}

interface Source {
  rel: string;
  text: string;
  isTest: boolean;
}
const sources: Source[] = [];
for (const root of SCAN_ROOTS) {
  for (const file of walk(path.join(REPO_ROOT, root))) {
    if (!CODE.has(path.extname(file))) continue;
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    if (rel === THIS_FILE) continue;
    // Jest's own setup files (src/jest-*.ts, excluded from tsconfig.app.json) are test code too.
    sources.push({ rel, text: fs.readFileSync(file, 'utf8'), isTest: /(__tests__|\.spec\.|\.test\.|e2e|\/jest-[a-z-]+\.ts$)/.test(rel) });
  }
}

/** Every module specifier a file imports or requires (static import, dynamic import, export-from, require). */
function specifiers(text: string): Array<{ spec: string; statement: string }> {
  const out: Array<{ spec: string; statement: string }> = [];
  const patterns = [/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g, /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s+['"]([^'"]+)['"]/gm];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push({ spec: m[1]!, statement: m[0] });
  return out;
}
const isProviderSdk = (spec: string) => /^@ai-sdk\/(?!provider$|provider-utils$|provider\/|provider-utils\/)/.test(spec);
const isSpecPackage = (spec: string) => /^@ai-sdk\/(provider|provider-utils)(\/|$)/.test(spec);

describe('AI provider boundary (static scan)', () => {
  it('scans a meaningful set of sources', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some((s) => s.rel === PROVIDER_FACTORY)).toBe(true);
  });

  it('only modules/ai/gateway/provider-factory.ts imports a provider SDK (@ai-sdk/<provider>), tests included', () => {
    const offenders = sources.filter((s) => s.rel !== PROVIDER_FACTORY && specifiers(s.text).some((i) => isProviderSdk(i.spec))).map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it('the spec/type packages stay inside the gateway in production code; tests use type-only imports', () => {
    const offenders: string[] = [];
    for (const s of sources) {
      for (const i of specifiers(s.text).filter((x) => isSpecPackage(x.spec))) {
        if (s.rel.startsWith(GATEWAY_DIR)) continue;
        if (s.isTest && /^import\s+type\s/.test(i.statement.trim())) continue;
        offenders.push(`${s.rel}: ${i.statement.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only createAnthropic is imported from @ai-sdk/anthropic — never the default `anthropic` instance, `* as` or require', () => {
    const factory = sources.find((s) => s.rel === PROVIDER_FACTORY)!;
    const imports = specifiers(factory.text).filter((i) => i.spec === '@ai-sdk/anthropic');
    expect(imports.map((i) => i.statement.replace(/\s+/g, ' '))).toEqual(["import { createAnthropic } from '@ai-sdk/anthropic'"]);
    // No identifier `anthropic` used as a value anywhere in the factory (the default instance), no namespace import.
    expect(factory.text.replace(/@ai-sdk\/anthropic/g, '')).not.toMatch(/\banthropic\s*[.(]/);
    for (const s of sources) expect(`${s.rel}:${/require\s*\(\s*['"]@ai-sdk\/anthropic['"]/.test(s.text)}`).toBe(`${s.rel}:false`);
  });

  it('every provider package is imported only as a create<X> factory (never a default instance), in the provider factory only', () => {
    const factory = sources.find((s) => s.rel === PROVIDER_FACTORY)!;
    for (const i of specifiers(factory.text).filter((x) => isProviderSdk(x.spec))) {
      expect(i.statement.replace(/\s+/g, ' ')).toMatch(/^import \{ create[A-Z][A-Za-z]* \} from '@ai-sdk\/[a-z-]+'$/);
    }
    // No default-instance identifier used as a value in any production file that imports a provider package.
    const DEFAULT_INSTANCE = /\b(openai|google|mistral|xai|anthropic)\s*(\(|\.(languageModel|chat|responses|textEmbeddingModel)\b)/;
    const offenders = sources
      .filter((s) => !s.isTest && specifiers(s.text).some((i) => isProviderSdk(i.spec)) && DEFAULT_INSTANCE.test(s.text.replace(/@ai-sdk\/[a-z-]+/g, '')))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it('nothing assigns AI_SDK_DEFAULT_PROVIDER', () => {
    expect(sources.filter((s) => /AI_SDK_DEFAULT_PROVIDER/.test(s.text)).map((s) => s.rel)).toEqual([]);
  });

  it('only the gateway calls a text/object generation function in production code', () => {
    const offenders = sources
      .filter((s) => !s.isTest && s.rel !== GATEWAY && /\b(streamText|generateText|streamObject|generateObject)\s*\(/.test(s.text))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it('each of the five provider key literals lives in ONE constant (plus its schema declaration); no *_BASE_URL fallback is read', () => {
    const allowed = new Set(['packages/rab-server/src/engine/core-modules/ai/models/provider-keys.ts', 'packages/rab-server/src/engine/core-modules/environment/environment-variables.ts']);
    // Code only (comments may explain the name); the word boundary keeps the constant's own identifier (…_KEY_ENV) out.
    const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const declaration = fs.readFileSync(path.join(SERVER_SRC, 'engine/core-modules/environment/environment-variables.ts'), 'utf8');
    for (const provider of ['ANTHROPIC', 'OPENAI', 'GOOGLE', 'MISTRAL', 'XAI']) {
      const literal = [provider, 'API', 'KEY'].join('_');
      const holders = sources.filter((s) => !s.isTest && new RegExp(`\\b${literal}\\b`).test(code(s.text))).map((s) => s.rel);
      expect(`${literal}: ${holders.filter((r) => !allowed.has(r)).join(', ')}`).toBe(`${literal}: `);
      expect(declaration.match(new RegExp(`^\\s{2}${literal}\\?: string;`, 'm'))).not.toBeNull();
      // Never read straight from the environment by production code (only through EnvironmentService, passed explicitly).
      expect(sources.filter((s) => !s.isTest && new RegExp(`process\\.env(\\.|\\[['"])${literal}`).test(s.text)).map((s) => s.rel)).toEqual([]);
    }
    // Production code never reads a provider endpoint fallback (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, ...). Tests may SET one
    // to prove it is ignored (ai-real-provider-gateway.spec.ts).
    expect(sources.filter((s) => !s.isTest && /process\.env(\.|\[['"])[A-Z0-9]*_BASE_URL/.test(s.text)).map((s) => s.rel)).toEqual([]);
  });

  it('no client package depends on ai or @ai-sdk/*; the server pins them exactly', () => {
    for (const pkg of ['rab-front', 'rab-shared', 'rab-ui', 'rab-worker', 'rab-e2e-testing']) {
      const file = path.join(REPO_ROOT, 'packages', pkg, 'package.json');
      if (!fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
      const deps = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies };
      expect(`${pkg}:${Object.keys(deps).filter((d) => d === 'ai' || d.startsWith('@ai-sdk/')).join(',')}`).toBe(`${pkg}:`);
    }
    const server = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/rab-server/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(server.dependencies).filter(([d]) => d === 'ai' || d.startsWith('@ai-sdk/'))) {
      expect(`${name}@${version}`).toMatch(/@\d+\.\d+\.\d+$/);
    }
    expect(server.dependencies['@ai-sdk/anthropic']).toBe('3.0.129');
    expect(server.dependencies.ai).toBe('6.0.303');
    expect(server.dependencies['@ai-sdk/provider']).toBe('3.0.18');
    // D5: no other provider SDK is installed in Phase 1 (their key names are inert).
    for (const pkg of ['@ai-sdk/openai', '@ai-sdk/google', '@ai-sdk/mistral', '@ai-sdk/xai', '@ai-sdk/openai-compatible']) expect(`${pkg}:${server.dependencies[pkg] ?? 'absent'}`).toBe(`${pkg}:absent`);
  });
});

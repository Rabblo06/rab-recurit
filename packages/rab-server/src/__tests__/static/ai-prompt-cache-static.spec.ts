import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * T7-S1 (PHASE7_TWENTY_PLAN §2.4 / §5, D7-4): prompt caching may only ever use the provider's default 5-minute lifetime —
 * the only one the catalogue prices. So no cache lifetime (`ttl`, any case) appears anywhere in the gateway sources or in
 * the model catalogue facts, and `promptCache` is declared as a zod ENUM in catalog.ts (never a free string).
 */
const SERVER_SRC = path.resolve(__dirname, '../..');
const GATEWAY_DIR = path.join(SERVER_SRC, 'modules/ai/gateway');
const CATALOGUE_JSON = path.join(SERVER_SRC, 'engine/core-modules/ai/models/ai-models.json');
const CATALOG_TS = path.join(SERVER_SRC, 'engine/core-modules/ai/models/catalog.ts');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|json)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

describe('T7-S1 static: no cache lifetime anywhere; promptCache is a zod enum', () => {
  it('finds the gateway directory and the catalogue', () => {
    expect(files(GATEWAY_DIR).length).toBeGreaterThan(0);
    expect(fs.existsSync(CATALOGUE_JSON)).toBe(true);
  });

  it('no `ttl` (any case) in modules/ai/gateway/** or ai-models.json', () => {
    const hits = [...files(GATEWAY_DIR), CATALOGUE_JSON]
      .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f: path.relative(SERVER_SRC, f), line: i + 1, text: line })))
      .filter((l) => /ttl/i.test(l.text));
    expect(hits).toEqual([]);
  });

  it('catalog.ts declares promptCache through the zod enum schema (closed list), required on every entry', () => {
    const source = fs.readFileSync(CATALOG_TS, 'utf8');
    expect(source).toMatch(/AI_PROMPT_CACHE_MODE_SCHEMA = z\.enum\(\['anthropic-auto', 'openai-key', 'none'\]/);
    expect(source).toMatch(/\n\s+promptCache: AI_PROMPT_CACHE_MODE_SCHEMA,\n/);
    expect(source).not.toMatch(/promptCache: AI_PROMPT_CACHE_MODE_SCHEMA\.optional\(\)/);
    expect(source).not.toMatch(/promptCache: z\.string\(\)/);
  });
});

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

import { buildOpenApiDocument, serialiseOpenApiDocument } from './build-openapi-document';

/**
 * Writes the generated OpenAPI document to the file given with `--out` (ci-server `openapi` writes it under RUNNER_TEMP
 * and uploads it as the `openapi` artefact). The document is never committed and never served.
 *
 *   npx ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/__tests__/contract/openapi/generate-openapi.ts --out <file>
 *
 * Reflection only: no database, no Redis, no network, nothing listens. The document is built twice and must come out
 * byte-identical (a generator whose output depends on load order would make every artefact diff noise).
 */
function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!out || args.length !== 2) throw new Error('usage: generate-openapi.ts --out <file>');
  const first = serialiseOpenApiDocument(buildOpenApiDocument());
  const second = serialiseOpenApiDocument(buildOpenApiDocument());
  if (first !== second) throw new Error('OpenAPI: two builds of the same code differ (the generator is not deterministic)');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, first);
  const doc = JSON.parse(first) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
  const operations = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  console.log(`wrote ${out}: ${operations} operations, ${Object.keys(doc.paths).length} paths, ${Object.keys(doc.components.schemas).length} schemas`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}

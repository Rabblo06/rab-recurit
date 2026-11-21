import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

import { buildOpenApiDocument, OPENAPI_DOCUMENT_PATH, serialiseOpenApiDocument } from './build-openapi-document';

/**
 * Writes the generated OpenAPI document to packages/rab-server/openapi/crewflow-api.openapi.json, or with `--check`
 * fails (exit 1) when the committed file differs from what the code generates (ci-server runs the check).
 *
 *   npx ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/__tests__/contract/openapi/generate-openapi.ts [--check]
 *
 * Reflection only: no database, no Redis, no network, nothing listens.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--check')) throw new Error(`unknown argument(s): ${args.join(' ')} (only --check)`);
  const generated = serialiseOpenApiDocument(await buildOpenApiDocument());
  const relative = path.relative(process.cwd(), OPENAPI_DOCUMENT_PATH);
  if (args.includes('--check')) {
    const committed = fs.existsSync(OPENAPI_DOCUMENT_PATH) ? fs.readFileSync(OPENAPI_DOCUMENT_PATH, 'utf8').replace(/\r\n/g, '\n') : '';
    if (committed === generated) {
      console.log(`${relative} matches the code (${Object.keys(JSON.parse(generated).paths).length} paths)`);
      return;
    }
    const a = committed.split('\n');
    const b = generated.split('\n');
    let line = 0;
    while (line < a.length && line < b.length && a[line] === b[line]) line++;
    console.error(`::error file=${relative}::the committed OpenAPI document is out of date with the code (first difference at line ${line + 1}).`);
    console.error(`  committed: ${a[line] ?? '<end of file>'}`);
    console.error(`  generated: ${b[line] ?? '<end of file>'}`);
    console.error('Regenerate it and commit the result: npx ts-node --transpile-only -P packages/rab-server/tsconfig.app.json packages/rab-server/src/__tests__/contract/openapi/generate-openapi.ts');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(OPENAPI_DOCUMENT_PATH), { recursive: true });
  fs.writeFileSync(OPENAPI_DOCUMENT_PATH, generated);
  console.log(`wrote ${relative}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);

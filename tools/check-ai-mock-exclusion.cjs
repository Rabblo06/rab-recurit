#!/usr/bin/env node
/**
 * AI Phase 1 "real models only" (docs/ai/PHASE1_TWENTY_PLAN.md §5, T-X2): proves a BUILT output contains no test model.
 *
 *   node tools/check-ai-mock-exclusion.cjs <dir> [<dir> ...]
 *
 * Scans every file under each directory (e.g. packages/rab-server/dist, packages/rab-worker/dist, or the same paths
 * inside the built image: /app/packages/rab-server/dist, /app/packages/rab-worker/dist) for the markers of the in-process
 * test model. Exit 0 = clean; exit 1 = a marker was found (the offending relative paths are printed, never contents);
 * exit 2 = a directory is missing. The grep equivalent: grep -rlE 'DeterministicMockModel|crewflow-mock|MockLanguageModelV3' <dir>
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKERS = /DeterministicMockModel|crewflow-mock|MockLanguageModelV3|deterministic-mock-model/;
const SKIP = new Set(['node_modules']);

function* walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (stat.isFile()) yield full;
  }
}

function scan(dir) {
  const offenders = [];
  let files = 0;
  for (const file of walk(dir)) {
    files += 1;
    if (MARKERS.test(path.basename(file)) || MARKERS.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(dir, file).replace(/\\/g, '/'));
  }
  return { files, offenders };
}

module.exports = { scan, MARKERS };

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('usage: node tools/check-ai-mock-exclusion.cjs <dir> [<dir> ...]');
    process.exit(2);
  }
  let failed = false;
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.error(`[ai-mock-exclusion] ${dir}: not a directory`);
      process.exit(2);
    }
    const { files, offenders } = scan(dir);
    if (offenders.length > 0) {
      failed = true;
      console.error(`[ai-mock-exclusion] ${dir}: ${offenders.length} file(s) contain a test-model marker:\n  ${offenders.join('\n  ')}`);
    } else {
      console.log(`[ai-mock-exclusion] ${dir}: clean (${files} files scanned)`);
    }
  }
  process.exit(failed ? 1 : 0);
}

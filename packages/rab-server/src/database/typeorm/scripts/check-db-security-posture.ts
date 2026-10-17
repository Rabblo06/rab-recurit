/**
 * Compares a database's effective security posture with the committed golden snapshot (G-03 / CF-41).
 *
 *   POSTURE_DATABASE_URL=postgres://... ts-node check-db-security-posture.ts           # exit 1 on any drift
 *   POSTURE_DATABASE_URL=postgres://... ts-node check-db-security-posture.ts --write   # regenerate the snapshot
 *
 * The URL is read ONLY from POSTURE_DATABASE_URL: never from `.env`, DATABASE_URL or a default. Any role that can read the
 * catalog works (the query is read-only). Regenerate the snapshot only from a database built from migrations alone with
 * the documented identity sequence, and review the diff like code: every changed line is a privilege or ownership change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { diffPosture, readSecurityPosture } from '../core/security-posture';

const GOLDEN = join(__dirname, '..', 'core', 'security-posture.golden.txt');

async function main(): Promise<void> {
  const url = process.env.POSTURE_DATABASE_URL?.trim();
  if (!url) throw new Error('POSTURE_DATABASE_URL is required. There is no fallback.');
  const actual = await readSecurityPosture(url);
  if (process.argv.includes('--write')) {
    writeFileSync(GOLDEN, `${actual.join('\n')}\n`, 'utf8');
    console.log(`wrote ${actual.length} posture lines to ${GOLDEN}`);
    return;
  }
  const expected = readFileSync(GOLDEN, 'utf8').split('\n').filter(Boolean);
  const { missing, unexpected } = diffPosture(expected, actual);
  for (const l of missing) console.log(`- ${l}`);
  for (const l of unexpected) console.log(`+ ${l}`);
  if (missing.length || unexpected.length) {
    console.error(`security posture DRIFT: ${missing.length} expected line(s) missing, ${unexpected.length} unexpected line(s).`);
    process.exit(1);
  }
  console.log(`security posture matches the golden snapshot (${actual.length} lines).`);
}

main().catch((error: Error) => {
  // Never echo the connection string.
  console.error(`posture check failed: ${error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
  process.exit(2);
});

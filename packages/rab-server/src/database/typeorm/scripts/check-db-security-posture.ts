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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareWithGolden, goldenLinesFrom, readFullSecurityPosture, splitGolden } from '../core/security-posture';

const GOLDEN = join(__dirname, '..', 'core', 'security-posture.golden.txt');

/*
 * F4 (Wave 1 lane S): the golden snapshot holds the core lines AND one canonical workspace-template fingerprint (`ws|`
 * lines, schema name and workspace id canonicalised). Every physical `workspace_<32 hex>` schema is compared with that
 * template ON ITS OWN, so the file stays the same whatever the number of workspaces, and one broken workspace is named.
 */
async function main(): Promise<void> {
  const url = process.env.POSTURE_DATABASE_URL?.trim();
  if (!url) throw new Error('POSTURE_DATABASE_URL is required. There is no fallback.');
  const golden = existsSync(GOLDEN) ? readFileSync(GOLDEN, 'utf8').split('\n').filter(Boolean) : [];
  if (process.argv.includes('--write')) {
    const { lines, workspaceSource } = goldenLinesFrom(await readFullSecurityPosture(url), splitGolden(golden).workspace);
    writeFileSync(GOLDEN, `${lines.join('\n')}\n`, 'utf8');
    console.log(`wrote ${lines.length} posture lines to ${GOLDEN} (workspace template: ${workspaceSource})`);
    return;
  }
  const report = await compareWithGolden(url, golden);
  for (const l of report.core.missing) console.log(`- ${l}`);
  for (const l of report.core.unexpected) console.log(`+ ${l}`);
  for (const d of report.workspaces) {
    for (const l of d.missing) console.log(`- [${d.schema}] ${l}`);
    for (const l of d.unexpected) console.log(`+ [${d.schema}] ${l}`);
  }
  const coreDrift = report.core.missing.length + report.core.unexpected.length;
  if (coreDrift || report.workspaces.length) {
    console.error(
      `security posture DRIFT: core ${report.core.missing.length} missing / ${report.core.unexpected.length} unexpected line(s); ` +
        `${report.workspaces.length} of ${report.workspaceCount} workspace schema(s) differ from the template: ${report.workspaces.map((d) => d.schema).join(', ') || 'none'}.`,
    );
    process.exit(1);
  }
  console.log(
    `security posture matches the golden snapshot (${report.lines} lines; ${report.workspaceCount} workspace schema(s) match the template` +
      `${report.workspaceCount === 0 ? ' - none present, template section not exercised' : ''}).`,
  );
}

main().catch((error: Error) => {
  // Never echo the connection string.
  console.error(`posture check failed: ${error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
  process.exit(2);
});

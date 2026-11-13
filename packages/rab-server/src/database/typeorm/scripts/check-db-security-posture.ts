/**
 * Compares a database's effective security posture with the committed golden snapshot (G-03 / CF-41).
 *
 *   POSTURE_DATABASE_URL=postgres://... ts-node check-db-security-posture.ts           # exit 1 on any drift
 *   POSTURE_DATABASE_URL=postgres://... ts-node check-db-security-posture.ts --write   # regenerate the snapshot
 *
 * The URL is read ONLY from POSTURE_DATABASE_URL: never from `.env`, DATABASE_URL or a default. It is connected through the
 * connection factory (security-posture.ts postureClient: URL policy, TLS, explicit fields; security review L-5). Any role that can read the
 * catalog works (the query is read-only). Regenerate the snapshot only from a database built from migrations alone with
 * the documented identity sequence, and review the diff like code: every changed line is a privilege or ownership change.
 *
 * DB-SETUP section 6 follow-up (lead decision 2026-11-12): the golden is selected by the server's PostgreSQL major
 * (security-posture.ts selectSecurityPostureGolden). `--write` on PostgreSQL 16 rewrites security-posture.golden.txt exactly
 * as before. On a later major it writes ONLY that major's workspace template, security-posture.workspace.pg<major>.golden.txt,
 * and refuses when (a) the core lines differ from the reference file (the core is shared by every major: regenerate it on
 * 16 first) or (b) the database holds no workspace schema (a template needs at least one).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  compareWithGolden,
  diffPosture,
  goldenLinesFrom,
  readFullSecurityPosture,
  readSecurityPostureGoldens,
  SECURITY_POSTURE_GOLDEN_FILE,
  SECURITY_POSTURE_REFERENCE_MAJOR,
  splitGolden,
  WORKSPACE_GOLDEN_MAJORS,
  workspaceGoldenFile,
} from '../core/security-posture';

const GOLDEN = SECURITY_POSTURE_GOLDEN_FILE;

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
    const posture = await readFullSecurityPosture(url);
    if (posture.serverMajor === SECURITY_POSTURE_REFERENCE_MAJOR) {
      const { lines, workspaceSource } = goldenLinesFrom(posture, splitGolden(golden).workspace);
      writeFileSync(GOLDEN, `${lines.join('\n')}\n`, 'utf8');
      console.log(`wrote ${lines.length} posture lines to ${GOLDEN} (workspace template: ${workspaceSource})`);
      return;
    }
    const major = posture.serverMajor ?? Number.NaN;
    if (!(WORKSPACE_GOLDEN_MAJORS as readonly number[]).includes(major)) throw new Error(`PostgreSQL ${major} has no workspace golden slot (${WORKSPACE_GOLDEN_MAJORS.join(', ')})`);
    if (posture.workspaces.size === 0) throw new Error(`PostgreSQL ${major}: no workspace schema in this database; a workspace template needs at least one`);
    const { lines } = goldenLinesFrom(posture, []);
    const split = splitGolden(lines);
    const core = diffPosture(splitGolden(golden).core, split.core);
    if (core.missing.length || core.unexpected.length) {
      throw new Error(
        `PostgreSQL ${major}: the core lines differ from the reference golden (${core.missing.length} missing, ${core.unexpected.length} unexpected); ` +
          `the core is shared by every major, regenerate it on PostgreSQL ${SECURITY_POSTURE_REFERENCE_MAJOR} first`,
      );
    }
    const file = workspaceGoldenFile(major);
    writeFileSync(file, `${split.workspace.join('\n')}\n`, 'utf8');
    console.log(`wrote ${split.workspace.length} workspace template lines to ${file} (${posture.workspaces.size} identical workspace schema(s))`);
    return;
  }
  const report = await compareWithGolden(url, readSecurityPostureGoldens());
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
    `security posture matches the PostgreSQL ${report.serverMajor} golden snapshot (${report.lines} lines; ${report.workspaceCount} workspace schema(s) match the template` +
      `${report.workspaceCount === 0 ? ' - none present, template section not exercised' : ''}).`,
  );
}

main().catch((error: Error) => {
  // Never echo the connection string.
  console.error(`posture check failed: ${error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
  process.exit(2);
});

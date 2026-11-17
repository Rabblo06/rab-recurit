/**
 * The PostgreSQL major versions Crewflow supports end to end: install (db-setup), migrate, workspace create, workspace
 * upgrade, and the drift and posture checks. One list, read by every version gate:
 *   - the db-setup bootstrap child (scripts/owner-login/owner-bootstrap.ts), before it creates anything;
 *   - the migrate child (scripts/migrate/locked-migration-runner.ts, through assertSupportedPostgresMajor);
 *   - the API / Worker / CLI boot gate (boot-checks/database-boot-gate-rules.ts, gate 2).
 *
 * A major is supported only when ALL of these exist for it and were reviewed:
 *   - the workspace fingerprints of every module version and structure level (workspace-schema/v1/expected-fingerprints*.ts,
 *     upgrade-commands/<release>/*.ts `fingerprints`);
 *   - the semantic posture golden (posture-drift/semantic-golden.pg<major>.ts);
 *   - the security posture workspace template (typeorm/core/security-posture.workspace.pg<major>.golden.txt, PostgreSQL 16
 *     uses the reference file).
 * supported-majors.spec.ts fails when one of them is missing for a listed major.
 *
 * Not supported:
 *   - 15 and earlier. The role model needs PostgreSQL 16: the owner-login bootstrap grants roles `WITH INHERIT …, SET …`
 *     (scripts/migrate/owner-login/bootstrap.ts), merged migrations call pg_has_role(…, 'SET') and refuse below 16 themselves
 *     (SecureOwnerCoreSchemaAndHelpers1786721100000, UpgradeMigrationLedger1786721470000, MetadataEngineTables1786721550000,
 *     MetadataVersionState1786721560000), the boot gate reads pg_auth_members.inherit_option / set_option, and on 15 a
 *     CREATEROLE login can grant predefined roles such as pg_execute_server_program (M0 F-E1). Merged migrations are never
 *     edited, so 15 cannot be added.
 *   - 19 and later, until their fingerprints and goldens are generated on that major and reviewed.
 */
export const SUPPORTED_POSTGRES_MAJORS = [16, 17, 18] as const;
export type SupportedPostgresMajor = (typeof SUPPORTED_POSTGRES_MAJORS)[number];

/** The supported range as people write it (the refusal text). */
export const SUPPORTED_POSTGRES_RANGE = `${SUPPORTED_POSTGRES_MAJORS[0]}-${SUPPORTED_POSTGRES_MAJORS[SUPPORTED_POSTGRES_MAJORS.length - 1]}`;

/** `server_version_num` (160015, 180001, …) to its major; null when it is not a PostgreSQL 10+ version number. */
export function postgresMajorFromVersionNum(serverVersionNum: unknown): number | null {
  const n = typeof serverVersionNum === 'number' ? serverVersionNum : Number(String(serverVersionNum ?? '').trim());
  if (!Number.isInteger(n) || n < 100000 || n > 9990000) return null;
  return Math.floor(n / 10000);
}

export function isSupportedPostgresMajor(major: number | null | undefined): major is SupportedPostgresMajor {
  return typeof major === 'number' && (SUPPORTED_POSTGRES_MAJORS as readonly number[]).includes(major);
}

/** The one refusal sentence every gate starts with: "PostgreSQL 19 is not supported; use 16-18." */
export function unsupportedPostgresMessage(major: number | null | undefined): string {
  const name = typeof major === 'number' && Number.isInteger(major) ? `PostgreSQL ${major}` : 'This PostgreSQL version';
  return `${name} is not supported; use ${SUPPORTED_POSTGRES_RANGE} (PostgreSQL ${SUPPORTED_POSTGRES_MAJORS.join(', ').replace(/, (\d+)$/, ' or $1')}).`;
}

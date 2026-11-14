/**
 * Part C3, owner rule "No data may be lost: backups before every cutover". The cutover refuses to copy anything unless the
 * operator has recorded a VERIFIED backup of THIS database, taken shortly before the upgrade (runbook step, C3-STATUS.md):
 *
 *   1. stop the API and the Worker (nothing may write between the backup and the cutover);
 *   2. `pg_dump --format=custom` of the database into a directory the upgrade container mounts read-only;
 *   3. restore that dump into a scratch database and check it (pg_restore exit 0, row counts of the 21 core tables);
 *   4. write the marker JSON next to the dump (fields below) and point CREWFLOW_HWS_CUTOVER_BACKUP_MARKER at it;
 *   5. start the new release (the migrate-on-start child runs the cutover).
 *
 * What the command itself verifies (it cannot take or restore the backup): the marker is a small regular file with exactly
 * the reviewed fields; it names THIS database; it is at most 24 h old by the DATABASE clock and not from the future; the dump
 * it names sits next to it (a bare file name, no path), is a pg_dump custom archive ("PGDMP" header), and has exactly the
 * recorded size and sha256 (re-hashed here, so a truncated or swapped file refuses); the operator attested the restore test.
 * Any failure → refusal with an operator-facing reason (never a secret: no URL, no password, no file content).
 */
import type { UpgradeCommandHost } from '../upgrade-command';

export const CUTOVER_BACKUP_MARKER_ENV = 'CREWFLOW_HWS_CUTOVER_BACKUP_MARKER';
export const CUTOVER_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CUTOVER_BACKUP_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const CUTOVER_BACKUP_MARKER_MAX_BYTES = 64 * 1024;

export interface CutoverBackupMarker {
  kind: 'crewflow-hws-cutover-backup';
  version: 1;
  database: string;
  takenAt: string;
  format: 'pg_dump-custom';
  dumpFile: string;
  sha256: string;
  sizeBytes: number;
  restoreVerified: true;
}

export type CutoverBackupCheck = { ok: true; marker: CutoverBackupMarker } | { ok: false; reason: string };

const KEYS = ['database', 'dumpFile', 'format', 'kind', 'restoreVerified', 'sha256', 'sizeBytes', 'takenAt', 'version'];
const DUMP_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Pure: the marker's shape (no I/O). */
export function parseCutoverBackupMarker(text: string): { marker: CutoverBackupMarker } | { reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { reason: 'the backup marker is not valid JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'the backup marker is not a JSON object' };
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== KEYS.join(',')) return { reason: `the backup marker must have exactly the fields ${KEYS.join(', ')}` };
  if (o.kind !== 'crewflow-hws-cutover-backup' || o.version !== 1) return { reason: 'the backup marker kind / version is not crewflow-hws-cutover-backup / 1' };
  if (o.format !== 'pg_dump-custom') return { reason: 'the backup must be a pg_dump custom-format archive (format "pg_dump-custom")' };
  if (typeof o.database !== 'string' || !o.database || o.database.length > 63) return { reason: 'the backup marker database name is missing or invalid' };
  if (typeof o.takenAt !== 'string' || !ISO_RE.test(o.takenAt) || Number.isNaN(Date.parse(o.takenAt))) {
    return { reason: 'the backup marker takenAt is not an ISO-8601 timestamp with a zone' };
  }
  if (typeof o.dumpFile !== 'string' || !DUMP_FILE_RE.test(o.dumpFile)) return { reason: 'the backup marker dumpFile must be a bare file name next to the marker' };
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) return { reason: 'the backup marker sha256 must be 64 lower-case hex digits' };
  if (typeof o.sizeBytes !== 'number' || !Number.isSafeInteger(o.sizeBytes) || o.sizeBytes <= 0) return { reason: 'the backup marker sizeBytes must be a positive integer' };
  if (o.restoreVerified !== true) return { reason: 'the backup marker does not attest that the dump was restored and checked (restoreVerified: true)' };
  return { marker: o as unknown as CutoverBackupMarker };
}

/** The whole check: marker file, shape, database, age by the database clock, and the dump re-hashed. */
export async function verifyCutoverBackup(host: UpgradeCommandHost | undefined, facts: { database: string; dbNow: Date }): Promise<CutoverBackupCheck> {
  if (!host) return { ok: false, reason: 'no host facts were passed to the upgrade command; the backup cannot be verified' };
  const path = host.env[CUTOVER_BACKUP_MARKER_ENV]?.trim();
  if (!path) return { ok: false, reason: `${CUTOVER_BACKUP_MARKER_ENV} is not set: take and verify a backup first (runbook), then point it at the marker file` };
  if (!host.isAbsolutePath(path)) return { ok: false, reason: `${CUTOVER_BACKUP_MARKER_ENV} must be an absolute path` };
  const text = await host.readSmallFile(path, CUTOVER_BACKUP_MARKER_MAX_BYTES);
  if (text === null) return { ok: false, reason: 'the backup marker file does not exist, is not a regular file, or is too large' };
  const parsed = parseCutoverBackupMarker(text);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };
  const m = parsed.marker;
  if (m.database !== facts.database) return { ok: false, reason: 'the backup marker names another database than the one being upgraded' };
  const age = facts.dbNow.getTime() - Date.parse(m.takenAt);
  if (age < -CUTOVER_BACKUP_CLOCK_SKEW_MS) return { ok: false, reason: 'the backup marker takenAt is in the future by the database clock' };
  if (age > CUTOVER_BACKUP_MAX_AGE_MS) return { ok: false, reason: 'the backup is older than 24 hours by the database clock: take a fresh one' };
  const digest = await host.fileDigest(host.siblingPath(path, m.dumpFile));
  if (!digest) return { ok: false, reason: 'the dump file named by the backup marker is not next to it (or is not a regular file)' };
  if (digest.size !== m.sizeBytes) return { ok: false, reason: 'the dump file size differs from the backup marker' };
  if (!digest.head.startsWith('PGDMP')) return { ok: false, reason: 'the dump file is not a pg_dump custom-format archive' };
  if (digest.sha256 !== m.sha256) return { ok: false, reason: 'the dump file sha256 differs from the backup marker' };
  return { ok: true, marker: m };
}

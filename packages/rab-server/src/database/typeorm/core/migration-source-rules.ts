import { createHash } from 'node:crypto';

/**
 * M2: an EARLY-WARNING source scan for core migrations written after Phase 0b (timestamp > PHASE_0B_MIGRATION_TIMESTAMP).
 * It catches the common mistakes cheaply, at unit-test time, before any database exists:
 *   - granting CREATE on schema core directly (only withCrewflowCoreCreate may open that window);
 *   - handing an object to crewflow (`OWNER TO crewflow`) without using withCrewflowCoreCreate in the same file;
 *   - changing the owner of schema core;
 *   - granting rab_secure_owner / crewflow / rab_owner membership to a runtime login;
 *   - giving crewflow or crewflow_app SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB.
 *
 * LIMITATIONS (documented on purpose): this is text, not SQL semantics. SQL assembled at run time (format(), string
 * concatenation, variables) or `EXECUTE` inside a DO block can evade it, and a file that uses the helper for one statement
 * but not for another still passes rule 2. It therefore NEVER approves anything on its own: the authoritative check is the
 * catalog comparison in migration-privilege-drift.ts, which the restricted-migrator CI job runs after every migration.
 */
export const PHASE_0B_MIGRATION_TIMESTAMP = 1786721100000;

/**
 * The chain up to and including Phase 0b is FROZEN: its exact names (count + sha256 of the sorted names, newline-joined).
 * "After Phase 0b" is decided by timestamp, so a NEW migration back-dated to sort before 1786721100000 would skip every
 * post-0b check, yet TypeORM still applies it on databases past 0b (it runs whatever the ledger lacks). Adding one changes
 * this fingerprint and fails CI: re-date it after Phase 0b, or update the fingerprint in a reviewed change that says why.
 *
 * 240 → 241 (2026-10-29): + 1786721090000-VenueTeamOrgAdmin (Assigned Staff for organisation administrators). It was
 * written and applied to the development database before Phase 0b existed and was coordinated with it (both orders,
 * Assigned Staff → 0b and 0b → Assigned Staff, verified with zero posture drift), so it keeps its number: re-dating it
 * would leave its applied ledger row orphaned and re-run it on every database that already has it. It does not skip the
 * post-0b source rules: it is named in PRE_PHASE_0B_HELD_TO_POST_0B_RULES below. Previous value: 240,
 * 57b7e8e8a5aa83ec1695da295e66e80a60da7483fdc6b1f6c9b7606e5fde4f36 (the same set without it).
 */
export const PRE_PHASE_0B_MIGRATIONS = {
  count: 241,
  sha256: '2edbcade95459a78e9e4ee398a4d6411ffe8f73a63bc029fbfb86b09d43e600b',
} as const;

/**
 * Pre-0b migrations admitted to the frozen set after Phase 0b was written. The set feeds two checks:
 *   - the source-text scan (migration-source-rules.spec.ts), which holds them to the post-0b rules like any later file;
 *   - the restricted-migrator harness (scripts/migration-security-check.ts), UPGRADE scenario: they are held back from
 *     the pre-0b base and applied after Phase 0b, one at a time with the catalog privilege-drift check
 *     (postMigrationPrivilegeProblems) — the order every database already at main applies them in. The FRESH scenario
 *     keeps timestamp order (them, then Phase 0b), so CI runs both orders.
 */
export const PRE_PHASE_0B_HELD_TO_POST_0B_RULES: ReadonlySet<string> = new Set(['1786721090000-VenueTeamOrgAdmin']);

/** Count and fingerprint of the migration names (no extension) with timestamp <= Phase 0b. */
export function prePhase0bMigrationFingerprint(names: readonly string[]): { count: number; sha256: string } {
  const frozen = names.filter((n) => Number(n.slice(0, 13)) <= PHASE_0B_MIGRATION_TIMESTAMP).sort();
  return { count: frozen.length, sha256: createHash('sha256').update(frozen.join('\n')).digest('hex') };
}

/** Comments removed so a commented-out statement neither triggers nor hides a rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/--.*$/gm, '');
}

const RUNTIME = String.raw`"?(?:crewflow|crewflow_app)"?`;

export function migrationSourceViolations(source: string): string[] {
  const s = stripComments(source);
  const out: string[] = [];
  if (/GRANT\s[^;`]*\bCREATE\b[^;`]*\bON\s+SCHEMA\s+"?core"?/i.test(s)) {
    out.push('grants CREATE on schema core directly (use withCrewflowCoreCreate)');
  }
  if (new RegExp(String.raw`OWNER\s+TO\s+"?crewflow"?(?![\w])`, 'i').test(s) && !/\bwithCrewflowCoreCreate\s*\(/.test(s)) {
    out.push('hands an object to crewflow without withCrewflowCoreCreate');
  }
  if (/ALTER\s+SCHEMA\s+"?core"?\s+OWNER\b/i.test(s)) out.push('changes the owner of schema core (needs its own reviewed migration)');
  if (new RegExp(String.raw`GRANT\s+"?(?:rab_secure_owner|crewflow|rab_owner)"?(?:\s*,\s*"?\w+"?)*\s+TO\s+${RUNTIME}(?![\w])`, 'i').test(s)) {
    out.push('grants an owner-role membership to a runtime login');
  }
  if (new RegExp(String.raw`ALTER\s+ROLE\s+${RUNTIME}\s[^;\`]*\b(?:SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB)\b`, 'i').test(s)) {
    out.push('gives a runtime login SUPERUSER / BYPASSRLS / CREATEROLE / CREATEDB');
  }
  return out;
}

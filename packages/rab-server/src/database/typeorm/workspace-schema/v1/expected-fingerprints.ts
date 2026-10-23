/**
 * Wave 2 lane S2 (B4): the expected structural fingerprint (core.workspace_schema_fingerprint, sha256 hex) of a correctly
 * built workspace schema at each module version, on PostgreSQL 16. Append-only: a new module adds its version's value,
 * generated from a freshly provisioned workspace on a disposable database built from migrations alone and asserted by
 * `workspace-schema-migrator.integration.spec.ts` (both provisioning paths, and an older schema migrated forward, must
 * all equal it).
 *
 * Used by the migrator to (a) adopt a pre-ledger workspace only when it is exactly a known version (BASELINED), and
 * (b) refuse to commit a migration whose result differs from a fresh build. Used by the drift job as a second opinion.
 * A different PostgreSQL major version may render catalog definitions differently: the migrator then refuses
 * (BASELINE_MISMATCH / FINGERPRINT_MISMATCH — fail closed) and the values must be regenerated for that environment.
 */
export const EXPECTED_WORKSPACE_FINGERPRINTS: Readonly<Record<number, string>> = {
  14: 'd6ceb8196ffe667a50f7092f51a20b29e8c5d61260fe81f2156c7d25b7850be0',
  15: '5f3932d15ddb10ad95bf8d8070fce5bb7fc63e7e9708234074fae3e394b733fc',
};

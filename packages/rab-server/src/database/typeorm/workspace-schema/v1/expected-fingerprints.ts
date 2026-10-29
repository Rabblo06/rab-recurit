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
  // Waves 4+5 lane DB5 (ArchiveAndSearchSchema1786719920000): generated on the disposable crewflow-lane-db5 database.
  16: '3295a8a39f96b887edae863d67cef4441be6e58e3356ab781833264d28d3c394',
  17: '6a8c1dcc77c0f40819a6de484142b36fa2ec29e5aa96e4c61fa7398ea8723fb7',
  // VenueTeamOrgAdmin1786721090000: generated on the disposable rab_p7 database (crewflow-test-db, PostgreSQL 16) from a
  // workspace built by the TypeScript provisioner at module 18; equality with the server path and with a v17 workspace
  // migrated forward is asserted by workspace-schema-migrator.integration.spec.ts.
  18: '8b0e4b7f320928f92f212212a9d793fa77cc526f7d2690e0282fc7ad8c9021be',
};

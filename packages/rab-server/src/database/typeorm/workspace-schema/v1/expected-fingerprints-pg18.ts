/**
 * Twenty Mode Option A, owner decision D4: the expected structural fingerprints (core.workspace_schema_fingerprint, sha256
 * hex) of a correctly built workspace schema at each module version, on PostgreSQL 18. Append-only, like the PostgreSQL 16
 * table in expected-fingerprints.ts, which stays unchanged. Selected by server major (expected-fingerprints.ts).
 *
 * PENDING GENERATION: filled in by the generation run described in the commit that adds the values.
 */
export const EXPECTED_WORKSPACE_FINGERPRINTS_PG18: Readonly<Record<number, string>> = {};

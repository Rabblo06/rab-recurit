/**
 * DB-SETUP §6 (2026-11-12): the expected structural fingerprints (core.workspace_schema_fingerprint, sha256 hex) of a
 * correctly built workspace schema at each module version, on PostgreSQL 17. Append-only, like the PostgreSQL 16 table in
 * expected-fingerprints.ts and the PostgreSQL 18 table in expected-fingerprints-pg18.ts, which stay unchanged. Selected by
 * server major (expected-fingerprints.ts). They differ from both PostgreSQL 16 and PostgreSQL 18 at every version.
 *
 * Generated 2026-11-12 by scripts/generate-workspace-fingerprints.ts (FINGERPRINT_MODE=generate, the PG18 procedure) on
 * a disposable postgres:17-alpine container (PostgreSQL 17.11, image
 * postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b), database fp_gen_mwdysy5qb791, built from
 * migrations alone (256) by the owner-login migrate-on-start child: v14 from a pre-ledger v14 workspace; 15..20 from that
 * workspace migrated forward one module at a time by WorkspaceSchemaMigrator; cross-checked in the same run by a new
 * workspace built by the TypeScript provisioner at module 20 (equal). Reproduced identically on two more fresh clusters
 * (fp_gen_mwdyu1a565bb, generate; fp_gen_mwdyv963169c, the ci/append path). Verified separately with FINGERPRINT_MODE=verify
 * (TypeScript provisioner, server path core.provision_workspace as crewflow_owner, v14 migrated forward) on a fresh
 * PostgreSQL 17 cluster. No migration or SQL change was needed for PostgreSQL 17.
 */
export const EXPECTED_WORKSPACE_FINGERPRINTS_PG17: Readonly<Record<number, string>> = {
  14: '8679b23cb0dc2d9ea15d44d645e2876ba0d2d361a0f29ee824a0574d0decdb54',
  15: 'dc6d05e13203ec33bc7df57b264b4dfa765ad2ee61dae98d1c87746b069ada03',
  16: 'f876e6ea3dd09b2eda0b383c9dc1547257b7e11a4459b0393ff385fbc8ca177a',
  17: '6eb2c89d4d0ef9a9c15079a602eeccb5b74df1a7b0049d8ac43dd5847ea009a6',
  18: '3c321fa069306afbfbc7f5c87e1eb6b8c328db15bdfb1474120a7eedca5b0c5a',
  19: 'a0efbe25d23403b863b1100c679a04c9791509d94a4bc95f5fcf4a6f9f055772',
  20: '5d5e43ef2260aa172cab4cce2d75ec5d989373dbf735b44fa36eb71df8df3720',
};

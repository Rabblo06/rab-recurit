/**
 * Twenty Mode Option A / owner-login architecture, owner decision D4: the expected structural fingerprints
 * (core.workspace_schema_fingerprint, sha256 hex) of a correctly built workspace schema at each module version, on
 * PostgreSQL 18. Append-only, like the PostgreSQL 16 table in expected-fingerprints.ts, which stays unchanged. Selected by
 * server major (expected-fingerprints.ts). They differ from PostgreSQL 16 at every version (M0 B4: PostgreSQL 18 records
 * NOT NULL constraints as pg_constraint rows, contype 'n').
 *
 * Generated 2026-11-04 by scripts/generate-workspace-fingerprints.ts (FINGERPRINT_MODE=generate) on a disposable
 * postgres:18-alpine (PostgreSQL 18.6) container, database fp_gen_mw2cimq47857, built from migrations alone by the
 * owner-login migrate-on-start child: v14 from a pre-ledger v14 workspace (the migrator suite's legacy build); 15..19 from
 * that workspace migrated forward one module at a time by WorkspaceSchemaMigrator; cross-checked in the same run by a
 * new workspace built by the TypeScript provisioner at module 19 (equal). Verified separately with FINGERPRINT_MODE=verify
 * (TypeScript provisioner, server path core.provision_workspace, v14 migrated forward) on a fresh PostgreSQL 18 database.
 */
export const EXPECTED_WORKSPACE_FINGERPRINTS_PG18: Readonly<Record<number, string>> = {
  14: '762c6e981649073b35847c39459d0dc763ba471b8c93f653073c240712480b7e',
  15: '66449e15dd7a4fe52c7214c861d1be04ff36175b780b05619f250043f2754562',
  16: 'acd91b4c7bea60d8f5220f6ce10d5dbba8de1ec0c20daa64bde2019a45e5d589',
  17: '3c5cf741074298397189b0a0076e21e4c897a3fbc627a8779e64f544a857cb0f',
  18: '4abe001915802d3bf6fded617f39bee387672cdbfc765f40ec6d922b02a9b681',
  19: 'af115ec7490665c7df38fbc78128e95e680e59764bb626e4c21d0c061fe699e6',
  // WorkspaceGrantParityGuards1786721430000 (PAY-1, module v1.020-grant-parity-guards): generated 2026-11-04 by
  // generate-workspace-fingerprints.ts FINGERPRINT_MODE=append on a disposable PostgreSQL 18.6 (fp_gen_mw2ee2ncff07); modules 14..19 regenerated
  // identically in the same run; cross-checked by the TypeScript provisioner at module 20.
  20: '32b7904407c0e07247917d134ba9c1060780d09695126ab1de878f049b87461f',
};

/**
 * The `transaction = false` migrations (M0: the runner comment said six). + the index fix (2026-11-06): 1786721440000 and
 * 1786721450000 (CREATE INDEX CONCURRENTLY; a failed build leaves an INVALID index that their re-run drops). + Phase X U-1
 * (SU-03 / XD-04, 2026-11-11): 1786721430000 WorkspaceGrantParityGuards, which commits one transaction per workspace schema
 * and so may keep part of its work after a failure. The spec (release-floor.spec.ts) derives this list from the migration
 * sources and compares. Moved here from the retired upgrade-failure-policy.ts (OWNER-DB-ULTIMATE Part B3: a failed migration
 * always refuses, so no serve decision depends on it any more; it documents which failures can leave partial DDL).
 */
export const NON_TRANSACTIONAL_MIGRATIONS: readonly number[] = [
  1786676100000, 1786719810000, 1786719920000, 1786719950000, 1786720110000, 1786721090000, 1786721320000, 1786721430000, 1786721440000,
  1786721450000,
];

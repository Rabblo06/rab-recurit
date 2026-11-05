/**
 * The database state classifier and the fresh-install proof moved to database/owner-login/install-state.ts (so the boot
 * gates can use them without depending on the migration scripts). Re-exported here unchanged for the runner, the child and
 * their specs.
 */
export {
  CATALOG_FACTS_SQL,
  classifyDatabase,
  classifyDatabaseState,
  decideFreshInstall,
  readCatalogFacts,
  readFreshInstallProof,
  TENANT_EVIDENCE_SQL,
} from '../../../../owner-login/install-state';
export type { CatalogFacts, Classification, DatabaseInstallState, FreshInstallProof, InstallStateQuery } from '../../../../owner-login/install-state';

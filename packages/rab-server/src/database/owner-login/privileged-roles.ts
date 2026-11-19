/**
 * The ONE list of roles the app login (crewflow_owner) must never reach, shared by the runtime posture (boot gates, the
 * runtime-role assertion, tools/check-rls-coverage.ts and the periodic posture monitor, through owner-login-posture.ts) and
 * db-setup (owner-bootstrap-sql.ts, switched to it separately). Before this module the two kept their own lists, and they
 * disagreed (db-setup had pg_checkpoint, the runtime had the provider roles). Matched by NAME: a role that does not exist
 * on this major or this provider is simply never reached. Pure data, no I/O.
 */

/**
 * Predefined roles that confer data access beyond RLS (pg_read_all_data, pg_write_all_data), server file or program access,
 * backend signalling, outbound subscriptions, table maintenance (pg_maintain, PG17+), forced checkpoints (pg_checkpoint,
 * PG15+) or the superuser-reserved connection slots (pg_use_reserved_connections, PG16+). The first six are the M0 list.
 */
export const DANGEROUS_PREDEFINED_ROLES: readonly string[] = Object.freeze([
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
  'pg_signal_backend',
  'pg_create_subscription',
  'pg_maintain',
  'pg_checkpoint',
  'pg_use_reserved_connections',
  // Security review L-2 (PR #257): backend signalling to autovacuum workers (PG18), and the monitoring roles that read other
  // sessions' queries, every setting and the statistics views. The reachability rule is closed-world anyway; naming them
  // gives a clearer message.
  'pg_signal_autovacuum_worker',
  'pg_monitor',
  'pg_read_all_stats',
  'pg_read_all_settings',
  'pg_stat_scan_tables',
]);

/**
 * Managed-provider administrator roles (M0 §3.5 / E). Their dangerous attributes are usually also caught by the attribute
 * rules (SUPERUSER / BYPASSRLS / REPLICATION / CREATEDB / CREATEROLE), but some are plain NOLOGIN roles that carry
 * predefined-role memberships or provider hooks, so they are refused by name as well.
 */
export const PROVIDER_ADMIN_ROLES: readonly string[] = Object.freeze([
  'neon_superuser',
  'rds_superuser',
  'rds_replication',
  'rds_password',
  'rdsadmin',
  'rds_ad',
  'cloudsqlsuperuser',
  'cloudsqladmin',
  'cloudsqlreplica',
  'alloydbsuperuser',
  'azure_pg_admin',
  'azure_superuser',
  'azuresu',
  'supabase_admin',
  'supabase_replication_admin',
  'supabase_storage_admin',
  'supabase_auth_admin',
  'doadmin',
  'tsdbadmin',
]);

/** Every role refused by name (predefined + provider). */
export const PRIVILEGED_ROLE_NAMES: readonly string[] = Object.freeze([...DANGEROUS_PREDEFINED_ROLES, ...PROVIDER_ADMIN_ROLES]);

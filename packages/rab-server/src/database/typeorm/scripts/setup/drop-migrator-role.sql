-- Removes crewflow_migrator from a DISPOSABLE cluster (the counterpart of create-migrator-role.sql; same rules, run only
-- through migrator-role.ts --drop). DROP ROLE itself refuses while the role owns an object or holds a privilege in any
-- database of the cluster, so a migrator that left something behind is reported, not silently cleaned.
DO $migrator$
BEGIN
  -- Security review L-1: a server-side marker only (see create-migrator-role.sql).
  IF NOT (
    EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
             WHERE s.setrole = 0
               AND s.setdatabase IN (0, (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()))
               AND 'crewflow.disposable_cluster=on' = ANY (s.setconfig))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_file_settings f
                WHERE f.name = 'crewflow.disposable_cluster' AND f.setting = 'on' AND f.error IS NULL)
    OR coalesce(pg_catalog.pg_read_file('postmaster.opts', true), '') ~ '"-c" "crewflow[.]disposable_cluster=on"'
  ) THEN
    RAISE EXCEPTION 'refusing: this cluster is not marked disposable server-side (crewflow.disposable_cluster = on).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename = 'crewflow_migrator') THEN
    RAISE EXCEPTION 'refusing: crewflow_migrator still has open sessions.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_migrator') THEN
    DROP ROLE crewflow_migrator;
  END IF;
END
$migrator$;

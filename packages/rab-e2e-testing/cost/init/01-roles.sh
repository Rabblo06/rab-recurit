#!/bin/sh
# Disposable cost stack only. Same role layout as packages/rab-docker/postgres-init/01-roles.sql (rab_owner owns the
# database and runs phase-A migrations; rab_app is the pre-split runtime name), but with the random password from the
# operator's env file instead of the checked-in dev literal. Runs once, at initdb, inside the postgres container.
# docker-entrypoint.sh may SOURCE this file, so no `set -u` here (it would leak into the entrypoint).
if [ -z "${COST_RAB_OWNER_PW:-}" ]; then echo "COST_RAB_OWNER_PW missing" >&2; exit 1; fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v owner_pw="$COST_RAB_OWNER_PW" <<'SQL'
CREATE ROLE rab_owner LOGIN PASSWORD :'owner_pw';
-- Never used to log in on this stack (random throwaway password, the value is not kept anywhere).
SELECT format('CREATE ROLE rab_app LOGIN PASSWORD %L NOBYPASSRLS', md5(random()::text || clock_timestamp()::text)) \gexec
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO rab_owner', current_database()); END $$;
CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION rab_owner;
GRANT USAGE ON SCHEMA core TO rab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO rab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT EXECUTE ON FUNCTIONS TO rab_app;
-- Marker every harness script checks before writing, so it can only ever write to THIS disposable cluster.
COMMENT ON DATABASE rab IS 'crewflow-cost disposable measurement database';
SQL

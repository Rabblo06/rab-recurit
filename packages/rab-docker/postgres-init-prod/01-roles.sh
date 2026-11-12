#!/bin/sh
# Production version of postgres-init/01-roles.sql: same roles and grants,
# but passwords come from the environment instead of hard-coded dev values.
# Runs once, automatically, when the Postgres data volume is first created.
# Save as: packages/rab-docker/postgres-init-prod/01-roles.sh
set -e

psql -v ON_ERROR_STOP=1 \
  -v owner_pw="$RAB_OWNER_PASSWORD" \
  -v app_pw="$RAB_APP_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE rab_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE rab_app LOGIN PASSWORD :'app_pw' NOBYPASSRLS;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO rab_owner', current_database());
END
$$;

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION rab_owner;
GRANT USAGE ON SCHEMA core TO rab_app;

ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core
  GRANT USAGE, SELECT ON SEQUENCES TO rab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core
  GRANT EXECUTE ON FUNCTIONS TO rab_app;
EOSQL

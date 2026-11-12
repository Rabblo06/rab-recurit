-- Disposable e2e system stack only (docker-compose.e2e.yml): statement counters for measurement windows. The server is
-- started with shared_preload_libraries=pg_stat_statements; run-system.sh `idle` counts the application's rows
-- (crewflow_owner sessions), never the harness superuser's.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Disposable e2e system stack only (docker-compose.e2e.yml): statement counters for measurement windows. The server is
-- started with shared_preload_libraries=pg_stat_statements; run-system.sh `idle` filters the rows on crewflow_owner.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

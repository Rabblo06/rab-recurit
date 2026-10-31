-- Disposable cost stack only: statement counters for the measurement windows (the server is started with
-- shared_preload_libraries=pg_stat_statements, pg_stat_statements.track=all).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

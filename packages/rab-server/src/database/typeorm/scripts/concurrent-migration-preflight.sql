-- Preflight for a migration that runs CREATE INDEX CONCURRENTLY (any migration with transaction = false).
-- READ ONLY. Run before deploying such a migration, against the target database, with psql:
--   psql "$DATABASE_URL" -f concurrent-migration-preflight.sql
--
-- A concurrent build waits for EVERY older transaction that could see the table, so a single long-open session can stall it
-- for as long as that session lives. Nothing in this file terminates anything. The operator reads the output, decides, and
-- only then cancels a named PID (see docs/architecture/MIGRATION-EXECUTION-POLICY.md, section 6).

\echo '== 1. Transactions open longer than 5 minutes (excluding this session)'
SELECT pid, usename, application_name, state, now() - xact_start AS xact_age,
       now() - query_start AS query_age, wait_event_type, wait_event, left(query, 200) AS query
  FROM pg_stat_activity
 WHERE xact_start IS NOT NULL
   AND xact_start < now() - interval '5 minutes'
   AND pid <> pg_backend_pid()
 ORDER BY xact_start;

\echo '== 2. Sessions idle in transaction for more than 1 minute (hold a snapshot, block concurrent builds)'
SELECT pid, usename, application_name, now() - state_change AS idle_for, now() - xact_start AS xact_age,
       left(query, 200) AS last_query
  FROM pg_stat_activity
 WHERE state = 'idle in transaction'
   AND state_change < now() - interval '1 minute'
   AND pid <> pg_backend_pid()
 ORDER BY state_change;

\echo '== 3. Blocking chains (who is blocking whom)'
SELECT blocked.pid AS blocked_pid, left(blocked.query, 120) AS blocked_query,
       blocking.pid AS blocking_pid, blocking.state AS blocking_state,
       now() - blocking.xact_start AS blocking_xact_age, left(blocking.query, 120) AS blocking_query
  FROM pg_stat_activity blocked
  JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON true
  JOIN pg_stat_activity blocking ON blocking.pid = b.pid
 ORDER BY blocking_xact_age DESC NULLS LAST;

\echo '== 4. Locks held or awaited on the tables the venue_manager_staff composite-FK migrations touch'
SELECT a.pid, a.state, l.relation::regclass AS relation, l.mode, l.granted,
       now() - a.query_start AS query_age, left(a.query, 120) AS query
  FROM pg_locks l
  JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.relation IN ('core.staff_profile'::regclass, 'core.manager_profile'::regclass, 'core.venue_manager_staff'::regclass)
   AND a.pid <> pg_backend_pid()
 ORDER BY l.granted, query_age DESC NULLS LAST;

\echo '== 5. Concurrent index builds already in progress'
SELECT p.pid, p.relid::regclass AS relation, p.phase, p.blocks_done, p.blocks_total,
       now() - a.query_start AS running_for
  FROM pg_stat_progress_create_index p
  JOIN pg_stat_activity a ON a.pid = p.pid;

\echo '== 6. INVALID indexes left by a failed concurrent build (must be empty before a rerun, or the migration clears them)'
SELECT indexrelid::regclass AS invalid_index, indrelid::regclass AS table_name
  FROM pg_index
 WHERE NOT indisvalid;

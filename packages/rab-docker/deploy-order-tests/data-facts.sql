-- Deploy-order real-container tests (TEST-ONLY): the facts the driver compares BEFORE and AFTER an upgrade, read as the
-- disposable stack's PostgreSQL superuser. One line per fact, `kind|key|value`, sorted, no secret:
--   rows|<table>|<org slug>|<count>:<md5 of the sorted row ids>   every core table with organisation_id and an id column,
--                                                                  per seeded organisation (dot-seed-*)
--   fk|<constraint>|<orphan rows>                                  every FOREIGN KEY of schema core, checked row by row
--   own|<constraint>|<rows whose organisation_id differs from the referenced row's>
--                                                                  every core FK whose two tables both carry organisation_id
--   content|<table>|<org slug>|<count>:<md5 of a fixed list of columns of every row, in id order>   the seeded tables
--   money|<table.column>|<org slug>|<sum>
--   ledger|count|<n>
-- Read-only: it creates a TEMP table only.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
CREATE TEMP TABLE dot_fact (kind text, key text, value text);
DO $facts$
DECLARE
  t record; c record; n bigint; h text; cond text; ocond text;
BEGIN
  FOR t IN
    SELECT cl.relname
      FROM pg_catalog.pg_class cl JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname = 'core' AND cl.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = cl.oid AND a.attname = 'organisation_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = cl.oid AND a.attname = 'id' AND NOT a.attisdropped)
     ORDER BY cl.relname
  LOOP
    FOR c IN EXECUTE format(
      'SELECT o.slug::text AS slug, count(x.id) AS n, coalesce(md5(string_agg(x.id::text, '','' ORDER BY x.id::text)), ''-'') AS h
         FROM core.organisation o LEFT JOIN core.%I x ON x.organisation_id = o.id
        WHERE o.slug::text LIKE ''dot-seed-%%'' GROUP BY o.slug', t.relname)
    LOOP
      INSERT INTO dot_fact VALUES ('rows', t.relname || '|' || c.slug, c.n || ':' || c.h);
    END LOOP;
  END LOOP;

  FOR c IN
    SELECT con.conname, ch.relname AS child, pa.relname AS parent,
           (SELECT array_agg(a.attname::text ORDER BY k.i) FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS ccols,
           (SELECT array_agg(a.attname::text ORDER BY k.i) FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS pcols,
           EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'organisation_id' AND NOT a.attisdropped) AS child_org,
           EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'organisation_id' AND NOT a.attisdropped) AS parent_org
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class ch ON ch.oid = con.conrelid JOIN pg_catalog.pg_namespace cn ON cn.oid = ch.relnamespace
      JOIN pg_catalog.pg_class pa ON pa.oid = con.confrelid JOIN pg_catalog.pg_namespace pn ON pn.oid = pa.relnamespace
     WHERE con.contype = 'f' AND cn.nspname = 'core' AND pn.nspname = 'core'
     ORDER BY con.conname, ch.relname
  LOOP
    SELECT string_agg(format('c.%I = p.%I', c.ccols[i], c.pcols[i]), ' AND '),
           string_agg(format('c.%I IS NOT NULL', c.ccols[i]), ' AND ')
      INTO cond, ocond FROM generate_subscripts(c.ccols, 1) AS i;
    EXECUTE format('SELECT count(*) FROM core.%I c WHERE %s AND NOT EXISTS (SELECT 1 FROM core.%I p WHERE %s)', c.child, ocond, c.parent, cond) INTO n;
    INSERT INTO dot_fact VALUES ('fk', c.child || '.' || c.conname, n::text);
    IF c.child_org AND c.parent_org AND c.parent <> 'organisation' AND NOT ('organisation_id' = ANY (c.ccols)) THEN
      EXECUTE format('SELECT count(*) FROM core.%I c JOIN core.%I p ON %s WHERE c.organisation_id IS DISTINCT FROM p.organisation_id', c.child, c.parent, cond) INTO n;
      INSERT INTO dot_fact VALUES ('own', c.child || '.' || c.conname, n::text);
    END IF;
  END LOOP;

  -- Content of the seeded rows (review note 1): a FIXED list of existing columns per seeded table (tenant keys, references,
  -- status, money, minutes, key timestamps, identity text), hashed per organisation in id order, so a migration that
  -- REWRITES a value (not only one that adds or drops a row) changes the fact. Every listed column must exist (a missing
  -- one fails the run: the list is reviewed, not discovered).
  FOR c IN
    SELECT * FROM (VALUES
      ('attendance', 'organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence'),
      ('job_offer', 'organisation_id, workspace_id, shift_assignment_id, staff_profile_id, status, estimated_pay_pence, sent_at, expires_at'),
      ('job_role', 'organisation_id, workspace_id, name, default_rate_pence'),
      ('manager_profile', 'organisation_id, user_id, type, workspace_id'),
      ('manager_workspace', 'organisation_id, owner_user_id, name, subdomain, status'),
      ('payroll_calendar', 'organisation_id, year, version, source, created_by'),
      ('payroll_calendar_period', 'organisation_id, calendar_id, period_start, period_end, payday'),
      ('payroll_record', 'organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence, approved_at, approved_by'),
      ('payroll_run', 'organisation_id, workspace_id, period_id, prepared_by'),
      ('payroll_run_line', 'organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, worked_minutes, pay_rate_pence, amount_pence'),
      ('role', 'organisation_id, key, name, is_system'),
      ('shift', 'organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by'),
      ('shift_assignment', 'organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, assigned_by'),
      ('staff_profile', 'organisation_id, workspace_id, user_id, staff_ref, created_by'),
      ('user', 'organisation_id, email, first_name, last_name, status, password_hash'),
      ('venue', 'organisation_id, workspace_id, name, created_by'),
      ('workspace_membership', 'organisation_id, workspace_id, user_id, status, source')
    ) AS v(tbl, cols)
  LOOP
    FOR t IN EXECUTE format(
      'SELECT o.slug::text AS slug, count(x.id) AS n,
              coalesce(md5(string_agg(concat_ws(''|'', x.id, %s), E''\n'' ORDER BY x.id::text)), ''-'') AS h
         FROM core.organisation o LEFT JOIN core.%I x ON x.organisation_id = o.id
        WHERE o.slug::text LIKE ''dot-seed-%%'' GROUP BY o.slug',
      (SELECT string_agg(format('x.%I::text', trim(col)), ', ') FROM unnest(string_to_array(c.cols, ',')) AS col), c.tbl)
    LOOP
      INSERT INTO dot_fact VALUES ('content', c.tbl || '|' || t.slug, t.n || ':' || t.h);
    END LOOP;
  END LOOP;

  -- Money and worked minutes of the seeded organisations (bigint pence; minutes as written by the seed).
  INSERT INTO dot_fact
    SELECT 'money', 'payroll_record.amount_pence|' || o.slug, coalesce(sum(r.amount_pence), 0)::text
      FROM core.organisation o LEFT JOIN core.payroll_record r ON r.organisation_id = o.id WHERE o.slug::text LIKE 'dot-seed-%' GROUP BY o.slug;
  INSERT INTO dot_fact
    SELECT 'money', 'payroll_run_line.amount_pence|' || o.slug, coalesce(sum(l.amount_pence), 0)::text
      FROM core.organisation o LEFT JOIN core.payroll_run_line l ON l.organisation_id = o.id WHERE o.slug::text LIKE 'dot-seed-%' GROUP BY o.slug;
  INSERT INTO dot_fact
    SELECT 'money', 'attendance.worked_minutes|' || o.slug, coalesce(sum(a.worked_minutes), 0)::text
      FROM core.organisation o LEFT JOIN core.attendance a ON a.organisation_id = o.id WHERE o.slug::text LIKE 'dot-seed-%' GROUP BY o.slug;

  SELECT count(*) INTO n FROM core.migrations;
  INSERT INTO dot_fact VALUES ('ledger', 'count', n::text);
END
$facts$;
SELECT kind || '|' || key || '|' || value FROM dot_fact ORDER BY kind, key;

-- Deploy-order real-container tests (TEST-ONLY): the facts the driver compares BEFORE and AFTER an upgrade, read as the
-- disposable stack's PostgreSQL superuser. One line per fact, `kind|key|value`, sorted, no secret:
--   rows|<table>|<org slug>|<count>:<md5 of the sorted row ids>   every core table with organisation_id and an id column,
--                                                                  per seeded organisation (dot-seed-*)
--   fk|<constraint>|<orphan rows>                                  every FOREIGN KEY of schema core, checked row by row
--   own|<constraint>|<rows whose organisation_id differs from the referenced row's>
--                                                                  every core FK whose two tables both carry organisation_id
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

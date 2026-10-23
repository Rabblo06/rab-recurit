/**
 * FROZEN with migration HostLabelNamespace1786719820000 (never edited after merge). Kept out of the migration file
 * because TypeORM loads every export of a migration file as a migration class.
 *
 * Wave 3 schema for lane H (C1 one namespace, C2 reserved labels, C4 rename quarantine, C5 host → workspace lookup).
 * Contract: docs/evidence/wave2-lane-s2/CONTRACT.md. Design summary:
 *  - `manager_workspace.subdomain` is the only ROUTABLE host label; `organisation.slug` stays (login-provider lookup, admin
 *    UI) but is not routable.
 *  - `core.host_label_claim` mirrors every subdomain and slug (maintained only by triggers). Its
 *    `EXCLUDE USING gist (label WITH =, organisation_id WITH <>)` makes it impossible — race-safe, at commit — for two
 *    DIFFERENT organisations to hold the same label through either namespace. Same-organisation overlap is allowed.
 *  - `core.reserved_host_label` + prefix rules: refused for every new/changed workspace subdomain.
 *  - `core.released_host_label`: a renamed or deleted workspace's old label is quarantined for
 *    `core.host_label_quarantine_interval()`; only the releasing workspace may reclaim it meanwhile.
 *  - Narrow SECURITY DEFINER functions (owner rab_secure_owner, NOLOGIN; search_path pinned; PUBLIC revoked) are the only
 *    way the runtime role reads any of it. The runtime role has NO privilege on the three new tables.
 */
export const HOST_LABEL_NAMESPACE_UP_SQL = `
-- ---------------------------------------------------------------------------------------------------------------
-- Reserved labels (global reference data: no organisation_id, not tenant-scoped).
CREATE TABLE core.reserved_host_label (
  label    text PRIMARY KEY,
  category text NOT NULL,
  CONSTRAINT reserved_host_label_label_check CHECK (label ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT reserved_host_label_category_check CHECK (category IN ('INFRASTRUCTURE', 'IDENTITY', 'PRODUCT', 'BRAND', 'TWENTY_PARITY'))
);
ALTER TABLE core.reserved_host_label OWNER TO crewflow;
ALTER TABLE core.reserved_host_label ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.reserved_host_label FORCE ROW LEVEL SECURITY;
CREATE POLICY reserved_host_label_read ON core.reserved_host_label AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
CREATE POLICY reserved_host_label_maintain ON core.reserved_host_label AS PERMISSIVE FOR ALL TO crewflow USING (true) WITH CHECK (true);
REVOKE ALL ON core.reserved_host_label FROM PUBLIC;
REVOKE ALL ON core.reserved_host_label FROM crewflow_app;
GRANT SELECT ON core.reserved_host_label TO rab_secure_owner;

-- ---------------------------------------------------------------------------------------------------------------
-- Owner-tunable quarantine length. Changing it is a reviewed migration that re-creates this one function.
CREATE FUNCTION core.host_label_quarantine_interval()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $q$ SELECT interval '90 days' $q$;

CREATE FUNCTION core.host_label_shape_ok(p_label text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $s$ SELECT p_label IS NOT NULL AND p_label ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$' $s$;

CREATE FUNCTION core.host_label_is_reserved(p_label text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $r$
DECLARE
  v text := pg_catalog.lower(pg_catalog.btrim(p_label));
BEGIN
  IF v IS NULL OR v = '' THEN
    RETURN true;
  END IF;
  RETURN v ~ '^(..--|api-|www-|crewflow-)'
      OR EXISTS (SELECT 1 FROM core.reserved_host_label r WHERE r.label = v);
END;
$r$;

-- ---------------------------------------------------------------------------------------------------------------
-- One claim registry for both namespaces (write side; maintained only by the triggers below).
CREATE TABLE core.host_label_claim (
  label           text        NOT NULL,
  kind            text        NOT NULL,
  organisation_id uuid        NOT NULL REFERENCES core.organisation (id) ON DELETE CASCADE,
  workspace_id    uuid,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT host_label_claim_pkey PRIMARY KEY (label, kind),
  CONSTRAINT host_label_claim_label_check CHECK (label = pg_catalog.lower(label) AND char_length(label) BETWEEN 1 AND 255),
  CONSTRAINT host_label_claim_kind_check CHECK (kind IN ('WORKSPACE_SUBDOMAIN', 'ORGANISATION_SLUG')),
  CONSTRAINT host_label_claim_workspace_kind_check CHECK ((kind = 'WORKSPACE_SUBDOMAIN') = (workspace_id IS NOT NULL)),
  CONSTRAINT host_label_claim_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
    REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT host_label_claim_one_organisation EXCLUDE USING gist (label WITH =, organisation_id WITH <>)
);
CREATE UNIQUE INDEX host_label_claim_workspace_key ON core.host_label_claim (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX host_label_claim_organisation_slug_key ON core.host_label_claim (organisation_id) WHERE kind = 'ORGANISATION_SLUG';
ALTER TABLE core.host_label_claim OWNER TO crewflow;
ALTER TABLE core.host_label_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.host_label_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY host_label_claim_tenant ON core.host_label_claim AS PERMISSIVE FOR ALL TO PUBLIC
  USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
REVOKE ALL ON core.host_label_claim FROM PUBLIC;
REVOKE ALL ON core.host_label_claim FROM crewflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.host_label_claim TO rab_secure_owner;

-- ---------------------------------------------------------------------------------------------------------------
-- Rename / delete quarantine.
-- SECURITY TRADE-OFF (NOT FORCE, same class as manager_workspace / organisation): core.resolve_released_host_label is a
-- PRE-AUTH lookup (an old host label → its workspace's current label, for a redirect) that must find the row before any
-- tenant context exists, and the subdomain write triggers must see other organisations' live quarantines to refuse a
-- claim. Both run as the table owner (rab_secure_owner, NOLOGIN) through SECURITY DEFINER functions; FORCE would bind the
-- owner to the organisation policy and make both impossible. ENABLE stays on with a real organisation policy; the runtime
-- role crewflow_app has NO privilege on this table at all (it cannot even reach the policy), and crewflow has none either.
-- organisation_id / workspace_id deliberately have NO foreign key: a quarantine must outlive the workspace (and the
-- organisation) it protects, or deleting a tenant would free its links for immediate takeover. Rows hold a label and
-- uuids only (no personal data). Retention: kept as history; expiry is by reserved_until, never by deletion.
CREATE TABLE core.released_host_label (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text        NOT NULL,
  workspace_id    uuid        NOT NULL,
  organisation_id uuid        NOT NULL,
  released_at     timestamptz NOT NULL DEFAULT now(),
  reserved_until  timestamptz NOT NULL,
  reason          text        NOT NULL,
  released_by     uuid,
  reclaimed_at    timestamptz,
  CONSTRAINT released_host_label_label_check CHECK (label = pg_catalog.lower(label) AND char_length(label) BETWEEN 1 AND 255),
  CONSTRAINT released_host_label_reason_check CHECK (reason IN ('RENAMED', 'WORKSPACE_DELETED')),
  CONSTRAINT released_host_label_window_check CHECK (reserved_until > released_at),
  CONSTRAINT released_host_label_reclaim_check CHECK (reclaimed_at IS NULL OR (reclaimed_at >= released_at AND reason = 'RENAMED'))
);
CREATE INDEX released_host_label_label_idx ON core.released_host_label (label, reserved_until DESC);
CREATE INDEX released_host_label_workspace_idx ON core.released_host_label (workspace_id);
ALTER TABLE core.released_host_label OWNER TO rab_secure_owner;
ALTER TABLE core.released_host_label ENABLE ROW LEVEL SECURITY;
CREATE POLICY released_host_label_tenant ON core.released_host_label AS PERMISSIVE FOR ALL TO PUBLIC
  USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
REVOKE ALL ON core.released_host_label FROM PUBLIC;
REVOKE ALL ON core.released_host_label FROM crewflow_app;
REVOKE ALL ON core.released_host_label FROM crewflow;

-- Evidence, not state: no DELETE by anyone; the only UPDATE is stamping reclaimed_at once.
CREATE FUNCTION core.released_host_label_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $g$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'core.released_host_label rows are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.reclaimed_at IS NOT NULL OR NEW.reclaimed_at IS NULL
     OR (NEW.id, NEW.label, NEW.workspace_id, NEW.organisation_id, NEW.released_at, NEW.reserved_until, NEW.reason, NEW.released_by)
        IS DISTINCT FROM
        (OLD.id, OLD.label, OLD.workspace_id, OLD.organisation_id, OLD.released_at, OLD.reserved_until, OLD.reason, OLD.released_by) THEN
    RAISE EXCEPTION 'core.released_host_label: only a single reclaimed_at stamp is allowed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$g$;
CREATE TRIGGER released_host_label_guard BEFORE UPDATE OR DELETE ON core.released_host_label
  FOR EACH ROW EXECUTE FUNCTION core.released_host_label_guard();
CREATE TRIGGER released_host_label_no_truncate BEFORE TRUNCATE ON core.released_host_label
  FOR EACH STATEMENT EXECUTE FUNCTION core.released_host_label_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Serialises every write that touches a label (both namespaces + quarantine), across transactions.
CREATE FUNCTION core.host_label_lock(p_a text, p_b text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $l$
BEGIN
  -- Fixed order (no deadlock between a rename a→b and a rename b→a).
  IF p_a IS NOT NULL AND (p_b IS NULL OR p_a <= p_b) THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('crewflow_host_label'), pg_catalog.hashtext(p_a));
  END IF;
  IF p_b IS NOT NULL AND p_b IS DISTINCT FROM p_a THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('crewflow_host_label'), pg_catalog.hashtext(p_b));
  END IF;
  IF p_a IS NOT NULL AND p_b IS NOT NULL AND p_a > p_b THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('crewflow_host_label'), pg_catalog.hashtext(p_a));
  END IF;
END;
$l$;

-- Workspace subdomain: BEFORE (refuse) ---------------------------------------------------------------------------
CREATE FUNCTION core.host_label_guard_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $gw$
DECLARE
  v   text;
  old text;
BEGIN
  -- Labels are case-insensitive (citext column, DNS semantics): a case-only change is not a rename, and the shape is
  -- checked on the lower-cased label (the canonical form stored in the claim registry and returned by the resolvers).
  IF TG_OP = 'UPDATE' AND pg_catalog.lower(NEW.subdomain::text) IS NOT DISTINCT FROM pg_catalog.lower(OLD.subdomain::text) THEN
    RETURN NEW;
  END IF;
  v := pg_catalog.lower(NEW.subdomain::text);
  old := CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.lower(OLD.subdomain::text) END;
  IF v IS NULL OR NOT core.host_label_shape_ok(v) THEN
    RAISE EXCEPTION 'workspace subdomain must be 3-63 letters, digits or inner hyphens'
      USING ERRCODE = '23514', CONSTRAINT = 'host_label_shape';
  END IF;
  PERFORM core.host_label_lock(v, old);
  IF core.host_label_is_reserved(v) THEN
    RAISE EXCEPTION 'workspace subdomain is reserved' USING ERRCODE = '23514', CONSTRAINT = 'host_label_reserved';
  END IF;
  IF EXISTS (SELECT 1 FROM core.organisation o WHERE o.slug OPERATOR(public.=) v::public.citext AND o.id <> NEW.organisation_id)
     OR EXISTS (SELECT 1 FROM core.released_host_label r
                 WHERE r.label = v AND r.reclaimed_at IS NULL AND r.reserved_until > now() AND r.workspace_id <> NEW.id) THEN
    RAISE EXCEPTION 'workspace subdomain is not available' USING ERRCODE = '23505', CONSTRAINT = 'host_label_unavailable';
  END IF;
  RETURN NEW;
END;
$gw$;

-- Workspace subdomain: AFTER (claim, quarantine, reclaim) --------------------------------------------------------
CREATE FUNCTION core.host_label_sync_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $sw$
DECLARE
  v_prev text := pg_catalog.current_setting('rab.organisation_id', true);
  v_org  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organisation_id ELSE NEW.organisation_id END;
  v_by   uuid := core.current_uid();
BEGIN
  IF TG_OP = 'UPDATE' AND pg_catalog.lower(NEW.subdomain::text) IS NOT DISTINCT FROM pg_catalog.lower(OLD.subdomain::text) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('rab.organisation_id', v_org::text, true);
  IF TG_OP = 'DELETE' THEN
    INSERT INTO core.released_host_label (label, workspace_id, organisation_id, released_at, reserved_until, reason, released_by)
    VALUES (pg_catalog.lower(OLD.subdomain::text), OLD.id, OLD.organisation_id, now(), now() + core.host_label_quarantine_interval(),
            'WORKSPACE_DELETED', v_by);
  ELSE
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM core.host_label_claim WHERE workspace_id = NEW.id;
      INSERT INTO core.released_host_label (label, workspace_id, organisation_id, released_at, reserved_until, reason, released_by)
      VALUES (pg_catalog.lower(OLD.subdomain::text), NEW.id, NEW.organisation_id, now(), now() + core.host_label_quarantine_interval(),
              'RENAMED', v_by);
    END IF;
    INSERT INTO core.host_label_claim (label, kind, organisation_id, workspace_id)
    VALUES (pg_catalog.lower(NEW.subdomain::text), 'WORKSPACE_SUBDOMAIN', NEW.organisation_id, NEW.id);
    UPDATE core.released_host_label SET reclaimed_at = now()
     WHERE label = pg_catalog.lower(NEW.subdomain::text) AND workspace_id = NEW.id AND reason = 'RENAMED'
       AND reclaimed_at IS NULL AND reserved_until > now();
  END IF;
  PERFORM pg_catalog.set_config('rab.organisation_id', coalesce(v_prev, ''), true);
  RETURN NULL;
END;
$sw$;

-- Organisation slug: BEFORE (refuse cross-organisation collisions only; slugs are not routable) -----------------
CREATE FUNCTION core.host_label_guard_organisation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $go$
DECLARE
  v   text;
  old text;
BEGIN
  IF TG_OP = 'UPDATE' AND pg_catalog.lower(NEW.slug::text) IS NOT DISTINCT FROM pg_catalog.lower(OLD.slug::text) THEN
    RETURN NEW;
  END IF;
  v := pg_catalog.lower(NEW.slug::text);
  old := CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.lower(OLD.slug::text) END;
  PERFORM core.host_label_lock(v, old);
  IF EXISTS (SELECT 1 FROM core.manager_workspace w WHERE w.subdomain OPERATOR(public.=) v::public.citext AND w.organisation_id <> NEW.id)
     OR EXISTS (SELECT 1 FROM core.released_host_label r
                 WHERE r.label = v AND r.reclaimed_at IS NULL AND r.reserved_until > now() AND r.organisation_id <> NEW.id) THEN
    RAISE EXCEPTION 'organisation slug is not available' USING ERRCODE = '23505', CONSTRAINT = 'host_label_unavailable';
  END IF;
  RETURN NEW;
END;
$go$;

CREATE FUNCTION core.host_label_sync_organisation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $so$
DECLARE
  v_prev text := pg_catalog.current_setting('rab.organisation_id', true);
BEGIN
  IF TG_OP = 'UPDATE' AND pg_catalog.lower(NEW.slug::text) IS NOT DISTINCT FROM pg_catalog.lower(OLD.slug::text) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('rab.organisation_id', NEW.id::text, true);
  DELETE FROM core.host_label_claim WHERE organisation_id = NEW.id AND kind = 'ORGANISATION_SLUG';
  INSERT INTO core.host_label_claim (label, kind, organisation_id, workspace_id)
  VALUES (pg_catalog.lower(NEW.slug::text), 'ORGANISATION_SLUG', NEW.id, NULL);
  PERFORM pg_catalog.set_config('rab.organisation_id', coalesce(v_prev, ''), true);
  RETURN NULL;
END;
$so$;

-- ---------------------------------------------------------------------------------------------------------------
-- Read side for lane H (runtime role).
CREATE FUNCTION core.resolve_workspace_by_host_label(p_label text)
RETURNS TABLE (workspace_id uuid, organisation_id uuid, status text, canonical_label text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rw$
DECLARE
  v     text := pg_catalog.lower(pg_catalog.btrim(p_label));
  v_id  uuid;
  v_org uuid;
  v_sub text;
BEGIN
  IF NOT coalesce(core.host_label_shape_ok(v), false) OR core.host_label_is_reserved(v) THEN
    RETURN;
  END IF;
  SELECT w.id, w.organisation_id, w.subdomain::text INTO v_id, v_org, v_sub
    FROM core.manager_workspace w
   WHERE w.subdomain OPERATOR(public.=) v::public.citext AND w.status = 'active' AND w.schema_status = 'READY';
  IF NOT FOUND OR pg_catalog.lower(v_sub) <> v THEN
    RETURN;
  END IF;
  IF NOT coalesce(core.workspace_schema_routable(v_id), false) OR coalesce(core.organisation_is_suspended(v_org), true) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_id, v_org, 'READY'::text, v;
END;
$rw$;

CREATE FUNCTION core.resolve_released_host_label(p_label text)
RETURNS TABLE (workspace_id uuid, organisation_id uuid, canonical_label text, reserved_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rr$
DECLARE
  v       text := pg_catalog.lower(pg_catalog.btrim(p_label));
  v_ws    uuid;
  v_until timestamptz;
  v_sub   text;
BEGIN
  IF NOT coalesce(core.host_label_shape_ok(v), false) THEN
    RETURN;
  END IF;
  SELECT r.workspace_id, r.reserved_until INTO v_ws, v_until
    FROM core.released_host_label r
   WHERE r.label = v AND r.reclaimed_at IS NULL AND r.reserved_until > now() AND r.reason = 'RENAMED'
   ORDER BY r.released_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT w.subdomain::text INTO v_sub FROM core.manager_workspace w WHERE w.id = v_ws;
  IF NOT FOUND OR pg_catalog.lower(v_sub) = v THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT h.workspace_id, h.organisation_id, h.canonical_label, v_until
      FROM core.resolve_workspace_by_host_label(v_sub) h
     WHERE h.workspace_id = v_ws;
END;
$rr$;

CREATE FUNCTION core.host_label_status(p_label text, p_exclude_workspace_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $st$
DECLARE
  v     text := pg_catalog.lower(pg_catalog.btrim(p_label));
  v_org uuid;
BEGIN
  IF NOT coalesce(core.host_label_shape_ok(v), false) THEN
    RETURN 'INVALID';
  END IF;
  IF core.host_label_is_reserved(v) THEN
    RETURN 'RESERVED';
  END IF;
  IF p_exclude_workspace_id IS NOT NULL THEN
    SELECT w.organisation_id INTO v_org FROM core.manager_workspace w WHERE w.id = p_exclude_workspace_id;
  END IF;
  v_org := coalesce(v_org, core.current_org());
  IF EXISTS (SELECT 1 FROM core.manager_workspace w WHERE w.subdomain OPERATOR(public.=) v::public.citext AND w.id IS DISTINCT FROM p_exclude_workspace_id)
     OR EXISTS (SELECT 1 FROM core.organisation o WHERE o.slug OPERATOR(public.=) v::public.citext AND o.id IS DISTINCT FROM v_org)
     OR EXISTS (SELECT 1 FROM core.released_host_label r
                 WHERE r.label = v AND r.reclaimed_at IS NULL AND r.reserved_until > now()
                   AND r.workspace_id IS DISTINCT FROM p_exclude_workspace_id) THEN
    RETURN 'TAKEN';
  END IF;
  RETURN 'AVAILABLE';
END;
$st$;

-- Existing availability functions: same signatures, owner, DEFINER, search_path and ACL (CREATE OR REPLACE); stricter.
CREATE OR REPLACE FUNCTION core.workspace_subdomain_taken(p_subdomain citext, p_exclude_workspace_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $wt$
BEGIN
  RETURN core.host_label_status(p_subdomain::text, p_exclude_workspace_id) IN ('TAKEN', 'RESERVED')
      OR EXISTS (SELECT 1 FROM core.manager_workspace
                  WHERE subdomain = p_subdomain AND (p_exclude_workspace_id IS NULL OR id <> p_exclude_workspace_id));
END;
$wt$;

CREATE OR REPLACE FUNCTION core.organisation_slug_taken(p_slug citext, p_exclude_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $ot$
DECLARE
  v text := pg_catalog.lower(p_slug::text);
BEGIN
  RETURN EXISTS (SELECT 1 FROM core.organisation WHERE slug = p_slug AND id <> p_exclude_org_id)
      OR EXISTS (SELECT 1 FROM core.manager_workspace w WHERE w.subdomain OPERATOR(public.=) p_slug AND w.organisation_id IS DISTINCT FROM p_exclude_org_id)
      OR EXISTS (SELECT 1 FROM core.released_host_label r
                  WHERE r.label = v AND r.reclaimed_at IS NULL AND r.reserved_until > now() AND r.organisation_id IS DISTINCT FROM p_exclude_org_id);
END;
$ot$;

-- Operator report of pre-existing problems (never renames anything).
CREATE FUNCTION core.host_label_collision_report()
RETURNS TABLE (label text, problem text, organisation_id uuid, workspace_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $cr$
  WITH labels AS (
    SELECT pg_catalog.lower(w.subdomain::text) AS label, 'WORKSPACE_SUBDOMAIN'::text AS kind, w.organisation_id, w.id AS workspace_id
      FROM core.manager_workspace w
    UNION ALL
    SELECT pg_catalog.lower(o.slug::text), 'ORGANISATION_SLUG', o.id, NULL::uuid FROM core.organisation o
  )
  SELECT l.label, 'CROSS_ORGANISATION_' || l.kind, l.organisation_id, l.workspace_id
    FROM labels l
   WHERE EXISTS (SELECT 1 FROM labels x WHERE x.label = l.label AND x.organisation_id <> l.organisation_id)
  UNION ALL
  SELECT l.label, 'RESERVED_' || l.kind, l.organisation_id, l.workspace_id FROM labels l WHERE core.host_label_is_reserved(l.label)
  UNION ALL
  SELECT l.label, 'INVALID_SHAPE_' || l.kind, l.organisation_id, l.workspace_id
    FROM labels l WHERE l.kind = 'WORKSPACE_SUBDOMAIN' AND NOT core.host_label_shape_ok(l.label)
  ORDER BY 1, 2
$cr$;

-- Ownership and privileges: every function owned by rab_secure_owner (NOLOGIN), PUBLIC revoked.
ALTER FUNCTION core.host_label_quarantine_interval() OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_shape_ok(text) OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_is_reserved(text) OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_lock(text, text) OWNER TO rab_secure_owner;
ALTER FUNCTION core.released_host_label_guard() OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_guard_workspace() OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_sync_workspace() OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_guard_organisation() OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_sync_organisation() OWNER TO rab_secure_owner;
ALTER FUNCTION core.resolve_workspace_by_host_label(text) OWNER TO rab_secure_owner;
ALTER FUNCTION core.resolve_released_host_label(text) OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_status(text, uuid) OWNER TO rab_secure_owner;
ALTER FUNCTION core.host_label_collision_report() OWNER TO rab_secure_owner;
REVOKE ALL ON FUNCTION core.host_label_quarantine_interval() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_shape_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_is_reserved(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_lock(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.released_host_label_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_guard_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_sync_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_guard_organisation() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_sync_organisation() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.resolve_workspace_by_host_label(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.resolve_released_host_label(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_status(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.host_label_collision_report() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_workspace_by_host_label(text) TO crewflow_app;
GRANT EXECUTE ON FUNCTION core.resolve_released_host_label(text) TO crewflow_app;
GRANT EXECUTE ON FUNCTION core.host_label_status(text, uuid) TO crewflow_app;
GRANT EXECUTE ON FUNCTION core.host_label_is_reserved(text) TO crewflow_app;
GRANT EXECUTE ON FUNCTION core.host_label_quarantine_interval() TO crewflow_app;
GRANT EXECUTE ON FUNCTION core.host_label_collision_report() TO crewflow;
`;

/** Triggers are attached AFTER the backfill so the backfill's own claim rows are written exactly once. */
export const HOST_LABEL_NAMESPACE_TRIGGERS_SQL = `
CREATE TRIGGER host_label_guard BEFORE INSERT OR UPDATE OF subdomain ON core.manager_workspace
  FOR EACH ROW EXECUTE FUNCTION core.host_label_guard_workspace();
CREATE TRIGGER host_label_sync AFTER INSERT OR UPDATE OF subdomain OR DELETE ON core.manager_workspace
  FOR EACH ROW EXECUTE FUNCTION core.host_label_sync_workspace();
CREATE TRIGGER host_label_guard BEFORE INSERT OR UPDATE OF slug ON core.organisation
  FOR EACH ROW EXECUTE FUNCTION core.host_label_guard_organisation();
CREATE TRIGGER host_label_sync AFTER INSERT OR UPDATE OF slug ON core.organisation
  FOR EACH ROW EXECUTE FUNCTION core.host_label_sync_organisation();
`;

export const HOST_LABEL_NAMESPACE_DOWN_SQL = `
DROP TRIGGER IF EXISTS host_label_sync ON core.organisation;
DROP TRIGGER IF EXISTS host_label_guard ON core.organisation;
DROP TRIGGER IF EXISTS host_label_sync ON core.manager_workspace;
DROP TRIGGER IF EXISTS host_label_guard ON core.manager_workspace;
CREATE OR REPLACE FUNCTION core.workspace_subdomain_taken(p_subdomain citext, p_exclude_workspace_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
        SELECT EXISTS(
          SELECT 1 FROM core.manager_workspace
          WHERE subdomain = p_subdomain AND (p_exclude_workspace_id IS NULL OR id != p_exclude_workspace_id)
        )
      $function$;
CREATE OR REPLACE FUNCTION core.organisation_slug_taken(p_slug citext, p_exclude_org_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
        SELECT EXISTS (SELECT 1 FROM core.organisation WHERE slug = p_slug AND id <> p_exclude_org_id);
      $function$;
DROP FUNCTION IF EXISTS core.host_label_collision_report();
DROP FUNCTION IF EXISTS core.host_label_status(text, uuid);
DROP FUNCTION IF EXISTS core.resolve_released_host_label(text);
DROP FUNCTION IF EXISTS core.resolve_workspace_by_host_label(text);
DROP FUNCTION IF EXISTS core.host_label_sync_organisation();
DROP FUNCTION IF EXISTS core.host_label_guard_organisation();
DROP FUNCTION IF EXISTS core.host_label_sync_workspace();
DROP FUNCTION IF EXISTS core.host_label_guard_workspace();
DROP FUNCTION IF EXISTS core.host_label_lock(text, text);
DROP TABLE IF EXISTS core.released_host_label;
DROP FUNCTION IF EXISTS core.released_host_label_guard();
DROP TABLE IF EXISTS core.host_label_claim;
DROP FUNCTION IF EXISTS core.host_label_is_reserved(text);
DROP FUNCTION IF EXISTS core.host_label_shape_ok(text);
DROP FUNCTION IF EXISTS core.host_label_quarantine_interval();
DROP TABLE IF EXISTS core.reserved_host_label;
`;

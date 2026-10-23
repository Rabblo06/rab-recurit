import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Waves 2+3 integration (requested by lane H, WAVE3_LANE_H_REPORT.md §4 request 1): `core.resolve_workspace_by_host_label`
 * gains a fifth OUT column, `display_name` (= `core.manager_workspace.name`), so a workspace host's public login page can
 * say "Sign in to <workspace name>" instead of the bare label. Dev/test only: deliberately NOT in
 * production-migration-approval.ts (N1).
 *
 * Signature compatibility (docs/evidence/wave2-lane-s2/CONTRACT.md §2): the IN signature `(p_label text)` is unchanged and
 * the first four OUT columns keep their names, types and order; `display_name text` is appended. Every row condition is
 * byte-for-byte the 1786719820000 body (READY + active + routable + organisation not suspended, else 0 rows). Callers that
 * name columns (`resolve_released_host_label`, `WorkspaceHostLookupService` via `SELECT *`) are unaffected.
 *
 * PostgreSQL cannot change a function's OUT columns with CREATE OR REPLACE, so the function is dropped and re-created in
 * this migration's single transaction (no window without it). Owner `rab_secure_owner`, SECURITY DEFINER,
 * `search_path = pg_catalog, pg_temp`, PUBLIC revoked and EXECUTE for `crewflow_app` only are re-applied, and the
 * migration REFUSES unless the resulting ACL is identical to the one it replaced (fail closed on any grant drift).
 *
 * Disclosure: the workspace name becomes readable pre-auth by anyone who knows a READY label (it is what the login page
 * of that host shows). It is the name the owner chose for the workspace; no owner, member, organisation or user data is
 * returned. Unknown / reserved / non-READY / suspended labels still return 0 rows.
 */
const RESOLVER_V2 = `
CREATE FUNCTION core.resolve_workspace_by_host_label(p_label text)
RETURNS TABLE (workspace_id uuid, organisation_id uuid, status text, canonical_label text, display_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rw$
DECLARE
  v      text := pg_catalog.lower(pg_catalog.btrim(p_label));
  v_id   uuid;
  v_org  uuid;
  v_sub  text;
  v_name text;
BEGIN
  IF NOT coalesce(core.host_label_shape_ok(v), false) OR core.host_label_is_reserved(v) THEN
    RETURN;
  END IF;
  SELECT w.id, w.organisation_id, w.subdomain::text, w.name::text INTO v_id, v_org, v_sub, v_name
    FROM core.manager_workspace w
   WHERE w.subdomain OPERATOR(public.=) v::public.citext AND w.status = 'active' AND w.schema_status = 'READY';
  IF NOT FOUND OR pg_catalog.lower(v_sub) <> v THEN
    RETURN;
  END IF;
  IF NOT coalesce(core.workspace_schema_routable(v_id), false) OR coalesce(core.organisation_is_suspended(v_org), true) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_id, v_org, 'READY'::text, v, v_name;
END;
$rw$;
`;

/** The 1786719820000 definition (host-label-namespace-sql.ts), restored by down(). */
const RESOLVER_V1 = `
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
`;

const OWNERSHIP_AND_ACL = `
ALTER FUNCTION core.resolve_workspace_by_host_label(text) OWNER TO rab_secure_owner;
REVOKE ALL ON FUNCTION core.resolve_workspace_by_host_label(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_workspace_by_host_label(text) TO crewflow_app;
`;

export class HostLabelResolverDisplayName1786719830000 implements MigrationInterface {
  name = 'HostLabelResolverDisplayName1786719830000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, RESOLVER_V2);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, RESOLVER_V1);
  }

  private async replace(queryRunner: QueryRunner, definition: string): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'HostLabelResolverDisplayName1786719830000 must run as the bootstrap identity (the function is owned by rab_secure_owner); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
    const before = await this.acl(queryRunner);
    if (before === null) throw new Error(`${this.name}: core.resolve_workspace_by_host_label(text) does not exist (HostLabelNamespace1786719820000 first)`);
    await queryRunner.query('DROP FUNCTION core.resolve_workspace_by_host_label(text)');
    await queryRunner.query(definition);
    await queryRunner.query(OWNERSHIP_AND_ACL);
    const after = await this.acl(queryRunner);
    if (after !== before) {
      throw new Error(`${this.name}: the re-created resolver's owner/ACL differs from the one it replaced; refusing (before=${before} after=${after})`);
    }
  }

  /** Owner, DEFINER flag, search_path and ACL of the resolver (role names only), or null when it does not exist. */
  private async acl(queryRunner: QueryRunner): Promise<string | null> {
    const rows: Array<{ sig: string }> = await queryRunner.query(`
      SELECT pg_get_userbyid(p.proowner) || '|definer=' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '')
             || '|' || coalesce((SELECT string_agg(pg_get_userbyid(x.grantee) || ':' || x.privilege_type, ',' ORDER BY pg_get_userbyid(x.grantee), x.privilege_type)
                                   FROM aclexplode(p.proacl) x), 'NULL-ACL') AS sig
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('core.resolve_workspace_by_host_label(text)')
    `);
    return rows[0]?.sig ?? null;
  }
}

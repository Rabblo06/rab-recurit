import { MigrationInterface, QueryRunner } from 'typeorm';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Settings → Members directory (new web UI), renumbered from the crewflow-ui checkout's 1786721130000. NOT owner-approved
 * yet: DRAFT PR, exact SQL in the PR body. Read-only; existing tenant policies and runtime table privileges are unchanged.
 *
 * Two SECURITY DEFINER functions (owner rab_secure_owner, `search_path = pg_catalog, pg_temp`, EXECUTE crewflow_app only):
 *   - core.workspace_member_directory(search, page, limit): the caller must hold an ACTIVE membership of the bound
 *     workspace (core.current_uid / current_org / current_workspace, never a parameter). Returns only userId, firstName,
 *     lastName, email of that workspace's active or suspended members. Page ≤ 1,000,000, limit ≤ 100, search ≤ 100 chars.
 *   - core.admin_member_directory(search, page, limit): an ACTIVE platform administrator only (42501 otherwise); every
 *     non-deleted user of every organisation plus pending organisation (CEO) and member invitations, with organisation
 *     name and status. No token, hash or credential column is read.
 * One SELECT policy, `workspace_directory_definer_select` on core.workspace_membership TO rab_secure_owner, scoped to the
 * bound organisation + workspace: without it the definer would only see the caller's own membership row (the existing
 * `*_self_select` policy). workspace_membership is already in the frozen R4 list (secure-owner-invariants.ts).
 *
 * down(): drops both functions and the policy.
 */
export class AdminMemberDirectory1786723400000 implements MigrationInterface {
  name = 'AdminMemberDirectory1786723400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
    await queryRunner.query(`
      CREATE POLICY workspace_directory_definer_select ON core.workspace_membership
        FOR SELECT TO rab_secure_owner
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      CREATE FUNCTION core.workspace_member_directory(p_search text, p_page integer, p_limit integer)
      RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $dir$
      DECLARE result jsonb;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM core.workspace_membership m JOIN core."user" u ON u.id = m.user_id
          WHERE m.user_id = core.current_uid() AND m.organisation_id = core.current_org()
            AND m.workspace_id = core.current_workspace() AND m.status = 'active'
            AND u.deleted_at IS NULL AND u.status = 'active') THEN
          RAISE EXCEPTION 'Active workspace membership required' USING ERRCODE = '42501';
        END IF;
        IF p_page IS NULL OR p_page < 1 OR p_page > 1000000 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
          OR pg_catalog.length(coalesce(p_search, '')) > 100 THEN
          RAISE EXCEPTION 'Invalid pagination' USING ERRCODE = '22023';
        END IF;
        WITH matches AS (
          SELECT u.id AS "userId", coalesce(u.first_name, '') AS "firstName", coalesce(u.last_name, '') AS "lastName", u.email::text AS email
          FROM core.workspace_membership m JOIN core."user" u ON u.id = m.user_id
          WHERE m.organisation_id = core.current_org() AND m.workspace_id = core.current_workspace()
            AND u.organisation_id = core.current_org() AND m.status IN ('active', 'suspended') AND u.deleted_at IS NULL
            AND pg_catalog.strpos(pg_catalog.lower(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '') || ' ' || u.email::text),
                                  pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')))) > 0
        ), page AS (
          SELECT * FROM matches ORDER BY pg_catalog.lower(email), "userId" LIMIT p_limit OFFSET ((p_page::bigint - 1) * p_limit)
        )
        SELECT pg_catalog.jsonb_build_object(
          'data', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY pg_catalog.lower(p.email), p."userId") FROM page p), '[]'::jsonb),
          'total', (SELECT count(*) FROM matches), 'page', p_page, 'limit', p_limit) INTO result;
        RETURN result;
      END; $dir$;
    `);
    await queryRunner.query(`
      CREATE FUNCTION core.admin_member_directory(p_search text, p_page integer, p_limit integer)
      RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
      DECLARE result jsonb;
      BEGIN
        IF core.current_uid() IS NULL OR NOT core.is_active_platform_admin(core.current_uid()) THEN
          RAISE EXCEPTION 'Active platform administrator required' USING ERRCODE = '42501';
        END IF;
        IF p_page IS NULL OR p_page < 1 OR p_page > 1000000 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
          OR pg_catalog.length(coalesce(p_search, '')) > 100 THEN
          RAISE EXCEPTION 'Invalid directory pagination' USING ERRCODE = '22023';
        END IF;
        WITH entries AS (
          SELECT 'user:' || u.id AS id, u.id AS "userId", 'user'::text AS kind,
                 coalesce(u.first_name, '') AS "firstName", coalesce(u.last_name, '') AS "lastName",
                 u.email::text AS email, u.status::text AS status, o.name AS "organisationName",
                 NULL::timestamptz AS "expiresAt"
          FROM core."user" u JOIN core.organisation o ON o.id = u.organisation_id
          WHERE u.deleted_at IS NULL
          UNION ALL
          SELECT 'organisation-invite:' || i.id, NULL::uuid, 'organisation-invitation', '', '', i.email::text,
                 CASE WHEN i.expires_at > pg_catalog.now() THEN 'invited' ELSE 'expired' END, NULL::text, i.expires_at
          FROM core.organisation_invitation i
          WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.superseded_at IS NULL
          UNION ALL
          SELECT 'member-invite:' || i.id, NULL::uuid, 'member-invitation', '', '', i.email::text,
                 CASE WHEN i.expires_at > pg_catalog.now() THEN 'invited' ELSE 'expired' END, o.name, i.expires_at
          FROM core.member_invitation i JOIN core.organisation o ON o.id = i.organisation_id
          WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.superseded_at IS NULL
        ), matches AS (
          SELECT * FROM entries
          WHERE pg_catalog.strpos(pg_catalog.lower("firstName" || ' ' || "lastName" || ' ' || email), pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')))) > 0
        ), page AS (
          SELECT * FROM matches ORDER BY pg_catalog.lower(email), id LIMIT p_limit OFFSET ((p_page::bigint - 1) * p_limit)
        )
        SELECT pg_catalog.jsonb_build_object(
          'data', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY pg_catalog.lower(p.email), p.id) FROM page p), '[]'::jsonb),
          'total', (SELECT count(*) FROM matches), 'page', p_page, 'limit', p_limit) INTO result;
        RETURN result;
      END; $fn$;
    `);
    for (const fn of ['core.workspace_member_directory(text, integer, integer)', 'core.admin_member_directory(text, integer, integer)']) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await queryRunner.query(`ALTER FUNCTION ${fn} OWNER TO rab_secure_owner`);
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM crewflow`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO crewflow_app`);
    }
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
    await queryRunner.query('DROP FUNCTION IF EXISTS core.workspace_member_directory(text, integer, integer)');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.admin_member_directory(text, integer, integer)');
    await queryRunner.query('DROP POLICY IF EXISTS workspace_directory_definer_select ON core.workspace_membership');
  }
}

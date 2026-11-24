import { MigrationInterface, QueryRunner } from 'typeorm';

/** Read-only directory; existing tenant policies and runtime table privileges stay unchanged. */
export class AdminMemberDirectory1786721130000 implements MigrationInterface {
  name = 'AdminMemberDirectory1786721130000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE POLICY workspace_directory_definer_select ON core.workspace_membership
        FOR SELECT TO rab_secure_owner
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
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
          OR length(coalesce(p_search,'')) > 100 THEN
          RAISE EXCEPTION 'Invalid pagination' USING ERRCODE = '22023';
        END IF;
        WITH matches AS (
          SELECT u.id AS "userId", coalesce(u.first_name,'') AS "firstName", coalesce(u.last_name,'') AS "lastName", u.email::text AS email
          FROM core.workspace_membership m JOIN core."user" u ON u.id = m.user_id
          WHERE m.organisation_id = core.current_org() AND m.workspace_id = core.current_workspace()
            AND u.organisation_id = core.current_org() AND m.status IN ('active','suspended') AND u.deleted_at IS NULL
            AND strpos(lower(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'') || ' ' || u.email::text), lower(btrim(coalesce(p_search,'')))) > 0
        ), page AS (SELECT * FROM matches ORDER BY lower(email), "userId" LIMIT p_limit OFFSET ((p_page::bigint-1)*p_limit))
        SELECT jsonb_build_object('data',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY lower(p.email),p."userId") FROM page p),'[]'::jsonb),
          'total',(SELECT count(*) FROM matches),'page',p_page,'limit',p_limit) INTO result;
        RETURN result;
      END; $dir$;
      ALTER FUNCTION core.workspace_member_directory(text,integer,integer) OWNER TO rab_secure_owner;
      REVOKE ALL ON FUNCTION core.workspace_member_directory(text,integer,integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION core.workspace_member_directory(text,integer,integer) TO crewflow_app;
      CREATE FUNCTION core.admin_member_directory(p_search text, p_page integer, p_limit integer)
      RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp AS $fn$
      DECLARE result jsonb;
      BEGIN
        IF core.current_uid() IS NULL OR NOT core.is_active_platform_admin(core.current_uid()) THEN
          RAISE EXCEPTION 'Active platform administrator required' USING ERRCODE = '42501';
        END IF;
        IF p_page IS NULL OR p_page < 1 OR p_page > 1000000 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
           OR length(coalesce(p_search, '')) > 100 THEN
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
                 CASE WHEN i.expires_at > now() THEN 'invited' ELSE 'expired' END, NULL::text, i.expires_at
          FROM core.organisation_invitation i
          WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.superseded_at IS NULL
          UNION ALL
          SELECT 'member-invite:' || i.id, NULL::uuid, 'member-invitation', '', '', i.email::text,
                 CASE WHEN i.expires_at > now() THEN 'invited' ELSE 'expired' END, o.name, i.expires_at
          FROM core.member_invitation i JOIN core.organisation o ON o.id = i.organisation_id
          WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.superseded_at IS NULL
        ), matches AS (
          SELECT * FROM entries WHERE strpos(lower("firstName" || ' ' || "lastName" || ' ' || email), lower(btrim(coalesce(p_search, '')))) > 0
        ), page AS (
          SELECT * FROM matches ORDER BY lower(email), id LIMIT p_limit OFFSET ((p_page::bigint - 1) * p_limit)
        ) SELECT jsonb_build_object('data', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY lower(p.email), p.id) FROM page p), '[]'::jsonb),
          'total', (SELECT count(*) FROM matches), 'page', p_page, 'limit', p_limit) INTO result;
        RETURN result;
      END; $fn$;
      ALTER FUNCTION core.admin_member_directory(text,integer,integer) OWNER TO rab_secure_owner;
      REVOKE ALL ON FUNCTION core.admin_member_directory(text,integer,integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION core.admin_member_directory(text,integer,integer) TO crewflow_app;
    `);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION IF EXISTS core.workspace_member_directory(text,integer,integer)');
    await runner.query('DROP POLICY IF EXISTS workspace_directory_definer_select ON core.workspace_membership');
    await runner.query('DROP FUNCTION IF EXISTS core.admin_member_directory(text,integer,integer)');
  }
}

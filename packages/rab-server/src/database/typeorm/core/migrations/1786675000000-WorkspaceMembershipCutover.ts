import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, items 5–7 — step A: membership SHAPE and the protected resolvers.
 *
 * Approved semantics: core.workspace_membership means USER → WORKSPACE. Application access is decided
 * separately by applicationAllowed(). So the application_target column is dropped and one user has at most
 * ONE active workspace (partial unique index on user_id). Duplicate rows per application target collapse
 * into one row per (user, workspace).
 *
 * This migration does NOT enable FORCE RLS and does NOT change the existing org-scoped policy. FORCE is a
 * later migration (WorkspaceMembershipForceRls) that lands only after every caller uses the new resolvers,
 * so the application never depends on a half-migrated membership table.
 *
 * Resolvers (all SECURITY DEFINER, owner rab_owner, fixed search_path, EXECUTE only for rab_app):
 * - core.resolve_membership_for_user(user_id): VERIFIED user → workspace. For login, refresh, reset,
 *   activation, forgot-password and the inspect target. The caller must have verified the user first.
 * - core.resolve_membership_for_session(sid): protected requests. Derives the user and organisation from a
 *   live refresh-token FAMILY (not revoked, absolute deadline in the future, DB clock), then resolves the
 *   workspace. Accepts no user, organisation or workspace input.
 * - core.suspend_workspace_membership(user_id) / core.reinstate_workspace_membership(user_id): lifecycle
 *   status changes for ONE user in the caller's bound organisation. No status text is accepted.
 *
 * Context binding: each resolver binds rab.organisation_id and rab.user_id transaction-locally (needed under
 * FORCE later), and restores the caller's previous values before returning. Ambiguity (more than one active
 * membership, or more than one live family identity) RAISES; there is no LIMIT 1 anywhere.
 */
export class WorkspaceMembershipCutover1786675000000 implements MigrationInterface {
  name = 'WorkspaceMembershipCutover1786675000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Collapse rows that the USER → WORKSPACE model treats as duplicates. Refuse a user with more than one
    //    ACTIVE workspace: that is the ambiguity the owner said to stop on, never silently repaired.
    await queryRunner.query(`
      DO $$
      DECLARE v_ambiguous bigint;
      BEGIN
        SELECT count(*) INTO v_ambiguous FROM (
          SELECT user_id FROM core.workspace_membership WHERE status = 'active'
          GROUP BY user_id HAVING count(DISTINCT workspace_id) > 1
        ) a;
        IF v_ambiguous > 0 THEN
          RAISE EXCEPTION 'membership cutover stopped: % user(s) have more than one ACTIVE workspace', v_ambiguous
            USING ERRCODE = 'P0001';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DELETE FROM core.workspace_membership m
       USING (
         SELECT id, row_number() OVER (
           PARTITION BY user_id, workspace_id
           ORDER BY (status = 'active') DESC, created_at, id
         ) AS rn
           FROM core.workspace_membership
       ) ranked
       WHERE m.id = ranked.id AND ranked.rn > 1;
    `);

    // 2. Retire the per-target invariant and the target column.
    await queryRunner.query(`DROP INDEX IF EXISTS core.workspace_membership_one_active_per_target;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership DROP CONSTRAINT IF EXISTS workspace_membership_user_workspace_target_key;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership DROP COLUMN application_target;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership ADD COLUMN source text NOT NULL DEFAULT 'write_path'
      CHECK (source IN ('write_path', 'backfill'));`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership ADD CONSTRAINT workspace_membership_user_workspace_key UNIQUE (user_id, workspace_id);`);
    // The product invariant: at most ONE ACTIVE operational workspace per user. Enforced by the database for
    // every writer, including the backfill and any future code path.
    await queryRunner.query(`
      CREATE UNIQUE INDEX workspace_membership_one_active_per_user
        ON core.workspace_membership (user_id) WHERE status = 'active';
    `);

    // 3. The old per-target resolver has no callers and encodes the wrong semantics. Remove it.
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.resolve_workspace_membership(uuid, text);`);

    // 4. Verified-user resolver.
    await queryRunner.query(`
      CREATE FUNCTION core.resolve_membership_for_user(p_user_id uuid)
      RETURNS TABLE (organisation_id uuid, workspace_id uuid)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org     uuid;
        v_active  bigint;
        v_prev_org text := current_setting('rab.organisation_id', true);
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        IF p_user_id IS NULL THEN
          RAISE EXCEPTION 'user id is required' USING ERRCODE = '22004';
        END IF;
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = p_user_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        PERFORM set_config('rab.user_id', p_user_id::text, true);
        SELECT count(*) INTO v_active FROM core.workspace_membership m WHERE m.user_id = p_user_id AND m.status = 'active';
        IF v_active > 1 THEN
          RAISE EXCEPTION 'ambiguous workspace membership' USING ERRCODE = '55000';
        END IF;
        RETURN QUERY
          SELECT v_org,
                 (SELECT m.workspace_id
                    FROM core.workspace_membership m
                    JOIN core.manager_workspace w ON w.id = m.workspace_id AND w.organisation_id = m.organisation_id
                   WHERE m.user_id = p_user_id AND m.status = 'active' AND w.status = 'active');
        PERFORM set_config('rab.organisation_id', coalesce(v_prev_org, ''), true);
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);

    // 5. Protected-session resolver: sid → live family → user + organisation → membership → workspace.
    await queryRunner.query(`
      CREATE FUNCTION core.resolve_membership_for_session(p_sid uuid)
      RETURNS TABLE (user_id uuid, organisation_id uuid, workspace_id uuid)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_families bigint;
        v_user     uuid;
        v_org      uuid;
        v_active   bigint;
        v_prev_org text := current_setting('rab.organisation_id', true);
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        IF p_sid IS NULL THEN
          RETURN;
        END IF;
        SELECT count(*) INTO v_families FROM (
          SELECT DISTINCT rt.user_id, rt.organisation_id
            FROM core.refresh_token rt
           WHERE rt.family_id = p_sid AND rt.revoked_at IS NULL AND rt.family_expires_at > now()
        ) live;
        IF v_families = 0 THEN
          RETURN;
        END IF;
        IF v_families > 1 THEN
          RAISE EXCEPTION 'ambiguous session family' USING ERRCODE = '55000';
        END IF;
        SELECT DISTINCT rt.user_id, rt.organisation_id INTO v_user, v_org
          FROM core.refresh_token rt
         WHERE rt.family_id = p_sid AND rt.revoked_at IS NULL AND rt.family_expires_at > now();
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        PERFORM set_config('rab.user_id', v_user::text, true);
        SELECT count(*) INTO v_active FROM core.workspace_membership m WHERE m.user_id = v_user AND m.status = 'active';
        IF v_active > 1 THEN
          RAISE EXCEPTION 'ambiguous workspace membership' USING ERRCODE = '55000';
        END IF;
        RETURN QUERY
          SELECT v_user, v_org,
                 (SELECT m.workspace_id
                    FROM core.workspace_membership m
                    JOIN core.manager_workspace w ON w.id = m.workspace_id AND w.organisation_id = m.organisation_id
                   WHERE m.user_id = v_user AND m.status = 'active' AND w.status = 'active');
        PERFORM set_config('rab.organisation_id', coalesce(v_prev_org, ''), true);
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);

    // 6. Lifecycle status changes. The organisation must already be bound by the caller and must equal the
    //    target user's organisation. Only the fixed transitions below exist: no free-text status.
    await queryRunner.query(`
      CREATE FUNCTION core.suspend_workspace_membership(p_user_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org      uuid;
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = p_user_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        IF v_org IS DISTINCT FROM core.current_org() THEN
          RAISE EXCEPTION 'user is outside the bound organisation' USING ERRCODE = '42501';
        END IF;
        PERFORM set_config('rab.user_id', p_user_id::text, true);
        UPDATE core.workspace_membership SET status = 'suspended', updated_at = now()
         WHERE user_id = p_user_id AND status = 'active';
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE FUNCTION core.reinstate_workspace_membership(p_user_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org      uuid;
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = p_user_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        IF v_org IS DISTINCT FROM core.current_org() THEN
          RAISE EXCEPTION 'user is outside the bound organisation' USING ERRCODE = '42501';
        END IF;
        PERFORM set_config('rab.user_id', p_user_id::text, true);
        UPDATE core.workspace_membership SET status = 'active', updated_at = now()
         WHERE user_id = p_user_id AND status = 'suspended';
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
      END;
      $$;
    `);

    // 7. Privileges: nothing for PUBLIC; the runtime role only. The owner is never granted to a runtime path.
    for (const fn of [
      'core.resolve_membership_for_user(uuid)',
      'core.resolve_membership_for_session(uuid)',
      'core.suspend_workspace_membership(uuid)',
      'core.reinstate_workspace_membership(uuid)',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO rab_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.reinstate_workspace_membership(uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.suspend_workspace_membership(uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.resolve_membership_for_session(uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.resolve_membership_for_user(uuid);`);
    // The per-target resolver is restored with the table shape so a revert is a complete inverse.
    await queryRunner.query(`
      CREATE FUNCTION core.resolve_workspace_membership(p_user_id uuid, p_application_target text)
      RETURNS TABLE (organisation_id uuid, workspace_id uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_catalog AS $$
      BEGIN
        IF p_user_id IS NULL OR p_application_target IS NULL THEN
          RAISE EXCEPTION 'user id and application target are required' USING ERRCODE = '22004';
        END IF;
        RETURN QUERY
          SELECT m.organisation_id, m.workspace_id
            FROM core.workspace_membership m
            JOIN core.manager_workspace w ON w.id = m.workspace_id AND w.organisation_id = m.organisation_id
           WHERE m.user_id = p_user_id AND m.application_target = p_application_target
             AND m.status = 'active' AND w.status = 'active';
      END;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.resolve_workspace_membership(uuid, text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.resolve_workspace_membership(uuid, text) TO rab_app;`);

    await queryRunner.query(`DROP INDEX IF EXISTS core.workspace_membership_one_active_per_user;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership DROP CONSTRAINT IF EXISTS workspace_membership_user_workspace_key;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership DROP COLUMN IF EXISTS source;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership ADD COLUMN application_target text NOT NULL DEFAULT 'manager_web'
      CHECK (application_target IN ('manager_web', 'venue_manager_app', 'staff_app'));`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership ALTER COLUMN application_target DROP DEFAULT;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership ADD CONSTRAINT workspace_membership_user_workspace_target_key UNIQUE (user_id, workspace_id, application_target);`);
    await queryRunner.query(`CREATE UNIQUE INDEX workspace_membership_one_active_per_target ON core.workspace_membership (user_id, application_target) WHERE status = 'active';`);
  }
}

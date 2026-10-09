import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program): the first-class server-side session
 * aggregate. `core.user_session` is CORE (never a Workspace Schema V1 table — session
 * management is a core identity concern, must keep working even while a workspace is
 * CREATING/FAILED/non-routable, see HWS-RUNTIME-CUTOVER.md).
 *
 * Canonical identity, enforced by convention (application layer), not a database constraint
 * that could cross tables: `core.user_session.id` = `core.refresh_token.family_id` = the
 * JWT's `sid` claim. One row per logical session; the session survives every refresh
 * rotation (`RefreshTokenService.issue()` creates this row exactly once, only for a genuinely
 * NEW family — see that file's own doc comment for the `familyExpiresAt` presence/absence
 * signal this relies on, not `familyId` presence, since `AuthService.login()` always
 * pre-generates and passes an explicit `familyId` even for a brand-new session).
 *
 * `workspace_id` is a SNAPSHOT/CONTEXT AID ONLY — never authorization authority. Live
 * workspace membership (`core.workspace_membership`, resolved via `WorkspaceResolverService`)
 * remains the sole authority for "what workspace is this request in," exactly as today;
 * nothing added by this migration changes that. This column exists purely so a device/session
 * list can show "this session's workspace at creation time" without a second lookup.
 *
 * No FK from `core.refresh_token.family_id` to this table's `id` yet — see P1B's own
 * backfill tooling (`command/user-session-backfill.command.ts`) for why that's deliberately
 * deferred until every existing family has a matching row (P1B item 21: "Do not introduce a
 * hard FK before backfill if existing rows would violate it").
 */
export class UserSession1786678000000 implements MigrationInterface {
  name = 'UserSession1786678000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.user_session (
        id                  uuid PRIMARY KEY,
        organisation_id     uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id             uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        -- Snapshot only — see this migration's own doc comment. ON DELETE SET NULL: a
        -- workspace being removed must never cascade-delete session history.
        workspace_id        uuid REFERENCES core.manager_workspace(id) ON DELETE SET NULL,
        application_target  text NOT NULL CHECK (application_target IN ('manager_web', 'venue_manager_app', 'staff_app')),
        auth_provider        text,
        device_id           text,
        device_name         text,
        device_type         text,
        platform            text,
        user_agent          text,
        ip_address          inet,
        created_at          timestamptz NOT NULL DEFAULT now(),
        last_seen_at        timestamptz NOT NULL DEFAULT now(),
        -- The same absolute ceiling session-policy.ts already computes for refresh_token.family_expires_at —
        -- copied at creation, never recomputed, so it can never silently diverge from the token family's own deadline.
        absolute_expires_at timestamptz NOT NULL,
        -- P2 idle-timeout enforcement is NOT implemented in P1B (item 8's own instruction). This column exists so
        -- the schema doesn't need a second migration later, but nothing reads or enforces it yet.
        idle_expires_at     timestamptz,
        revoked_at          timestamptz,
        revoked_reason      text,
        mfa_verified_at     timestamptz,
        -- P1B scope only: increments on this session's OWN revocation/security-relevant mutation. The full
        -- cross-domain version-vector (permission/workspace/platform-admin versions) is P1D — not built here.
        security_version    bigint NOT NULL DEFAULT 1,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT user_session_security_version_check CHECK (security_version > 0),
        CONSTRAINT user_session_created_before_expiry_check CHECK (created_at <= absolute_expires_at),
        CONSTRAINT user_session_idle_before_absolute_check CHECK (idle_expires_at IS NULL OR idle_expires_at <= absolute_expires_at),
        -- A reason without a revocation timestamp is a contradiction (an active session has no "why it ended").
        CONSTRAINT user_session_revoked_reason_check CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL),
        CONSTRAINT user_session_device_id_length_check CHECK (device_id IS NULL OR char_length(device_id) <= 100),
        CONSTRAINT user_session_revoked_reason_length_check CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 200)
      );
    `);
    await queryRunner.query(`CREATE INDEX user_session_user_idx ON core.user_session (user_id, revoked_at);`);
    await queryRunner.query(`CREATE INDEX user_session_org_idx ON core.user_session (organisation_id);`);
    // Supports SessionValidityService's bounded last_seen_at bump (conditional UPDATE keyed on id, revoked_at IS NULL).
    await queryRunner.query(`CREATE INDEX user_session_active_idx ON core.user_session (id) WHERE revoked_at IS NULL;`);

    await queryRunner.query(`ALTER TABLE core.user_session ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.user_session FORCE ROW LEVEL SECURITY;`);
    // Self-only: an authenticated caller may see/mutate only their OWN sessions, within their own
    // organisation. No admin/CEO cross-user carve-out — P1B's own brief only requires self-only
    // visibility; a broader "admin can see any user's sessions" view is not requested and not added.
    await queryRunner.query(`
      CREATE POLICY user_session_self ON core.user_session
        USING (organisation_id = core.current_org() AND user_id = core.current_uid())
        WITH CHECK (organisation_id = core.current_org() AND user_id = core.current_uid());
    `);
    // No DELETE — a revoked session is a permanent record (revoked_at/revoked_reason), never removed,
    // matching audit_log's own append-only spirit and core.hws_backfill_checkpoint's precedent.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.user_session TO rab_app;`);

    // P1B backfill verification: `user_session_self`'s FORCE RLS means the policy binds EVERY
    // execution context, including a SECURITY DEFINER function's — FORCE is specifically defined
    // to apply row security to the table owner too, and SECURITY DEFINER only changes which role
    // a function executes AS (the owner), not whether FORCE still applies to that role. A plain
    // unbound LEFT JOIN inside such a function therefore sees ZERO user_session rows, exactly
    // like any other unbound connection (confirmed directly — a first version of this function
    // used a plain join and always reported `backfilled_families = 0` regardless of real state).
    // The fix mirrors `UserSessionBackfillService`'s own per-family WRITE technique, applied to
    // this cross-organisation READ: loop over every distinct (organisation, user) pair that owns
    // at least one refresh_token row, bind `rab.organisation_id`/`rab.user_id` to THAT pair before
    // counting ITS OWN families — never a bypass, the policy is honestly satisfied for every
    // group it's asked about, one group at a time. Restores the caller's previous GUC values
    // before returning, the same courtesy `resolve_membership_for_session` already extends.
    await queryRunner.query(`
      CREATE FUNCTION core.count_user_session_backfill_status()
      RETURNS TABLE (total_families bigint, backfilled_families bigint)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = core, pg_catalog
      AS $$
      DECLARE
        rec RECORD;
        v_total bigint := 0;
        v_backfilled bigint := 0;
        v_user_total bigint;
        v_user_backfilled bigint;
        v_prev_org text := current_setting('rab.organisation_id', true);
        v_prev_uid text := current_setting('rab.user_id', true);
      BEGIN
        FOR rec IN SELECT DISTINCT organisation_id, user_id FROM core.refresh_token LOOP
          PERFORM set_config('rab.organisation_id', rec.organisation_id::text, true);
          PERFORM set_config('rab.user_id', rec.user_id::text, true);
          SELECT count(DISTINCT rt.family_id),
                 count(DISTINCT rt.family_id) FILTER (WHERE us.id IS NOT NULL)
            INTO v_user_total, v_user_backfilled
            FROM core.refresh_token rt
            LEFT JOIN core.user_session us ON us.id = rt.family_id
           WHERE rt.organisation_id = rec.organisation_id AND rt.user_id = rec.user_id;
          v_total := v_total + v_user_total;
          v_backfilled := v_backfilled + v_user_backfilled;
        END LOOP;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev_org, ''), true);
        PERFORM set_config('rab.user_id', coalesce(v_prev_uid, ''), true);
        total_families := v_total;
        backfilled_families := v_backfilled;
        RETURN NEXT;
      END;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.count_user_session_backfill_status() FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.count_user_session_backfill_status() TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.count_user_session_backfill_status();`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_session;`);
  }
}

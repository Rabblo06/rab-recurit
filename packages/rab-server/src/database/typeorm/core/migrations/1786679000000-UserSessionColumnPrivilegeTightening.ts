import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1B.1 (finalization checkpoint — item 1: "narrow user_session database write authority").
 *
 * Two independent findings from auditing every INSERT/UPDATE of `core.user_session` against the
 * owner-supplied classification ("initial controlled session creation", "last_seen_at",
 * "revoked_at", "revoked_reason", "security_version" are the only expected runtime mutations):
 *
 * FINDING 1 — a real, confirmed-by-source-reading bug, not yet caught by any existing test:
 * `RefreshTokenService.revokeAllForUser` (called by account suspension, admin-triggered password
 * reset, and account deletion — ALWAYS run under the ADMIN/ACTOR's own tenant context, never the
 * TARGET user's) issues `UPDATE core.user_session SET revoked_at = ... WHERE user_id = $1` where
 * `$1` is the TARGET's id, while the bound GUCs are the ACTOR's own. `user_session_self`'s single
 * policy required `user_id = core.current_uid()` for BOTH read and write — so this UPDATE matched
 * zero rows for every admin-driven cross-user revocation: the `refresh_token` row got revoked
 * (that table's own RLS is organisation-scoped, not user-scoped — see
 * `RefreshTokenAdminRevocationRlsFix1786669200000`'s own doc comment for the identical bug it
 * already fixed there), but the `core.user_session` row stayed ACTIVE — exactly the
 * contradictory "UserSession active, RefreshToken revoked" state the P1B brief named as forbidden.
 * `account-suspension`/`admin-password-reset`/`account-deletion` integration specs did not catch
 * this because they only ever asserted against `refresh_token`'s own revocation, never against
 * `user_session` (which didn't exist when most of those specs were last touched).
 *
 * Fix: the SAME split this codebase already reviewed and shipped once for `refresh_token`
 * (`RefreshTokenAdminRevocationRlsFix1786669200000` + the SELECT-precondition correction in
 * `SelectPreconditionForWritesRlsFix1786669300000` — Postgres requires a row to satisfy the
 * table's SELECT policy to be visible to UPDATE at all, regardless of how permissive the
 * UPDATE-specific policy is, so SELECT must ALSO widen to organisation-scope, not stay
 * self-scoped, or the UPDATE fix alone silently still matches nothing). `core.user_session`
 * carries device/IP/session metadata, not raw credentials — the same "global identity ≠ globally
 * readable, not a real confidentiality boundary RLS alone was ever enforcing" reasoning that
 * migration applied to `refresh_token`'s own token-hash-bearing rows applies at least as well
 * here. The one actual self-scoping guarantee this table promises ("self-only device/session
 * list", P1B item 15) is already enforced at the APPLICATION layer —
 * `ProfileService.listSessions()`'s own explicit `WHERE us.user_id = :userId` — exactly the
 * "org-scope query" layer CLAUDE.md's 5-layer model expects to do this job, not RLS alone.
 * INSERT stays self-scoped (tighter than necessary, costs nothing — `RefreshTokenService.issue()`
 * only ever creates a session for the currently-authenticating identity, never anyone else's).
 *
 * FINDING 2 — "protects ROW ownership but not COLUMN authority": the original migration granted
 * blanket `INSERT, UPDATE` on the whole table to `rab_app`. Nothing in `rab-server/src` ever
 * writes `workspace_id`/`application_target`/`absolute_expires_at`/`mfa_verified_at`/
 * `idle_expires_at`/`auth_provider`/`device_name`/`device_type`/`platform`/`updated_at` after
 * creation (confirmed by reading every call site, not assumed) — a blanket grant leaves rab_app
 * with generic database authority to mutate session identity/expiry/authorization columns that
 * no legitimate code path exercises today, exactly the gap item 1 asks to close. Fix: replace the
 * blanket grant with an explicit INSERT column list (matching `issue()`'s own INSERT exactly) and
 * an UPDATE column list restricted to `last_seen_at, revoked_at, revoked_reason,
 * security_version` — the only four columns any current code path ever updates.
 *
 * Column-level privilege alone still can't stop an "arbitrary" value for a granted column (Postgres
 * privileges gate WHICH columns appear in a SET list, never WHAT value is assigned) — exactly the
 * gap for `security_version`, which the brief calls out by name ("cannot arbitrarily
 * increment/decrement"). A `SECURITY DEFINER` wrapper function was considered and rejected here:
 * it would need to either stay self-scoped (reintroducing finding 1's own bug for the admin bulk
 * path) or re-implement the GUC-rebind-per-target dance `count_user_session_backfill_status()`
 * already needed once in this same migration set — more moving parts than the actual invariant
 * requires. A `BEFORE UPDATE` trigger is the smaller, stronger tool: it runs for every UPDATE
 * regardless of role (unlike RLS, a trigger is never bypassed by table ownership), sees both
 * `OLD`/`NEW`, and can therefore enforce the real invariant directly — `security_version` may
 * only move by exactly `+1`, and only alongside a genuine `revoked_at` NULL→NOT NULL transition —
 * plus revocation immutability (`revoked_at`/`revoked_reason`, once set, can never change again —
 * the DB-level version of the app's own `WHERE revoked_at IS NULL` CAS guard, now enforced even if
 * a future code path forgets it) and a blanket guard on every identity/expiry column regardless of
 * whether a future migration ever grants column access to it.
 *
 * Also revokes the one other over-broad grant this audit surfaced: `EXECUTE ON FUNCTION
 * core.count_user_session_backfill_status()` was granted to `rab_app` in the original migration,
 * but `UserSessionBackfillService.verify()` — its only caller — always runs through the owner
 * (`DATABASE_URL_UNPOOLED`) connection from the CLI command, never `rab_app`; confirmed by reading
 * every call site, not assumed. "Remember P0 found over-broad lifecycle function grants. Do not
 * repeat that pattern" (P1B.1's own instruction) — so this grant is revoked, not left in place on
 * the theory it might be harmless.
 */
export class UserSessionColumnPrivilegeTightening1786679000000 implements MigrationInterface {
  name = 'UserSessionColumnPrivilegeTightening1786679000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON core.user_session FROM rab_app;`);
    await queryRunner.query(`DROP POLICY user_session_self ON core.user_session;`);

    await queryRunner.query(`
      CREATE POLICY user_session_select ON core.user_session
        FOR SELECT USING (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY user_session_insert ON core.user_session
        FOR INSERT WITH CHECK (organisation_id = core.current_org() AND user_id = core.current_uid());
    `);
    await queryRunner.query(`
      CREATE POLICY user_session_update ON core.user_session
        FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`GRANT SELECT ON core.user_session TO rab_app;`);
    await queryRunner.query(`
      GRANT INSERT (
        id, organisation_id, user_id, workspace_id, application_target,
        device_id, user_agent, ip_address, created_at, last_seen_at, absolute_expires_at
      ) ON core.user_session TO rab_app;
    `);
    await queryRunner.query(`
      GRANT UPDATE (last_seen_at, revoked_at, revoked_reason, security_version) ON core.user_session TO rab_app;
    `);

    await queryRunner.query(`
      CREATE FUNCTION core.enforce_user_session_mutation_invariants() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = core, pg_catalog
      AS $$
      BEGIN
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
          RAISE EXCEPTION 'user_session: revoked_at is immutable once set (session %)', OLD.id;
        END IF;
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason THEN
          RAISE EXCEPTION 'user_session: revoked_reason is immutable once set (session %)', OLD.id;
        END IF;
        IF NEW.security_version IS DISTINCT FROM OLD.security_version THEN
          IF NEW.security_version IS DISTINCT FROM OLD.security_version + 1 THEN
            RAISE EXCEPTION 'user_session: security_version may only move by exactly +1 per update (session %)', OLD.id;
          END IF;
          IF NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
            RAISE EXCEPTION 'user_session: security_version may only change alongside a revocation transition (session %)', OLD.id;
          END IF;
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.application_target IS DISTINCT FROM OLD.application_target
           OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION 'user_session: this column is immutable after creation (session %)', OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER user_session_mutation_guard
        BEFORE UPDATE ON core.user_session
        FOR EACH ROW EXECUTE FUNCTION core.enforce_user_session_mutation_invariants();
    `);

    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION core.count_user_session_backfill_status() FROM rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.count_user_session_backfill_status() TO rab_app;`);

    await queryRunner.query(`DROP TRIGGER user_session_mutation_guard ON core.user_session;`);
    await queryRunner.query(`DROP FUNCTION core.enforce_user_session_mutation_invariants();`);

    await queryRunner.query(`REVOKE ALL ON core.user_session FROM rab_app;`);
    await queryRunner.query(`DROP POLICY user_session_update ON core.user_session;`);
    await queryRunner.query(`DROP POLICY user_session_insert ON core.user_session;`);
    await queryRunner.query(`DROP POLICY user_session_select ON core.user_session;`);

    await queryRunner.query(`
      CREATE POLICY user_session_self ON core.user_session
        USING (organisation_id = core.current_org() AND user_id = core.current_uid())
        WITH CHECK (organisation_id = core.current_org() AND user_id = core.current_uid());
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.user_session TO rab_app;`);
  }
}

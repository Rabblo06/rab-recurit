import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.2 — idle-session timeout enforcement needs `crewflow` to actually be able to write
 * `core.user_session.idle_expires_at`, which it currently cannot.
 *
 * `UserSessionColumnPrivilegeTightening1786679000000` granted `rab_app` an explicit INSERT column
 * list (not including `idle_expires_at` — the column existed but was documented as "not enforced
 * in P1B — reserved for P2", so there was nothing to write yet) and an explicit UPDATE column list
 * of exactly `last_seen_at, revoked_at, revoked_reason, security_version` (again, no
 * `idle_expires_at` — nothing updated it). `CrewflowSingleCredentialRoleArchitecture1786682000000`
 * carried those same column grants over to `crewflow` when it became the runtime role. Confirmed
 * live: `crewflow`'s column ACL on `idle_expires_at` is `r` (SELECT only) — no INSERT, no UPDATE —
 * while `last_seen_at` is `arw`. Writing `idle_expires_at` from `RefreshTokenService.issue()` (at
 * session creation) or `SessionValidityService.assertActive()` (the sliding bump) without this
 * migration fails the WHOLE statement with `permission denied for table user_session`, reproduced
 * directly against a disposable database before writing this migration.
 *
 * Deliberately column-scoped, not a blanket re-grant — same reasoning
 * `UserSessionColumnPrivilegeTightening`'s own doc comment already gives for why a blanket grant
 * was wrong the first time: `crewflow` gets exactly the one additional column each statement needs,
 * nothing else `rab-server/src` doesn't already write.
 *
 * No change to `enforce_user_session_mutation_invariants()` or its trigger: that trigger's blanket
 * "treat as immutable" list only names columns it explicitly enumerates
 * (id/organisation_id/user_id/application_target/absolute_expires_at/created_at) — `idle_expires_at`
 * was never in that list, so it was already structurally mutable at the trigger layer; only the
 * GRANT was missing. The idle value can still only ever move within
 * `[now(), absolute_expires_at]` — enforced by the pre-existing `user_session_idle_before_absolute_check`
 * CHECK constraint, not by this migration.
 */
export class UserSessionIdleExpiryPrivilege1786685000000 implements MigrationInterface {
  name = 'UserSessionIdleExpiryPrivilege1786685000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT INSERT (idle_expires_at) ON core.user_session TO crewflow;`);
    await queryRunner.query(`GRANT UPDATE (idle_expires_at) ON core.user_session TO crewflow;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE INSERT (idle_expires_at), UPDATE (idle_expires_at) ON core.user_session FROM crewflow;`);
  }
}

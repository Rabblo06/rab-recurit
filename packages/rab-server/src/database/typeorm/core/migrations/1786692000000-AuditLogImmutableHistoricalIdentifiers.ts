import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner-approved "Option D" fix for a real, confirmed production bug: `UserDeletionService.
 * deleteUser()` (the one place a hard `DELETE FROM core."user"` is ever issued) 500s whenever the
 * target has EVER appeared as `audit_log.actor_user_id` or `audit_log.target_user_id` — which, in
 * practice, is almost any account that has ever logged in or been created, since `user.created`
 * logs `target_user_id` and `auth.login` logs `actor_user_id`. Reproduced directly against a
 * disposable database, independent of any other work this session: 7 of
 * `user-deletion-abuse-cases.integration.spec.ts`'s 14 tests already fail with a raw 500 today,
 * before this migration.
 *
 * ROOT CAUSE: `actor_user_id`/`target_user_id` were declared `REFERENCES core."user"(id) ON DELETE
 * SET NULL` (`AccountLifecycleSchema1786666200000`). Postgres enforces a declarative FK's SET NULL
 * action using the REFERENCING table's OWNER's own grants, not the session role's — and
 * `audit_log`'s owner (`crewflow`) has had UPDATE revoked from it since
 * `AuditLogCrewflowOwnerRevoke1786686000000`, specifically so the ordinary runtime credential (and
 * its owner) can never rewrite the audit trail. That revoke is correct and stays exactly as-is —
 * this migration does NOT grant UPDATE/DELETE back to anyone, on any column, table-wide or
 * column-scoped. It removes the FK action that depended on a privilege the owner-revoke
 * deliberately took away, which is the only way to keep both guarantees (insert-only AND
 * successful user deletion) true at once.
 *
 * FIX: drop both FK constraints entirely. `actor_user_id`/`target_user_id` become plain, immutable
 * UUID columns — once an audit row is written, NOTHING (not a cascade, not a grant, not a future
 * bug) ever touches it again, which is a STRONGER form of "never rewrite or delete existing audit
 * history" than the previous SET NULL design ever actually achieved (it never worked). A user's
 * historical audit rows now retain their real id forever instead of going to NULL. This is the
 * direct, intended consequence of preserving audit history across account deletion — see this
 * migration's own PR/commit description for the full compatibility note reported to the project
 * owner before this was written, and `user-deletion-abuse-cases.integration.spec.ts`'s updated
 * "survives with identifiers intact" test for the new, approved behaviour.
 *
 * Referential-integrity "was this a real user when the event was recorded" is now enforced at
 * insert time only, in application code — `AuditService.record()` — the single chokepoint this
 * table has ever had for writes. The FK could only ever have validated that anyway (it never
 * retroactively re-validated existing rows); this migration doesn't weaken that guarantee for any
 * row already covered, it only removes the part that broke deletion.
 *
 * `audit_log_organisation_id_fkey` (`ON DELETE CASCADE` from `core.organisation`) is NOT touched —
 * out of scope for this fix (no code path hard-deletes an `Organisation` row today), but flagged
 * here for whoever eventually builds one: a real org deletion would hit the identical
 * owner-privilege wall on its CASCADE delete into `audit_log`, for the same reason.
 *
 * Indexes (`audit_log_actor_created_idx`, `audit_log_target_idx`, `audit_log_org_time_idx`), the
 * `audit_log_tenant` RLS policy, and the `crewflow`/`crewflow_app` table-level grants are all
 * column/ACL-independent of the FK and are untouched by this migration.
 */
export class AuditLogImmutableHistoricalIdentifiers1786692000000 implements MigrationInterface {
  name = 'AuditLogImmutableHistoricalIdentifiers1786692000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.audit_log DROP CONSTRAINT audit_log_actor_user_id_fkey;`);
    await queryRunner.query(`ALTER TABLE core.audit_log DROP CONSTRAINT audit_log_target_user_id_fkey;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IRREVERSIBLE IN SPIRIT, SAFE IN MECHANICS: once any deletion has happened under the `up()`
    // state, this `down()` cannot restore the original "every actor/target id is live" invariant —
    // those rows' ids are gone from core."user" and this migration never rewrites or re-nulls
    // existing data to force-fit them back under a constraint. What it CAN safely do, and does, is
    // re-enable enforcement for every NEW write from this point forward.
    //
    // NOT VALID is why that's safe to run even with dangling data already present: a plain `ADD
    // CONSTRAINT` scans and REJECTS the whole ALTER TABLE if any existing row violates it — which
    // every post-fix deletion guarantees by design. NOT VALID skips that scan, so this `down()`
    // itself can never fail, but the constraint it adds also doesn't retroactively validate anything
    // (Postgres marks it `convalidated = false` until a later explicit `VALIDATE CONSTRAINT`, which
    // would then correctly fail against any dangling row — confirmed empirically in a throwaway
    // transaction against a disposable database before writing this comment, both that the ADD
    // CONSTRAINT itself succeeds and that it lands NOT VALID). That failure, if ever attempted, is
    // the intended "fail safely" outcome: Postgres refusing to pretend historical data satisfies a
    // constraint it never satisfied, rather than this migration silently clearing those ids to NULL
    // to make validation pass.
    await queryRunner.query(`
      ALTER TABLE core.audit_log
        ADD CONSTRAINT audit_log_actor_user_id_fkey
        FOREIGN KEY (actor_user_id) REFERENCES core."user"(id) ON DELETE SET NULL NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE core.audit_log
        ADD CONSTRAINT audit_log_target_user_id_fkey
        FOREIGN KEY (target_user_id) REFERENCES core."user"(id) ON DELETE SET NULL NOT VALID;
    `);
  }
}

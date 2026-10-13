import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.8 — fixes a real, confirmed defect (found running this session's own integration suite, not
 * a hypothetical): `StepUpReauthService.assertCurrentPassword` (added this session for
 * `PlatformAdminService.grant`/`revoke` and `ManagerService`/`StaffService.deleteUser`) called
 * `manager.findOne(User, { select: ['id', 'passwordHash'] })` — a plain SELECT that
 * `RevokeUserPasswordHashSelectFromApp1786669800000` already, deliberately, made impossible for
 * `rab_app`/`crewflow_app` (that migration's own doc comment: "every real read of `passwordHash`
 * goes through `core.auth_find_users_by_email`, a SECURITY DEFINER function... every direct
 * `rab_app` touch of these two columns elsewhere in the app is a write"). Every production call to
 * step-up reauth was therefore failing with "permission denied for table user" — confirmed via
 * `p1d-security-versions.integration.spec.ts`'s existing `platform-admin grant/revoke invalidation`
 * test, which exercises `PlatformAdminService.grant` end to end.
 *
 * Fix follows the exact precedent `auth_find_users_by_email` set: a narrow, read-only, SECURITY
 * DEFINER function, owned by `rab_secure_owner` (which has real SELECT on `password_hash`) and
 * EXECUTE-granted to `crewflow`/`crewflow_app` — never a broadened table-level SELECT grant, which
 * would undo `RevokeUserPasswordHashSelectFromApp`'s own fix. Scoped to a single `p_user_id` with
 * no organisation filter, same as that precedent's email-only scoping — safe because every real
 * caller (`StepUpReauthService.assertCurrentPassword`) only ever passes the ALREADY-authenticated
 * caller's own `ctx.userId`, never an arbitrary target's id; this function itself enforces no
 * caller-identity check (it has none to enforce — it takes only the id to look up), exactly like
 * `auth_find_users_by_email` enforces none beyond "this email", by design.
 *
 * Runs via the `rab` superuser connection, same as `OrganisationSuspension1786702000000` — `ALTER
 * FUNCTION ... OWNER TO rab_secure_owner` requires it; `crewflow` is not and cannot become a
 * member of that NOLOGIN role (`CrewflowSingleCredentialRoleArchitecture1786682000000`'s own
 * documented design).
 */
export class AuthFindPasswordHashByUserId1786703000000 implements MigrationInterface {
  name = 'AuthFindPasswordHashByUserId1786703000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_password_hash_by_user_id(p_user_id uuid)
      RETURNS TABLE ("passwordHash" text)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT password_hash FROM core."user" WHERE id = p_user_id AND deleted_at IS NULL;
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.auth_find_password_hash_by_user_id(uuid) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_password_hash_by_user_id(uuid) TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION core.auth_find_password_hash_by_user_id(uuid);`);
  }
}

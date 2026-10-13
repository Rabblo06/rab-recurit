import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.8 — fixes a second real, confirmed defect found running this session's integration suite:
 * `AuditService.assertRecordedIdentitiesExist` (added by `AuditLogImmutableHistoricalIdentifiers
 * 1786692000000` to replace a dropped FK) runs `SELECT id FROM core."user" WHERE id = ANY($1)` on
 * the SAME `manager`/transaction as the caller's own `runInTenantContext` — which means it is
 * itself RLS-scoped to whichever `organisation_id` that transaction happens to have bound. That is
 * correct and desired for every ordinary, single-tenant audit entry, but `PlatformAdminService
 * .grant`/`revoke` is a genuinely cross-org action (`core.platform_admin` has no `organisation_id`
 * at all): the actor and target routinely belong to two DIFFERENT organisations, and the actor's
 * own tenant context (bound so the audit_log INSERT can satisfy its FORCEd `organisation_id =
 * current_org()` policy) can never see the target's row. `settings-abuse-cases.integration.spec
 * .ts`'s own existing "platform admin can grant another user... the target immediately gains
 * access" test (two SEPARATE organisations, by `seedOrgWithFullyPermissionedUser()` called twice)
 * confirmed this live: every grant/revoke 500'd with "do not resolve to an existing core.user row."
 *
 * Fix: the EXISTENCE check's actual job — per its own doc comment, "replacing a dropped FK",
 * i.e. catching a FABRICATED id, never a real tenant-boundary check (that is `audit_log`'s own RLS
 * policy's job, on the row being inserted, not on this pre-check) — doesn't need RLS at all. A
 * narrow SECURITY DEFINER function, same precedent as `auth_find_users_by_email`/
 * `auth_find_password_hash_by_user_id`, answers "does this id exist, anywhere" without being
 * bound by whichever single org the calling transaction happens to have bound.
 */
export class AuditUserIdsExist1786704000000 implements MigrationInterface {
  name = 'AuditUserIdsExist1786704000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.audit_existing_user_ids(p_ids uuid[])
      RETURNS TABLE (id uuid)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT id FROM core."user" WHERE id = ANY(p_ids);
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.audit_existing_user_ids(uuid[]) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.audit_existing_user_ids(uuid[]) TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION core.audit_existing_user_ids(uuid[]);`);
  }
}

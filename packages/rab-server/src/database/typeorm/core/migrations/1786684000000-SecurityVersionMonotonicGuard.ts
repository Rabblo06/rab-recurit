import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1D follow-up — the same monotonic-version invariant `core.user_session`'s own
 * `enforce_user_session_mutation_invariants` trigger (`UserSessionColumnPrivilegeTightening
 * 1786679000000`) already enforces, applied to the five new version columns added by
 * `SecurityVersionVectors1786683000000`: a version column may only ever move by EXACTLY +1 per
 * UPDATE. This is a genuine database-level guarantee, not application discipline alone — even a
 * bug or a future raw-SQL change that tried to set an arbitrary or lower value is rejected by
 * Postgres itself, the same "fail closed at the database, not just in TypeScript" posture CLAUDE.md
 * already requires everywhere else in this schema.
 *
 * Deliberately narrower than `user_session`'s own trigger: this one does NOT also require the
 * version bump to accompany any OTHER specific column transition (user_session's trigger ties its
 * bump to a revocation specifically) — each of these five tables has its own, already-reviewed set
 * of legitimate mutation paths (see `SecurityVersionVectors1786683000000`'s own doc comment), and
 * tying the DB-level guard to all of them individually would duplicate that review in SQL for no
 * additional safety. The one invariant worth enforcing at this layer, uniformly, is "+1 or
 * unchanged, never anything else."
 */
export class SecurityVersionMonotonicGuard1786684000000 implements MigrationInterface {
  name = 'SecurityVersionMonotonicGuard1786684000000';

  private static readonly GUARDS: ReadonlyArray<{ table: string; column: string; fnName: string; triggerName: string }> = [
    { table: 'core."user"', fnName: 'core.enforce_user_security_version_monotonic', triggerName: 'user_security_version_guard', column: 'security_version' },
    { table: 'core.role', fnName: 'core.enforce_role_permission_version_monotonic', triggerName: 'role_permission_version_guard', column: 'permission_version' },
    { table: 'core.platform_admin', fnName: 'core.enforce_platform_admin_security_version_monotonic', triggerName: 'platform_admin_security_version_guard', column: 'security_version' },
    { table: 'core.organisation', fnName: 'core.enforce_organisation_security_version_monotonic', triggerName: 'organisation_security_version_guard', column: 'security_version' },
    { table: 'core.workspace_membership', fnName: 'core.enforce_workspace_membership_security_version_monotonic', triggerName: 'workspace_membership_security_version_guard', column: 'security_version' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);
    for (const g of SecurityVersionMonotonicGuard1786684000000.GUARDS) {
      await queryRunner.query(`
        CREATE FUNCTION ${g.fnName}() RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = core, pg_catalog
        AS $$
        BEGIN
          IF NEW.${g.column} IS DISTINCT FROM OLD.${g.column} AND NEW.${g.column} IS DISTINCT FROM OLD.${g.column} + 1 THEN
            RAISE EXCEPTION '${g.table}: ${g.column} may only move by exactly +1 per update' USING ERRCODE = '22023';
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${g.triggerName}
          BEFORE UPDATE ON ${g.table}
          FOR EACH ROW EXECUTE FUNCTION ${g.fnName}();
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);
    for (const g of SecurityVersionMonotonicGuard1786684000000.GUARDS) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS ${g.triggerName} ON ${g.table};`);
      await queryRunner.query(`DROP FUNCTION IF EXISTS ${g.fnName}();`);
    }
  }
}

/** Same reasoning and mechanism as `SecurityVersionVectors1786683000000`'s own guard — see that file. */
async function assertBootstrapPrivilege(queryRunner: QueryRunner): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT current_user AS rolname, rolsuper, pg_has_role(current_user, 'rab_secure_owner', 'MEMBER') AS is_owner_member
       FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ rolname: string; rolsuper: boolean; is_owner_member: boolean }>;
  const [row] = rows;
  if (!row || !(row.rolsuper || row.is_owner_member)) {
    throw new Error(
      `SecurityVersionMonotonicGuard1786684000000 refuses to run as '${row?.rolname ?? 'unknown'}': creating a trigger on ` +
        `core."user"/core.platform_admin/core.organisation requires the connecting role to be a superuser or a member of ` +
        `rab_secure_owner. Re-run with DATABASE_URL pointed at the privileged bootstrap connection — never crewflow.`,
    );
  }
}

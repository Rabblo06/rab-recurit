import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';

/**
 * M2-F2 (2026-10-28): `core.navigation_layout` must be owned by `crewflow` on every install, whatever identity ran the
 * migrations.
 *
 * Root cause: `NavigationLayout1786718600000` creates the table with no `OWNER TO`, so it belongs to whoever ran it. The
 * repair `ReconcileSuperuserOwnedCoreObjects1786719600000` re-owns only SUPERUSER-owned objects. On a fresh install run by
 * a NON-superuser migration identity (managed PostgreSQL; the restricted migrator of `ci-migration-security`) the table
 * therefore stays owned by the migration login. Consequences there: `crewflow` lacks DELETE/TRUNCATE/REFERENCES/TRIGGER on
 * it, and every ON DELETE CASCADE into it (deleting a workspace, a user or an organisation) runs as that login, so the
 * delete fails as soon as the login's memberships are narrowed after the run.
 *
 * Existing databases already have the target state (owner crewflow; rab-devdb and the test template got it from the
 * superuser repair or a manual ALTER): there this migration changes nothing. Neither historical migration is edited.
 *
 * Scope, deliberately the smallest: this one table. It never touches rows, policies, RLS flags or grants. ALTER OWNER keeps
 * every ACL entry (the old owner's entry is re-assigned to the new owner), so `crewflow_app` keeps exactly
 * SELECT/INSERT/UPDATE and `crewflow` ends with the owner's full privileges, as on every existing database. It refuses
 * (rolling back) rather than guess: the only owner it re-owns is the running migration identity itself (current_user or
 * session_user, i.e. the login that left the table behind); rab_secure_owner, a runtime login, a superuser or any other
 * login is refused, even for a superuser runner (independent review). The hand-over runs inside
 * `withCrewflowCoreCreate`: after Phase 0b crewflow has no CREATE on core, which PostgreSQL requires of a new owner.
 * Verified exactly before commit: owner, RLS + FORCE, the complete ACL (only crewflow and crewflow_app, crewflow_app
 * exactly SELECT/INSERT/UPDATE, nothing for PUBLIC) and the one policy's shape; anything else rolls back.
 *
 * down(): intentionally a no-op. Handing the table back to a migration login would re-create the defect.
 */
export class NavigationLayoutCrewflowOwner1786721110000 implements MigrationInterface {
  name = 'NavigationLayoutCrewflowOwner1786721110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT r.rolname AS owner, r.rolsuper AS super, current_user::text AS runner,
              r.rolname IN (current_user, session_user) AS is_runner
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
        WHERE c.oid = 'core.navigation_layout'::regclass`,
    )) as Array<{ owner: string; super: boolean; runner: string; is_runner: boolean }>;
    if (!row) throw new Error(`${this.name}: core.navigation_layout not found. Refusing.`);
    if (row.owner === 'crewflow') return; // every existing database: nothing to do

    if (row.super || ['rab_secure_owner', 'crewflow_app', 'rab_owner', 'rab_app'].includes(row.owner)) {
      throw new Error(
        `${this.name}: core.navigation_layout is owned by "${row.owner}", which this repair does not expect ` +
          `(it only re-owns a table left with the migration login). Refusing; review the database by hand.`,
      );
    }
    if (!row.is_runner) {
      throw new Error(
        `${this.name}: core.navigation_layout is owned by "${row.owner}", which is not the running migration identity ` +
          `("${row.runner}"). Re-run with the migration identity that created it, or review the database by hand. Refusing.`,
      );
    }

    await withCrewflowCoreCreate(queryRunner, () => queryRunner.query('ALTER TABLE core.navigation_layout OWNER TO crewflow'));

    const [after] = (await queryRunner.query(
      `SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT pg_catalog.string_agg(x.g, ',' ORDER BY x.g)
                 FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS g
                         FROM pg_catalog.aclexplode(c.relacl) a) x) AS grantees,
              (SELECT pg_catalog.string_agg(a.privilege_type || ':' || a.is_grantable::text, ',' ORDER BY a.privilege_type)
                 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee = 'crewflow_app'::pg_catalog.regrole) AS app_privileges,
              pg_catalog.has_table_privilege('crewflow', c.oid, 'DELETE') AS crewflow_d,
              (SELECT pg_catalog.string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':' ||
                        p.polroles::text || ':' || (pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                                                    = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))::text, ';')
                 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policy
         FROM pg_catalog.pg_class c WHERE c.oid = 'core.navigation_layout'::regclass`,
    )) as Array<Record<string, unknown>>;
    const expected = {
      owner: 'crewflow',
      rls: true,
      force: true,
      grantees: 'crewflow,crewflow_app',
      app_privileges: 'INSERT:false,SELECT:false,UPDATE:false', // never WITH GRANT OPTION
      crewflow_d: true,
      policy: 'navigation_layout_own:*:true:{0}:true',
    };
    if (JSON.stringify(after) !== JSON.stringify(expected)) {
      throw new Error(`${this.name}: unexpected state after the hand-over (${JSON.stringify(after)}). Rolling back.`);
    }
  }

  public async down(): Promise<void> {
    // Intentionally empty: see the class comment.
  }
}

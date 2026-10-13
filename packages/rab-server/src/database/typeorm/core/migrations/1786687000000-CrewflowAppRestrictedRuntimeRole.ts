import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2/P3 overnight mandate, Checkpoint 2 — the owner-approved restricted runtime role.
 *
 * ROOT PROBLEM, demonstrated live (not theoretical) before this migration: `crewflow` is
 * simultaneously (a) the ONE credential the API and Worker connect as for every ordinary request,
 * and (b) the OWNER of 36 of `core`'s 47 tables. Table ownership confers DDL authority that no
 * `GRANT` can ever extend to a non-owning role (Postgres structurally ties ALTER/DROP/CREATE
 * TRIGGER/RLS-toggling to ownership or superuser, never to a grantable privilege) — meaning a
 * compromised `crewflow` credential could run, and was directly confirmed able to run:
 *   `ALTER TABLE core.staff_profile DISABLE ROW LEVEL SECURITY;`
 * with no error, as an ordinary LOGIN role, no superuser needed. `CrewflowSingleCredentialRoleArchitecture
 * 1786682000000`'s own doc comment already named this trade-off in writing ("crewflow now owns far
 * more tables than rab_app ever did... not equivalent compromise-containment to the old rab_app/
 * rab_owner split"); this migration is the fix the owner approved for it.
 *
 * DESIGN (full investigation recorded in docs/architecture/P2-PRODUCTION-READINESS.md's Checkpoint 2
 * section): introduce `crewflow_app`, a new LOGIN role that owns NOTHING and therefore cannot run
 * any DDL regardless of which DML privileges it holds — the ownership/DDL boundary is enforced by
 * Postgres itself, not by application discipline. `crewflow` is RETAINED, unchanged, as the
 * migration/bootstrap/maintenance identity (exactly as this file's own header already anticipated:
 * "The existing crewflow role may be retained or converted into a maintenance/ownership identity").
 *
 * WORKSPACE PROVISIONING (Checkpoint 2.4's own required investigation, traced end-to-end before
 * writing this migration, not assumed): `ManagerWorkspaceService.create()` — the ONLY HTTP-reachable
 * code path — never calls `provisionWorkspaceSchema()` or any of the four workspace-lifecycle
 * mutation functions; it only ever writes `schema_status = 'CREATING'`. The actual schema-creation
 * DDL runs EXCLUSIVELY inside `rab-worker`'s `runWorkspaceProvisioningCycle`, over its own dedicated,
 * non-pooled connection (`DATABASE_URL_UNPOOLED`, confirmed in `workspace-provisioning.job.ts`'s own
 * doc comment) — a process boundary that already existed before this migration, just not yet backed
 * by a database-privilege boundary (both connections were `crewflow`). This migration completes that:
 * `DATABASE_URL_UNPOOLED` stays `crewflow` (used only by migrations and this one dedicated worker
 * connection); `DATABASE_URL` — the API's only connection, and the Worker's main pooled
 * `runtimeDataSource`/`directDataSource` used by every OTHER job — becomes `crewflow_app`. No code
 * path that `crewflow_app` can reach ever calls `core.provision_workspace_schema` or the four
 * lifecycle-mutation functions (confirmed: `crewflow` itself doesn't even hold EXECUTE on the four —
 * `WorkspaceLifecycleGrantTightening1786677800000` already revoked them — only `provision_workspace_
 * schema` itself is excluded by this migration specifically, since that one remained granted).
 *
 * `rab_secure_owner`'s ownership of the 11 pre-auth-sensitive tables is UNCHANGED by this migration
 * — `crewflow_app`'s grants on those 11 are replicated from `crewflow`'s own CURRENT grants, same as
 * every other table, never broadened.
 *
 * NEON COMPATIBILITY (Checkpoint 2's own requirement): this migration uses only `CREATE ROLE`,
 * `GRANT`, and catalog reads — no superuser-only operation beyond what `CrewflowSingleCredentialRole
 * Architecture` already required (`assertBootstrapPrivilege` — superuser OR `CREATEROLE`), which
 * Neon's own database-owner role already satisfies today (confirmed: that migration already runs
 * successfully against Neon-hosted environments in this project's history).
 *
 * GRANT REPLICATION METHOD: rather than hand-enumerating every table and function (error-prone and
 * silently stale the moment a future migration adds a 48th table), this migration reads `crewflow`'s
 * OWN CURRENT effective grants directly from `information_schema` at migration-run time and
 * replicates them onto `crewflow_app` — table-level privileges (`table_privileges`), column-scoped
 * privileges where they differ from the table-wide grant (`column_privileges` — e.g. `user_session`,
 * `user`, `organisation`, `platform_admin`'s already-narrow column ACLs), and function EXECUTE
 * grants (`routine_privileges`), explicitly excluding `provision_workspace_schema`. This is
 * self-maintaining: if a later migration changes what `crewflow` itself can do, re-running an
 * equivalent replication would reflect that automatically, rather than this file silently drifting
 * out of date the way the ORIGINAL `rab_app`-era `audit_log` REVOKE did after the single-credential
 * rename (see `AuditLogCrewflowOwnerRevoke1786686000000`, found during this same Checkpoint 2 audit).
 *
 * Ownership itself is never touched by `GRANT` — replicating every privilege `crewflow` holds still
 * cannot make `crewflow_app` an owner of anything, which is the entire structural guarantee this
 * migration relies on.
 */
export class CrewflowAppRestrictedRuntimeRole1786687000000 implements MigrationInterface {
  name = 'CrewflowAppRestrictedRuntimeRole1786687000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);
    const password = requireCrewflowAppBootstrapPassword();

    await queryRunner.query(
      `DO $do$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crewflow_app') THEN
           CREATE ROLE crewflow_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
         ELSE
           ALTER ROLE crewflow_app PASSWORD '${password}';
         END IF;
       END $do$;`,
    );

    // Table-level privileges: every (table, privilege_type) pair crewflow currently has, EXCLUDING
    // any privilege that is actually column-scoped for that table (handled separately below) — a
    // privilege_type appears in table_privileges only when ALL columns have it, so this and the
    // column-level pass below are mutually exclusive by construction, never double-granting.
    //
    // Deliberately restricted to {SELECT, INSERT, UPDATE, DELETE} — the exact baseline
    // `postgres-init/01-roles.sql`'s own `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE,
    // DELETE ON TABLES TO rab_app` already established as "what the ordinary runtime role needs,"
    // never `TRIGGER`/`REFERENCES`/`TRUNCATE`. Found live, during this migration's own first draft:
    // blindly replicating EVERY `table_privileges` row crewflow holds also copied `TRIGGER` (crewflow
    // has it because grantable privileges, unlike ownership, aren't themselves the DDL boundary —
    // `CREATE TRIGGER` only needs the TRIGGER privilege, not table ownership) — confirmed exploitable
    // by actually creating one as `crewflow_app` against a disposable database before writing this
    // exclusion. No production code anywhere in `rab-server`/`rab-worker` issues `TRUNCATE` either
    // (grepped every call site, not assumed) — only migrations ever need any of these three.
    const RUNTIME_TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
    await queryRunner.query(`
      DO $do$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT table_schema, table_name, privilege_type
            FROM information_schema.table_privileges
           WHERE grantee = 'crewflow' AND table_schema = 'core'
             AND privilege_type = ANY(ARRAY['${RUNTIME_TABLE_PRIVILEGES.join("','")}'])
        LOOP
          EXECUTE format('GRANT %s ON %I.%I TO crewflow_app', r.privilege_type, r.table_schema, r.table_name);
        END LOOP;
      END $do$;
    `);

    // Column-scoped privileges: for every (table, privilege_type) that is NOT already covered by
    // the table-level grant above, grant exactly the same column list crewflow itself has — this is
    // what keeps crewflow_app's access to e.g. core.user_session.idle_expires_at or core."user".
    // password_hash exactly as narrow as crewflow's own already-reviewed column ACLs, never broader.
    await queryRunner.query(`
      DO $do$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT table_schema, table_name, privilege_type, array_agg(DISTINCT column_name ORDER BY column_name) AS columns
            FROM information_schema.column_privileges
           WHERE grantee = 'crewflow' AND table_schema = 'core'
           GROUP BY table_schema, table_name, privilege_type
        LOOP
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_privileges
             WHERE grantee = 'crewflow' AND table_schema = r.table_schema AND table_name = r.table_name AND privilege_type = r.privilege_type
          ) THEN
            EXECUTE format(
              'GRANT %s (%s) ON %I.%I TO crewflow_app',
              r.privilege_type,
              (SELECT string_agg(quote_ident(c), ', ') FROM unnest(r.columns) AS c),
              r.table_schema,
              r.table_name
            );
          END IF;
        END LOOP;
      END $do$;
    `);

    // Function EXECUTE grants: everything crewflow itself can call, EXCEPT `provision_workspace_schema`
    // — the one still-granted privileged entry point the dedicated provisioning worker connection
    // (staying on `crewflow`, never `crewflow_app`) needs. The four workspace-lifecycle MUTATION
    // functions are not in crewflow's own grant list at all (already revoked by
    // WorkspaceLifecycleGrantTightening1786677800000), so there is nothing further to exclude for them.
    await queryRunner.query(`
      DO $do$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT routine_schema, routine_name
            FROM information_schema.routine_privileges
           WHERE grantee = 'crewflow' AND routine_schema = 'core' AND routine_name != 'provision_workspace_schema'
        LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I TO crewflow_app', r.routine_schema, r.routine_name);
        END LOOP;
      END $do$;
    `);

    // Schema USAGE — needed independently of table/function grants (USAGE on the schema itself is
    // not part of table_privileges/routine_privileges).
    await queryRunner.query(`GRANT USAGE ON SCHEMA core TO crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the role automatically revokes every grant it holds (Postgres requires a role to
    // have zero remaining grants/ownership before DROP ROLE succeeds, but REASSIGN/DROP OWNED is
    // not needed here since crewflow_app never owns anything — only ever a grantee).
    await queryRunner.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA core FROM crewflow_app;`);
    await queryRunner.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA core FROM crewflow_app;`);
    await queryRunner.query(`REVOKE USAGE ON SCHEMA core FROM crewflow_app;`);
    await queryRunner.query(`DROP ROLE IF EXISTS crewflow_app;`);
  }
}

async function assertBootstrapPrivilege(queryRunner: QueryRunner): Promise<void> {
  const [{ rolsuper, rolcreaterole }] = (await queryRunner.query(
    `SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ rolsuper: boolean; rolcreaterole: boolean }>;
  if (!rolsuper && !rolcreaterole) {
    throw new Error(
      `CrewflowAppRestrictedRuntimeRole1786687000000 refuses to run as a role with neither superuser nor CREATEROLE — ` +
        `re-run with the privileged bootstrap connection, never the ordinary runtime credential.`,
    );
  }
}

function requireCrewflowAppBootstrapPassword(): string {
  const password = process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD;
  if (!password) {
    throw new Error(
      'CREWFLOW_APP_BOOTSTRAP_PASSWORD is required to run CrewflowAppRestrictedRuntimeRole1786687000000 ' +
        '— refusing to create or reset the crewflow_app login role with no password, or a hardcoded one.',
    );
  }
  if (/[^A-Za-z0-9!@#$%^&*_\-+=.]/.test(password)) {
    throw new Error(
      'CREWFLOW_APP_BOOTSTRAP_PASSWORD contains a character that could break out of the single-quoted literal ' +
        'this migration inlines it into — use only letters, digits, and !@#$%^&*_-+=. .',
    );
  }
  return password;
}

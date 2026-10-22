import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Foundation fix P1 (2026-10-22) — SECURITY FINDING: an audit entry could name a real user from ANOTHER organisation.
 *
 * Root cause: `AuditLogImmutableHistoricalIdentifiers1786692000000` dropped the `actor_user_id`/`target_user_id` FKs and
 * moved "was this a real user" into `AuditService.record()`. `AuditUserIdsExist1786704000000` then made that check a
 * SECURITY DEFINER existence test (`core.audit_existing_user_ids`) that deliberately ignores the organisation, so that
 * platform-admin grant/revoke (actor and target in different organisations) would stop failing. The result checked
 * existence ANYWHERE: org A's transaction could record org B's user as actor or target, and the database had no rule at
 * all (`audit_log_tenant` constrains only the row's own `organisation_id`). Integration test
 * `audit-log-immutable-identifiers` ("rejects a REAL user id that belongs to a different organisation") failed.
 *
 * Rule now enforced in the database (and pre-checked by `AuditService.record()` through the same function):
 *   every non-null `actor_user_id`/`target_user_id` must be an existing `core.user` row whose `organisation_id` equals the
 *   audit row's `organisation_id` — UNLESS the row's actor is an ACTIVE platform administrator
 *   (`core.is_active_platform_admin`). That exception is exactly the legitimate cross-organisation shape the platform
 *   already has: grant/revoke (row in the admin's org, target elsewhere), organisation suspension/reactivation,
 *   organisation + CEO creation, Initial Manager replacement and Admin Inspect (row in the target org, admin actor
 *   elsewhere). An actor-less (NULL) system entry may only reference users of its own organisation.
 *
 * Objects (all SECURITY DEFINER, owned by `rab_secure_owner` — the owner of the NOT-FORCEd `user`/`platform_admin`
 * tables, so they can see every organisation's rows; PUBLIC EXECUTE revoked; `search_path` pinned):
 *   - `core.audit_identity_violations_in(org, actor, target)` — the ONE implementation of the rule. Takes an explicit
 *     organisation, so it is granted to NO login role (it would otherwise answer "is user X in org Y" for any Y).
 *   - `core.audit_identity_violations(actor, target)` — the runtime pre-check: the same rule against the transaction's
 *     own bound organisation (`core.current_org()`); EXECUTE to `crewflow` and `crewflow_app`. With no tenant context
 *     bound every id is reported (fail closed). It discloses nothing beyond the caller's own organisation, except
 *     whether an unguessable id exists at all, which `audit_existing_user_ids` already answers today.
 *   - `core.audit_log_enforce_recorded_identities()` + trigger `audit_log_recorded_identities` BEFORE INSERT OR UPDATE
 *     OF the three identity columns, FOR EACH ROW. Fires for every role, including the table owner and a superuser,
 *     and raises SQLSTATE 23503 (foreign_key_violation — this is the integrity rule the dropped FK used to carry).
 *
 * Unchanged: `audit_log` stays insert-only (no UPDATE/DELETE grant is added; the UPDATE arm of the trigger only matters
 * to a superuser), FORCE RLS and `audit_log_tenant` are untouched, existing rows are never re-validated (insert-time
 * only, like the FK was), and user deletion is unaffected (no FK, no cascade). `core.audit_existing_user_ids` is kept
 * so an API/Worker image built before this change keeps working during a rolling deploy; nothing new calls it.
 */
export class AuditLogRecordedIdentityOrganisationCheck1786719610000 implements MigrationInterface {
  name = 'AuditLogRecordedIdentityOrganisationCheck1786719610000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.audit_identity_violations_in(p_organisation_id uuid, p_actor_user_id uuid, p_target_user_id uuid)
      RETURNS TABLE (user_id uuid, reason text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT i.id,
               CASE WHEN p_organisation_id IS NULL THEN 'no_organisation'
                    WHEN u.id IS NULL THEN 'unknown_user'
                    ELSE 'other_organisation' END
          FROM (SELECT DISTINCT x AS id FROM unnest(ARRAY[p_actor_user_id, p_target_user_id]) AS x WHERE x IS NOT NULL) i
          LEFT JOIN core."user" u ON u.id = i.id
         WHERE p_organisation_id IS NULL
            OR u.id IS NULL
            OR (u.organisation_id <> p_organisation_id
                AND NOT (p_actor_user_id IS NOT NULL AND core.is_active_platform_admin(p_actor_user_id)));
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.audit_identity_violations_in(uuid, uuid, uuid) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.audit_identity_violations_in(uuid, uuid, uuid) FROM PUBLIC;`);

    await queryRunner.query(`
      CREATE FUNCTION core.audit_identity_violations(p_actor_user_id uuid, p_target_user_id uuid)
      RETURNS TABLE (user_id uuid, reason text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT v.user_id, v.reason FROM core.audit_identity_violations_in(core.current_org(), p_actor_user_id, p_target_user_id) v;
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.audit_identity_violations(uuid, uuid) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.audit_identity_violations(uuid, uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.audit_identity_violations(uuid, uuid) TO crewflow, crewflow_app;`);

    await queryRunner.query(`
      CREATE FUNCTION core.audit_log_enforce_recorded_identities()
      RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_violations integer;
      BEGIN
        SELECT count(*) INTO v_violations
          FROM core.audit_identity_violations_in(NEW.organisation_id, NEW.actor_user_id, NEW.target_user_id);
        IF v_violations > 0 THEN
          -- Never echo the ids or another organisation's details: the count and the rule are enough to act on.
          RAISE EXCEPTION 'audit_log: % actor/target user id(s) do not resolve to an existing core.user row in this entry''s organisation (cross-organisation references require an active platform-admin actor)', v_violations
            USING ERRCODE = 'foreign_key_violation';
        END IF;
        RETURN NEW;
      END
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.audit_log_enforce_recorded_identities() OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.audit_log_enforce_recorded_identities() FROM PUBLIC;`);
    await queryRunner.query(`
      CREATE TRIGGER audit_log_recorded_identities
        BEFORE INSERT OR UPDATE OF organisation_id, actor_user_id, target_user_id ON core.audit_log
        FOR EACH ROW EXECUTE FUNCTION core.audit_log_enforce_recorded_identities();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_log_recorded_identities ON core.audit_log;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.audit_log_enforce_recorded_identities();`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.audit_identity_violations(uuid, uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.audit_identity_violations_in(uuid, uuid, uuid);`);
  }
}

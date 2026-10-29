import { QueryRunner } from 'typeorm';

/**
 * Phase 0b (E1, R5): `crewflow` holds no CREATE on schema `core` (SecureOwnerCoreSchemaAndHelpers1786721100000), so a
 * login that can act as `crewflow` cannot create objects in the schema whose functions run as `rab_secure_owner`.
 *
 * A later migration that creates a `core` object and hands it to `crewflow` (`ALTER ... OWNER TO crewflow`, the normal
 * pattern for a FORCE-RLS tenant table) needs `crewflow` to hold CREATE on `core` at that moment: PostgreSQL requires the
 * NEW owner to have CREATE on the object's schema whenever the migrator is not a superuser (Neon `neondb_owner`, the
 * planned `crewflow_migrator`). A superuser skips that check, so local runs pass either way; the non-superuser path is
 * proven by `phase0b-secure-owner.integration.spec.ts`.
 *
 * This wraps exactly that window: GRANT, the body, REVOKE, all inside the migration's own transaction. Catalog changes are
 * transactional, so no committed state — and no other session — ever sees `crewflow` holding CREATE on `core`. The window
 * has its own savepoint: on ANY error the grant and the body are rolled back to it before the error is rethrown, so the
 * grant cannot survive even if the calling migration catches the error and carries on (review L1).
 *
 * Not re-entrant (review N4): do not nest it — an inner REVOKE also removes the outer grant (the outer body then fails,
 * which is fail-closed). The body must not commit or end the transaction; that is checked after it runs.
 */
export async function withCrewflowCoreCreate<T>(queryRunner: QueryRunner, body: () => Promise<T>): Promise<T> {
  if (!queryRunner.isTransactionActive) {
    throw new Error('withCrewflowCoreCreate must run inside the migration transaction (the grant must never be committed).');
  }
  await queryRunner.query('SAVEPOINT crewflow_core_create');
  let result: T;
  try {
    await queryRunner.query('GRANT CREATE ON SCHEMA core TO crewflow');
    result = await body();
    if (!queryRunner.isTransactionActive) {
      throw new Error('withCrewflowCoreCreate: the body ended the migration transaction while crewflow held CREATE on core.');
    }
    await queryRunner.query('REVOKE CREATE ON SCHEMA core FROM crewflow');
  } catch (error) {
    await queryRunner.query('ROLLBACK TO SAVEPOINT crewflow_core_create');
    throw error;
  }
  await queryRunner.query('RELEASE SAVEPOINT crewflow_core_create');
  const [{ create }] = await queryRunner.query(`SELECT has_schema_privilege('crewflow', 'core', 'CREATE') AS create`);
  if (create) throw new Error('withCrewflowCoreCreate: crewflow still holds CREATE on schema core after the scoped window.');
  return result;
}

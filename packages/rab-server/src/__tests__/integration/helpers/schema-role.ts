import { DataSource } from 'typeorm';

/**
 * P-class migration helper (owner-login architecture). The restricted logins crewflow_app / crewflow_worker / crewflow are
 * SCHEMA ROLES now: no process connects as them, but their grants and policies still exist and are still the reviewed
 * boundary every SECURITY DEFINER and every policy is written against. A test that used to prove "the runtime login cannot
 * X" keeps proving it for the schema role: the fixture superuser opens a transaction, `SET LOCAL ROLE <role>` (session_user
 * stays the superuser, current_user becomes the role, exactly the privilege check PostgreSQL applies to that role), binds
 * the tenant context the same way TenantContextService does, runs the statement, and ROLLS BACK whatever happened.
 *
 * The owner login's DIFFERENT behaviour is asserted separately and labelled with its behaviour-change catalogue id
 * (twenty-expected-differences.json / owner-login-behaviour-catalogue.ts). Never a silent flip.
 *
 * Returns the SQLSTATE of the first failing statement, or 'OK'.
 */
export type SchemaRole = 'crewflow_app' | 'crewflow_worker' | 'crewflow';

export interface SchemaRoleContext {
  organisationId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  role?: string | null;
}

export async function sqlStateAsSchemaRole(
  admin: DataSource,
  role: SchemaRole,
  ctx: SchemaRoleContext,
  statements: Array<{ sql: string; params?: unknown[] }>,
): Promise<string> {
  if (!['crewflow_app', 'crewflow_worker', 'crewflow'].includes(role)) throw new Error('not a schema role');
  const runner = admin.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('BEGIN');
    await runner.query(`SELECT set_config('role', $1, true)`, [role]);
    await runner.query(
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true)`,
      [ctx.organisationId ?? '', ctx.workspaceId ?? '', ctx.userId ?? '', ctx.role ?? ''],
    );
    const [who] = await runner.query(`SELECT current_user AS u`);
    if (who.u !== role) throw new Error(`could not act as the schema role ${role} (current_user ${who.u})`);
    for (const s of statements) {
      try {
        await runner.query(s.sql, s.params ?? []);
      } catch (e) {
        return (e as { code?: string }).code ?? 'ERROR';
      }
    }
    return 'OK';
  } finally {
    await runner.query('ROLLBACK').catch(() => undefined);
    await runner.release();
  }
}

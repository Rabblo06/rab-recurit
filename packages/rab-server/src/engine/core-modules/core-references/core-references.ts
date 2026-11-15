import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (owner approved 2026-11-15; WS-COMMANDS.md §0a): the SERVICE-LAYER replacement for the dropped workspace →
 * core."user" foreign keys. Twenty enforces references that leave a workspace schema in the application (it creates foreign
 * keys only inside a workspace schema: twentyhq/twenty @ eedb0a73 workspace-schema-foreign-key-manager.service.ts:32);
 * re-implemented, not copied.
 *
 * Every write path that stores a user id taken from anything OTHER than the verified actor of the request (a route parameter, a
 * request body, an id read back from another row) calls this in the SAME transaction, before the write. Stricter than the old
 * FK: the user must exist AND belong to the caller's organisation (the FK accepted any organisation's user). It reads
 * core."user" under the caller's own RLS (the tenant transaction), so a user the caller cannot see is "not found" (404, never
 * 403: architecture §5.7). Fail closed: a query that throws propagates (deny).
 *
 * Actor columns (`created_by`, `*_by` = ctx.userId) are not re-checked per write: the actor is the session's verified, active
 * user of that organisation, resolved for this request. The window between that resolution and the write (a concurrent hard
 * delete) is what the periodic orphan check reports (workspace-core-orphans.ts).
 */
export async function assertUsersOfOrganisationTx(manager: Pick<EntityManager, 'query'>, organisationId: string, userIds: ReadonlyArray<string | null | undefined>): Promise<void> {
  const ids = [...new Set(userIds.filter((u): u is string => typeof u === 'string' && u.length > 0))];
  if (ids.length === 0) return;
  if (!organisationId) throw new NotFoundException('User not found.');
  const rows = await manager.query(`SELECT pg_catalog.count(*)::int AS n FROM core."user" u WHERE u.id = ANY ($1::uuid[]) AND u.organisation_id = $2`, [ids, organisationId]);
  if (Number((rows as Array<{ n: number }>)[0]?.n ?? 0) !== ids.length) throw new NotFoundException('User not found.');
}

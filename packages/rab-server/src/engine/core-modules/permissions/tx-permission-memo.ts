import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { AuthContext } from '../tenant/auth-context.interface';

/**
 * Phase X C5 (S0-C-caches.md §C5, XP-04): a TRANSACTION-LOCAL effective-permission set, so the layer-2 service checks in
 * one transaction (`PermissionsService.userHasPermissionTx`, 108 call sites; the dashboard alone checks 5 flags) cost ONE
 * query per identity instead of two per flag. It is a memo of the same transaction's own reads, never a cache:
 *
 *  - **Never shared across transactions.** Stored per `QueryRunner` (TypeORM creates one per transaction and never reuses
 *    a released one), only while that runner has an open transaction, and dropped on its commit or ANY rollback (a
 *    savepoint rollback included: a role write undone by a savepoint must not survive in the memo).
 *  - **Keyed by identity**, not by transaction alone: (user, organisation, workspace, actor type, inspected-by). A custom
 *    role is visible only in its own workspace (role RLS), so a set is never reused for another workspace or user.
 *  - **Filled only when the transaction's bound tenant matches the key.** The fill statement also returns the bound
 *    `rab.organisation_id` / `rab.workspace_id` (the only GUCs the permission tables' RLS reads); when they differ from the
 *    identity being checked (a transaction that rebinds mid-way), the answer is computed but NOT memoised.
 *  - **Never filled from the read replica:** only a transaction on the primary DataSource memoises.
 *  - **Cleared on in-transaction authority writes:** every in-transaction security-version bump (`SecurityVersionService`:
 *    role set, role definition, account authority, organisation, platform admin) and every ORM write to `user_role`,
 *    `role_permission`, `role`, `user_permission_override` or `permission` drops the transaction's memo, so the next check
 *    re-reads.
 *  - **Suspension and membership stay live:** they are not in this set (membership is resolved per request by
 *    `resolve_membership_for_session`, account status by the request snapshot guards). This memo never answers them.
 */
export type PermissionSet = ReadonlySet<string>;

const memo = new WeakMap<QueryRunner, Map<string, PermissionSet>>();
const subscribedTo = new WeakSet<DataSource>();
const AUTHORITY_TABLES = new Set(['user_role', 'role_permission', 'role', 'user_permission_override', 'permission']);

/** Drops every memoised set of this transaction. Safe on anything (no transaction, released runner, unknown manager). */
export function forgetTxPermissions(target: EntityManager | QueryRunner | null | undefined): void {
  const runner = isQueryRunner(target) ? target : target?.queryRunner;
  if (runner) memo.delete(runner);
}

/** The identity a memoised set belongs to. */
export function txPermissionIdentity(ctx: AuthContext): string {
  return JSON.stringify([ctx.userId, ctx.organisationId ?? null, ctx.workspaceId ?? null, ctx.actorType ?? null, ctx.inspectedBy ?? null]);
}

/**
 * The QueryRunner a memo may live on: an OPEN transaction on the PRIMARY DataSource. `null` otherwise (no transaction, a
 * released runner, the replica, or no primary known), and then nothing is memoised.
 */
export function memoRunnerFor(manager: EntityManager, primary: DataSource | undefined): QueryRunner | null {
  const runner = manager.queryRunner;
  if (runner && (runner.isReleased || !runner.isTransactionActive)) memo.delete(runner); // its transaction is over
  if (!primary || !runner || runner.isReleased || !runner.isTransactionActive) return null;
  if (manager.connection !== primary || runner.connection !== primary) return null;
  return runner;
}

export function readTxPermissions(runner: QueryRunner, identity: string): PermissionSet | undefined {
  if (!runner.isTransactionActive || runner.isReleased) {
    memo.delete(runner);
    return undefined;
  }
  return memo.get(runner)?.get(identity);
}

export function storeTxPermissions(runner: QueryRunner, identity: string, set: PermissionSet): void {
  subscribe(runner.connection);
  const byIdentity = memo.get(runner) ?? new Map<string, PermissionSet>();
  byIdentity.set(identity, set);
  memo.set(runner, byIdentity);
}

/** Commit / rollback (savepoints included) and ORM writes to the authority tables drop the transaction's memo. */
const subscriber = {
  afterTransactionCommit: (event: { queryRunner: QueryRunner }) => forgetTxPermissions(event.queryRunner),
  afterTransactionRollback: (event: { queryRunner: QueryRunner }) => forgetTxPermissions(event.queryRunner),
  afterInsert: (event: AuthorityWriteEvent) => forgetOnAuthorityWrite(event),
  afterUpdate: (event: AuthorityWriteEvent) => forgetOnAuthorityWrite(event),
  afterRemove: (event: AuthorityWriteEvent) => forgetOnAuthorityWrite(event),
  afterSoftRemove: (event: AuthorityWriteEvent) => forgetOnAuthorityWrite(event),
  afterRecover: (event: AuthorityWriteEvent) => forgetOnAuthorityWrite(event),
};

interface AuthorityWriteEvent {
  queryRunner: QueryRunner;
  metadata?: { tableName?: string };
}

function forgetOnAuthorityWrite(event: AuthorityWriteEvent): void {
  // An event without metadata is treated as a possible authority write (fail towards re-reading, never towards reuse).
  const table = event.metadata?.tableName;
  if (table === undefined || AUTHORITY_TABLES.has(table)) forgetTxPermissions(event.queryRunner);
}

function subscribe(connection: DataSource): void {
  if (subscribedTo.has(connection)) return;
  subscribedTo.add(connection);
  if (!connection.subscribers.includes(subscriber as never)) connection.subscribers.push(subscriber as never);
}

function isQueryRunner(value: unknown): value is QueryRunner {
  // An EntityManager has no `isTransactionActive`; a QueryRunner has it and its own `manager`.
  return typeof value === 'object' && value !== null && 'isTransactionActive' in value && 'manager' in value;
}

/** Tests only: whether this runner currently holds a memo. */
export function hasTxPermissionMemo(runner: QueryRunner | undefined): boolean {
  return runner ? memo.has(runner) : false;
}

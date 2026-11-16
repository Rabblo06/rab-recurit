import { EntityManager } from 'typeorm';

/**
 * The one definition of "is this member invitation still live?", shared by the API (`MemberInvitationService.loadLive`,
 * used by resolve / accept / accept-with-provider) and the Worker's pre-send revalidation (`email-send.processor.ts`).
 * Both callers decide with these two functions, so the rule cannot drift between "may this email be sent?" and "may
 * this link be accepted?" again (security finding S-W1: the Worker's copy had lost the workspace-active condition, so
 * an invitation email still went out after its workspace was suspended or archived).
 *
 * A live invitation is: not accepted, not revoked, not superseded, not expired (`expires_at <= now()` counts as expired,
 * decided in SQL with database time), its organisation is not suspended, and its workspace exists and is `active`.
 * Anything else — including a workspace or organisation row the caller cannot see under RLS — is not live (fail closed).
 *
 * Token/row matching (token hash, outbox row scope, latest email) stays with each caller: those are properties of how
 * the invitation was reached, not of whether it is live.
 */

/** A plain lower-case SQL identifier: the only text `memberInvitationExpiredSql` will ever put into SQL. */
const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL expression for the expiry boundary, evaluated against a `core.member_invitation` row (alias optional). The alias
 * is spliced into SQL text, so it must be a plain identifier: anything else (quotes, dots, spaces, an empty string)
 * throws instead of being interpolated.
 */
export function memberInvitationExpiredSql(alias?: string): string {
  if (alias === undefined) return '(expires_at <= now())';
  if (!SQL_ALIAS.test(alias)) throw new Error('memberInvitationExpiredSql: alias must be a plain SQL identifier.');
  return `(${alias}.expires_at <= now())`;
}

export type MemberInvitationStateFailure = 'accepted' | 'revoked' | 'superseded' | 'expired';

/**
 * The invitation row's own state. `is_expired` must come from `memberInvitationExpiredSql` (database time); a row
 * whose expiry was not computed (`undefined`/`null`) is treated as expired — fail closed, never live by omission.
 */
export function memberInvitationStateFailure(row: {
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
  superseded_at: Date | string | null;
  is_expired?: boolean | null;
}): MemberInvitationStateFailure | null {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (row.superseded_at) return 'superseded';
  if (row.is_expired !== false) return 'expired';
  return null;
}

export type MemberInvitationParentFailure = 'organisation_suspended' | 'workspace_inactive';

/**
 * The invitation's organisation and workspace. Run under a context that can see both rows (the invitation's own
 * organisation, with its workspace bound): a row hidden by RLS reads as missing and is treated as not live.
 */
export async function memberInvitationParentFailure(
  manager: EntityManager,
  organisationId: string,
  workspaceId: string | null,
): Promise<MemberInvitationParentFailure | null> {
  const [org] = await manager.query<Array<{ suspended_at: Date | string | null }>>(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [organisationId]);
  if (!org || org.suspended_at) return 'organisation_suspended';
  if (!workspaceId) return 'workspace_inactive';
  const [ws] = await manager.query<Array<{ status: string }>>(`SELECT status FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
  if (!ws || ws.status !== 'active') return 'workspace_inactive';
  return null;
}

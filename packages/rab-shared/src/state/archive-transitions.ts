import { TransitionTable } from './assert-transition';

/**
 * Wave 5 — archive lifecycle of the reference/master records that may be archived (soft-deleted) instead of deleted:
 * venue, job role, staff profile (leaver), manager profile and DRAFT shifts. Stored as `archived_at`/`archived_by`
 * (ArchiveAndSearchSchema1786719920000); the state is derived from `archived_at`, never accepted from a client.
 * Mutations are the named actions `archiveX` / `restoreX`; services call `assertTransition(ARCHIVE_TRANSITIONS, …)` so
 * archiving an archived record (or restoring an active one) is a 409, never a silent no-op.
 *
 * Never used for payroll records, payroll runs/lines, payslips, attendance (+corrections), shift reports or audit_log —
 * those are retained evidence and have no archive/delete path at all.
 */
export const ArchiveState = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const;
export type ArchiveStateType = (typeof ArchiveState)[keyof typeof ArchiveState];

export const ARCHIVE_TRANSITIONS: TransitionTable<ArchiveStateType> = {
  [ArchiveState.ACTIVE]: [ArchiveState.ARCHIVED],
  [ArchiveState.ARCHIVED]: [ArchiveState.ACTIVE],
};

/** The archive state of a row from its `archived_at` column (null/undefined ⇒ active). */
export function archiveStateOf(archivedAt: Date | string | null | undefined): ArchiveStateType {
  return archivedAt ? ArchiveState.ARCHIVED : ArchiveState.ACTIVE;
}

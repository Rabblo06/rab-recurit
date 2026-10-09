import { EntityManager } from 'typeorm';

/**
 * HWS backfill, Part 15. `core.user_note` has no `workspace_id` column at all (the legacy table
 * predates the Private Workspace model entirely); the physical V1 `user_note` requires
 * `workspace_id NOT NULL`. There is no column to copy — every legacy row's workspace must be
 * DERIVED, deterministically, from trusted core data, never guessed and never defaulted.
 *
 * The authoritative relationship: a note's SUBJECT (`subject_user_id`) is the person it's about —
 * a Staff detail panel's note or a Manager detail panel's note — and that subject's own profile
 * already carries the workspace they belong to (`staff_profile.workspace_id` or
 * `manager_profile.workspace_id`). A user is structurally either a Staff member or a Manager, never
 * both (confirmed by this codebase's own onboarding paths — no flow ever creates both profile types
 * for the same `user_id`), so looking up both and finding at most one match is a correctness check,
 * not an assumption.
 *
 * A row maps cleanly only when:
 *   - exactly one of {staff_profile, manager_profile} has a row for `subject_user_id`, AND
 *   - that row's own `workspace_id` is itself non-null (an unbound legacy profile has nothing
 *     trustworthy to lend the note — assigning it the CALLER's workspace, or any other guess,
 *     would be exactly the "assign it arbitrarily" Part 15 forbids).
 * Anything else returns `null` (BLOCKED) — the caller must refuse that workspace's `user_note`
 * table rather than guess.
 */
export type UserNoteMappingResult =
  | { readonly ok: true; readonly workspaceId: string }
  | { readonly ok: false; readonly reason: 'no-profile' | 'ambiguous-profile' | 'profile-unbound' };

export async function resolveUserNoteWorkspace(manager: EntityManager, subjectUserId: string): Promise<UserNoteMappingResult> {
  const [staffRow, managerRow] = await Promise.all([
    manager.query<Array<{ workspace_id: string | null }>>(`SELECT workspace_id FROM core.staff_profile WHERE user_id = $1`, [subjectUserId]),
    manager.query<Array<{ workspace_id: string | null }>>(`SELECT workspace_id FROM core.manager_profile WHERE user_id = $1`, [subjectUserId]),
  ]);

  const candidates = [...staffRow, ...managerRow];
  if (candidates.length === 0) return { ok: false, reason: 'no-profile' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous-profile' };

  const workspaceId = candidates[0]!.workspace_id;
  if (!workspaceId) return { ok: false, reason: 'profile-unbound' };
  return { ok: true, workspaceId };
}

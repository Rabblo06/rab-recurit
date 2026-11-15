import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * Security review L3 (owner decision 0g): a mutation of another person's account row-locks that account first and
 * re-checks that it is not soft-deleted. UserDeletionService locks the same row FOR UPDATE, so a delete and, say, a
 * reactivate serialise: whichever commits first wins, and the loser sees the committed state (READ COMMITTED re-checks
 * `deleted_at IS NULL` on the locked row version) — a reactivation, rename or e-mail change can never land on a row that
 * was deleted (or erased) a moment earlier. Not found → the caller's own 404 message (never a 403: no existence leak).
 */
export async function lockLiveUser(manager: EntityManager, userId: string, notFoundMessage: string): Promise<void> {
  const rows = await manager.query<Array<{ id: string }>>(`SELECT id FROM core."user" WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new NotFoundException(notFoundMessage);
}

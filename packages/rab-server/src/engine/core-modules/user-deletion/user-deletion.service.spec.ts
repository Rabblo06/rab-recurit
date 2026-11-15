import { QueryFailedError } from 'typeorm';

import { hardDeleteFallbackReason } from './user-deletion.service';

/**
 * Owner 0g / security review: which failures of an invite's hard-delete attempt fall back to a soft delete (the savepoint is
 * rolled back) and which abort the whole transaction. Database-free.
 */
const dbError = (fields: { code: string; constraint?: string; table?: string }): QueryFailedError =>
  new QueryFailedError('DELETE FROM "core"."user" WHERE "id" = $1', [], Object.assign(new Error('driver error'), fields));

describe('hardDeleteFallbackReason', () => {
  it('a foreign-key refusal (23503) falls back, naming only the constraint and table', () => {
    expect(hardDeleteFallbackReason(dbError({ code: '23503', constraint: 'shift_approved_by_fkey', table: 'shift' }))).toBe('foreign_key:shift_approved_by_fkey:shift');
  });

  it('lock-table exhaustion (53200, "out of shared memory") falls back', () => {
    expect(hardDeleteFallbackReason(dbError({ code: '53200' }))).toBe('locks:53200');
  });

  it('a lock timeout (55P03) falls back', () => {
    expect(hardDeleteFallbackReason(dbError({ code: '55P03' }))).toBe('locks:55P03');
  });

  it('anything else is a genuine error that must abort the transaction (null): RLS refusal, serialization, unique, cancel', () => {
    for (const code of ['42501', '40001', '23505', '57014']) expect(hardDeleteFallbackReason(dbError({ code }))).toBeNull();
    expect(hardDeleteFallbackReason(new Error('boom'))).toBeNull();
    expect(hardDeleteFallbackReason(undefined)).toBeNull();
  });
});

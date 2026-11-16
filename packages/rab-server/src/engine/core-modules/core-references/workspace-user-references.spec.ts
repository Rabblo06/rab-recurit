import { userReferenceColumns } from './workspace-user-references';

/**
 * Security review L-2: the former ON DELETE action of every dropped workspace → core."user" foreign key, pinned. The hard-delete
 * paths (UserDeletionService, the Worker invite clean-up) delete exactly the CASCADE rows, clear exactly the SET NULL columns and
 * refuse on any RESTRICT column; a change to this classification is a security change.
 */
describe('userReferenceColumns (Part D 0a)', () => {
  const byAction = (action: string) =>
    userReferenceColumns()
      .filter((c) => c.action === action)
      .map((c) => `${c.table}.${c.column}`)
      .sort();

  it('31 user columns: 2 CASCADE, 6 SET NULL, 23 RESTRICT', () => {
    expect(userReferenceColumns()).toHaveLength(31);
    expect(byAction('cascade')).toEqual(['staff_profile.user_id', 'user_note.subject_user_id']);
    expect(byAction('set-null')).toEqual([
      'job_offer.created_by',
      'replacement_request.approved_by',
      'replacement_request.notified_user_id',
      'replacement_request.rejected_by',
      'staff_profile.created_by',
      'user_note.author_user_id',
    ]);
    expect(byAction('restrict')).toHaveLength(23);
  });

  it('every RESTRICT column is a former no-ON-DELETE reference (never a CASCADE or SET NULL one)', () => {
    const restrict = new Set(byAction('restrict'));
    for (const c of [...byAction('cascade'), ...byAction('set-null')]) expect(restrict.has(c)).toBe(false);
    expect(restrict.has('payroll_record.approved_by')).toBe(true);
    expect(restrict.has('shift.approved_by')).toBe(true);
  });
});

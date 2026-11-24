import { CORE_CORRECTION_FK_STATE_SQL, correctionAttendanceFkSql, correctionFkProblems } from './attendance-correction-evidence-restrict-sql';

/** Owner decision 46 (DRAFT SQL): attendance_correction.attendance_id ON DELETE RESTRICT, statically. */
describe('attendance_correction evidence RESTRICT', () => {
  const ok = { deltype: 'r', updtype: 'a', validated: true, parent_ok: true, cols: ['attendance_id'] };

  it('one ALTER TABLE: drop and re-add the same constraint with only the delete action changed', () => {
    expect(correctionAttendanceFkSql('core', 'RESTRICT')).toBe(
      'ALTER TABLE "core".attendance_correction\n  DROP CONSTRAINT attendance_correction_attendance_id_fkey,\n  ADD CONSTRAINT attendance_correction_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES "core".attendance(id) ON DELETE RESTRICT',
    );
    expect(correctionAttendanceFkSql('core', 'CASCADE')).toBe(correctionAttendanceFkSql('core', 'RESTRICT').replace('ON DELETE RESTRICT', 'ON DELETE CASCADE'));
    expect(() => correctionAttendanceFkSql('public', 'RESTRICT')).toThrow('Invalid workspace schema');
    expect(() => correctionAttendanceFkSql('core', 'SET NULL' as never)).toThrow('Invalid delete action');
  });

  it('the end-state check accepts exactly the expected constraint', () => {
    expect(correctionFkProblems(ok, 'r')).toEqual([]);
    expect(correctionFkProblems({ ...ok, deltype: 'c' }, 'r')).toHaveLength(1);
    expect(correctionFkProblems({ ...ok, deltype: 'c' }, 'c')).toEqual([]);
    expect(correctionFkProblems({ ...ok, validated: false }, 'r')).toHaveLength(1);
    expect(correctionFkProblems({ ...ok, cols: ['other'] }, 'r')).toHaveLength(1);
    expect(correctionFkProblems(undefined, 'r')).toHaveLength(1);
    expect(CORE_CORRECTION_FK_STATE_SQL).toMatch(/^SELECT /);
  });
});

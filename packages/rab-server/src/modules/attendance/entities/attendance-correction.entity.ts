import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per manager correction to an `Attendance` record (Part 42-44).
 * A first-class table, not only a free-form `AuditService.record(...)`
 * `metadata` blob — so the Report UI can query "was this row corrected"
 * directly and cheaply, and so `field`/`oldValue`/`newValue`/`reason` are
 * real, typed columns rather than opaque JSON. An audit-log row is still
 * written alongside every insert here (`AuditAction.ATTENDANCE_CORRECTED`)
 * — this table is the queryable business record, the audit log is the
 * immutable trail; neither replaces the other.
 */
@Entity({ name: 'attendance_correction' })
export class AttendanceCorrection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @Column({ name: 'attendance_id' })
  attendanceId!: string;

  /** `'clockInAt' | 'clockOutAt' | 'breakMinutes'` — see `CorrectAttendanceDto`. */
  @Column({ type: 'text' })
  field!: string;

  @Column({ name: 'old_value', type: 'text' })
  oldValue!: string;

  @Column({ name: 'new_value', type: 'text' })
  newValue!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'corrected_by' })
  correctedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

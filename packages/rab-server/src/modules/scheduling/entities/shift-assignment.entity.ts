import { ShiftAssignmentStatus, ShiftAssignmentStatusType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

@Entity({ name: 'shift_assignment' })
export class ShiftAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'shift_id' })
  shiftId!: string;

  @Column({ name: 'staff_profile_id' })
  staffProfileId!: string;

  @Column({ type: 'text', default: ShiftAssignmentStatus.OFFERED })
  status!: ShiftAssignmentStatusType;

  @Column({ name: 'pay_rate_snapshot_pence', type: 'bigint', transformer: bigintAsNumber })
  payRateSnapshotPence!: number;

  @Column({ name: 'assigned_by', nullable: true })
  assignedBy?: string;

  /** Private Workspace migration — inherited from the parent Shift's workspace at creation. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date;

  // Canonical individual scheduled window, also used by the GiST exclusion
  // constraint. Read through effectiveAssignmentTime, not the parent shift.
  @Column({ type: 'tstzrange' })
  period!: string;

  @Column({ name: 'break_minutes', type: 'integer', nullable: true })
  breakMinutes?: number | null;

  /**
   * Check In (arrival evidence, NOT worked time — never payroll input). Rollout rule (migration 1786719450000): false
   * for every booking that existed before Check In shipped (old flow kept), DB default true for every later booking —
   * Clock In then requires `checkedInAt`. Written only by `AttendanceService.checkIn` (server time).
   */
  @Column({ name: 'check_in_required', type: 'boolean', default: true })
  checkInRequired!: boolean;

  @Column({ name: 'checked_in_at', type: 'timestamptz', nullable: true })
  checkedInAt?: Date | null;

  /** `CheckInSource` ('staff' | 'qr'). */
  @Column({ name: 'check_in_source', type: 'text', nullable: true })
  checkInSource?: string | null;

  @Column({ name: 'check_in_location_verified', type: 'boolean', nullable: true })
  checkInLocationVerified?: boolean | null;

  @Column({ name: 'check_in_distance_m', type: 'integer', nullable: true })
  checkInDistanceM?: number | null;

  @Column({ name: 'check_in_accuracy_m', type: 'integer', nullable: true })
  checkInAccuracyM?: number | null;

  /** Device capture time of the check-in fix — a clock-in fix must be strictly newer (replay guard). */
  @Column({ name: 'check_in_captured_at', type: 'timestamptz', nullable: true })
  checkInCapturedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

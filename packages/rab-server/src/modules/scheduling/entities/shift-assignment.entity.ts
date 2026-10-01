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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

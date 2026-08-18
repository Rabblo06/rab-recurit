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

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date;

  // Raw Postgres range literal (see ../utils/tstzrange.ts) — not modelled
  // as a JS Date pair because nothing in the app reads it back; it exists
  // only for the GiST exclusion constraint (SchedulingSchema migration) to
  // enforce "no double-booking" at the database level.
  @Column({ type: 'tstzrange' })
  period!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

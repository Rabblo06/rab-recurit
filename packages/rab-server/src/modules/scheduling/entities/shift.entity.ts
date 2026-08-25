import { ShiftStatus, ShiftStatusType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

@Entity({ name: 'shift' })
export class Shift {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'venue_id' })
  venueId!: string;

  @Column({ name: 'job_role_id' })
  jobRoleId!: string;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt!: Date;

  @Column({ name: 'break_minutes', default: 0 })
  breakMinutes!: number;

  @Column({ name: 'required_count' })
  requiredCount!: number;

  @Column({ name: 'filled_count', default: 0 })
  filledCount!: number;

  @Column({ name: 'pay_rate_pence', type: 'bigint', transformer: bigintAsNumber })
  payRatePence!: number;

  @Column({ name: 'charge_rate_pence', type: 'bigint', default: 0, transformer: bigintAsNumber })
  chargeRatePence!: number;

  @Column({ nullable: true })
  notes?: string;

  /** Snapshotted from the venue at creation, freely editable per-shift afterward — see ShiftAddressColumn1786666400000. */
  @Column({ nullable: true })
  address?: string;

  @Column({ type: 'text', default: ShiftStatus.DRAFT })
  status!: ShiftStatusType;

  @Column({ name: 'recurrence_group_id', nullable: true })
  recurrenceGroupId?: string;

  @Column({ name: 'created_by' })
  createdBy!: string;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Column({ name: 'cancelled_reason', nullable: true })
  cancelledReason?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

import { EmploymentStatus, EmploymentStatusType } from '@rab/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';
import { User } from '../../identity/entities';

@Entity({ name: 'staff_profile' })
export class StaffProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'staff_ref' })
  staffRef!: string;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth?: string;

  @Column({ name: 'employment_status', type: 'text', default: EmploymentStatus.PENDING_COMPLIANCE })
  employmentStatus!: EmploymentStatusType;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate?: string;

  @Column({ name: 'default_pay_rate_pence', type: 'bigint', default: 0, transformer: bigintAsNumber })
  defaultPayRatePence!: number;

  @Column({ nullable: true })
  notes?: string;

  // The manager whose private scope this Staff profile belongs to — NULL
  // for profiles that predate ownership tracking (see
  // ResourceOwnershipSchema1786666700000's doc comment: unrecoverable,
  // never guessed). A NULL owner is visible to the platform admin only.
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

/**
 * A staff member's own pay rate for one job role over an effective period (architecture §1 A6 "staff role rate";
 * StaffRoleRateSchema1786722210000). A `core` table, not a workspace table (see core/staff-role-rate-sql.ts): it declares
 * `schema: 'core'` (hws-startup-guard check 4) and carries organisation_id + workspace_id, both bound by RLS.
 * `staffProfileId` and `jobRoleId` name workspace rows by id only (no foreign key); StaffRoleRateService proves both are in
 * the caller's scope on every write.
 */
@Entity({ name: 'staff_role_rate', schema: 'core' })
export class StaffRoleRate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'workspace_id' })
  workspaceId!: string;

  @Column({ name: 'staff_profile_id' })
  staffProfileId!: string;

  @Column({ name: 'job_role_id' })
  jobRoleId!: string;

  @Column({
    name: 'pay_rate_pence',
    type: 'bigint',
    transformer: bigintAsNumber,
  })
  payRatePence!: number;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo!: string | null;

  @Column({ name: 'created_by' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

@Entity({ name: 'venue_role_rate' })
export class VenueRoleRate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'venue_id' })
  venueId!: string;

  @Column({ name: 'job_role_id' })
  jobRoleId!: string;

  /** Private Workspace migration — inherited from the parent Venue's workspace. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @Column({ name: 'pay_rate_pence', type: 'bigint', transformer: bigintAsNumber })
  payRatePence!: number;

  @Column({ name: 'charge_rate_pence', type: 'bigint', default: 0, transformer: bigintAsNumber })
  chargeRatePence!: number;

  @Column({ name: 'overtime_multiplier', type: 'numeric', precision: 3, scale: 2, default: 1.0 })
  overtimeMultiplier!: number;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

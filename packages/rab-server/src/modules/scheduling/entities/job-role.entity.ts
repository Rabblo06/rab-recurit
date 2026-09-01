import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

@Entity({ name: 'job_role' })
export class JobRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column()
  name!: string;

  @Column({ name: 'default_rate_pence', type: 'bigint', default: 0, transformer: bigintAsNumber })
  defaultRatePence!: number;

  /** Nullable — same "never guess ownership" precedent as `Venue.createdBy`; existing rows have no recoverable creator. */
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  /** Private Workspace migration — trusted server-side value, nullable until every Manager has completed onboarding. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

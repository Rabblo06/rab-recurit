import { OrganisationMemberStatusType } from '@rab/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Organisation } from './organisation.entity';
import { User } from './user.entity';

/**
 * A User's membership inside one Organisation — Increment 1 of the
 * User/membership decoupling. Purely additive and not read by any query
 * yet: `StaffProfile.userId`, `ManagerProfile.userId`, `UserRole.userId`
 * and `AuthContext.userId` all still resolve against `User` directly.
 * Populated 1:1 with `User` going forward (StaffService/ManagerService/
 * SeedCommand insert one alongside every new User) and backfilled for
 * every user that predates it, so a later increment's cutover has a
 * complete table to point at rather than another backfill to write.
 */
@Entity({ name: 'organisation_member' })
@Index(['userId', 'organisationId'], { unique: true })
export class OrganisationMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'text', default: 'active' })
  status!: OrganisationMemberStatusType;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

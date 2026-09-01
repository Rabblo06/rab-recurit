import { ManagerType, ManagerTypeType } from '@rab/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../identity/entities';

@Entity({ name: 'manager_profile' })
export class ManagerProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'text', default: ManagerType.INTERNAL })
  type!: ManagerTypeType;

  @Column({ name: 'job_title', nullable: true })
  jobTitle?: string;

  /**
   * Private Workspace migration. For `type: 'internal'`, this Manager's OWN
   * workspace (`manager_workspace.owner_user_id = user_id`) — stamped at
   * creation. For `type: 'venue'`/`'ceo'`, this is membership, not
   * ownership, and isn't resolved at creation time yet — see the migration
   * plan's own flagged design blocker on CEO/Venue-Manager workspace
   * assignment.
   */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

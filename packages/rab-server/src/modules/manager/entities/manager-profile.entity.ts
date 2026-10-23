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

@Entity({ name: 'manager_profile', schema: 'core' })
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

  /**
   * P2.9 gap review, item 2 — marks the ONE profile that is this organisation's bootstrap
   * "Initial Manager" slot, distinct from any number of ordinary additional Internal Managers
   * (created via the unmodified `POST /managers` flow, which never sets this). Set exactly once,
   * server-side, immediately after `OrganisationOnboardingService.inviteInitialManager`'s own
   * `createWithin()` call — never a client-settable DTO field. Enforced unique per organisation
   * (while `supersededAt IS NULL`) by `manager_profile_one_current_initial_manager`
   * (InitialManagerOnboardingSlot1786713000000).
   */
  @Column({ name: 'is_initial_manager', type: 'boolean', default: false })
  isInitialManager!: boolean;

  /**
   * Set only by the Initial Manager replacement flow, on a never-activated profile whose
   * invitation has genuinely exhausted recovery (see `OrganisationOnboardingService
   * .replaceInitialManager`). The row is NEVER deleted — this marks history, nothing more; the
   * partial unique index above treats a superseded row as no longer occupying the slot.
   */
  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt?: Date | null;

  /**
   * Wave 5 archive (ArchiveAndSearchSchema1786719920000). Written ONLY by the named archive/restore actions in the
   * owning service (never by create/update: no DTO declares these, so a client sending them gets a 400). Archived rows
   * are excluded from LISTS and search by default but stay readable in history/FK reads (shifts, payslips, attendance).
   * `archivedBy` is a historical user id (no FK), like audit_log's identifiers.
   */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  @Column({ name: 'archived_by', type: 'uuid', nullable: true })
  archivedBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

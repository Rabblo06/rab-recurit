import type { StaffTimeOffStatusType } from '@rab/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Date-specific staff time off (owner decisions 42, 48; StaffTimeOffSchema1786722230000). A `core` table, not a workspace
 * table (decision 48; see core/staff-time-off-sql.ts): it declares `schema: 'core'` (hws-startup-guard check 4) and carries
 * organisation_id + workspace_id, both bound by RLS. `staffProfileId` names a workspace row by id only (no foreign key);
 * `staffUserId` is that profile's user id, set by StaffTimeOffService from the profile, never from a client.
 */
@Entity({ name: 'staff_time_off', schema: 'core' })
export class StaffTimeOff {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'workspace_id' })
  workspaceId!: string;

  @Column({ name: 'staff_profile_id' })
  staffProfileId!: string;

  @Column({ name: 'staff_user_id' })
  staffUserId!: string;

  @Column({ name: 'starts_on', type: 'date' })
  startsOn!: string;

  @Column({ name: 'ends_on', type: 'date' })
  endsOn!: string;

  @Column({ type: 'text' })
  status!: StaffTimeOffStatusType;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'requested_by' })
  requestedBy!: string;

  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ name: 'decline_reason', type: 'text', nullable: true })
  declineReason!: string | null;

  @Column({ name: 'cancelled_by', type: 'uuid', nullable: true })
  cancelledBy!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

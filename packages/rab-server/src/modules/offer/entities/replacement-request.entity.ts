import { ReplacementCandidateSnapshot, ReplacementRequestStatus, ReplacementRequestStatusType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// Status/candidate-snapshot types live in `@rab/shared` (matching every
// other domain status enum's home, e.g. `OfferStatus`) — deliberately NOT
// co-defined in this file: this file's barrel (`entities/index.ts`) is
// spread into `core.datasource.ts`'s `entities: [...Object.values(...)]`,
// so anything exported from here that isn't an `@Entity()` class would be
// handed to TypeORM as if it were one.

@Entity({ name: 'replacement_request' })
export class ReplacementRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @Column({ name: 'shift_id' })
  shiftId!: string;

  @Column({ name: 'declined_shift_assignment_id' })
  declinedShiftAssignmentId!: string;

  @Column({ name: 'declined_offer_id', nullable: true })
  declinedOfferId?: string;

  @Column({ type: 'text', default: ReplacementRequestStatus.AWAITING_APPROVAL })
  status!: ReplacementRequestStatusType;

  /** Point-in-time only, for the manager's review UI — never trusted as authorization; approval re-validates fresh. */
  @Column({ name: 'candidates_snapshot', type: 'jsonb', default: [] })
  candidatesSnapshot!: ReplacementCandidateSnapshot[];

  @Column({ name: 'selected_staff_profile_id', nullable: true })
  selectedStaffProfileId?: string;

  @Column({ name: 'resulting_offer_id', nullable: true })
  resultingOfferId?: string;

  @Column({ name: 'approved_by', nullable: true })
  approvedBy?: string;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Column({ name: 'rejected_by', nullable: true })
  rejectedBy?: string;

  @Column({ name: 'rejected_at', type: 'timestamptz', nullable: true })
  rejectedAt?: Date;

  /** Who the worker notified — lets the API surface "already sent to X" without a second lookup. */
  @Column({ name: 'notified_user_id', nullable: true })
  notifiedUserId?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

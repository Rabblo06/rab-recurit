import { OfferStatus, OfferStatusType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

@Entity({ name: 'job_offer' })
export class JobOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'shift_assignment_id' })
  shiftAssignmentId!: string;

  @Column({ name: 'staff_profile_id' })
  staffProfileId!: string;

  /** Every send stamps one — "batch of 1" and "batch of 12" are the same code path (OfferService.send/sendBulk). */
  @Column({ name: 'offer_batch_id', nullable: true })
  offerBatchId?: string;

  @Column({ type: 'text', default: OfferStatus.PENDING })
  status!: OfferStatusType;

  @Column({ name: 'sent_at', type: 'timestamptz' })
  sentAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt?: Date;

  @Column({ name: 'decline_reason', nullable: true })
  declineReason?: string;

  @Column({ name: 'staff_accepted_at', type: 'timestamptz', nullable: true })
  staffAcceptedAt?: Date;

  @Column({ name: 'manager_confirmed_at', type: 'timestamptz', nullable: true })
  managerConfirmedAt?: Date;

  @Column({ name: 'manager_rejected_at', type: 'timestamptz', nullable: true })
  managerRejectedAt?: Date;

  @Column({ name: 'confirmed_by', nullable: true })
  confirmedBy?: string;

  @Column({ name: 'rejected_by', nullable: true })
  rejectedBy?: string;

  @Column({ name: 'rejection_reason', nullable: true })
  rejectionReason?: string;

  @Column({ name: 'estimated_pay_pence', type: 'bigint', transformer: bigintAsNumber })
  estimatedPayPence!: number;

  // The manager whose private scope this offer belongs to (who sent it) —
  // NULL only for offers that predate ownership tracking, backfilled from
  // audit_log where recoverable (ResourceOwnershipSchema1786666700000).
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  /** Private Workspace migration — inherited from the parent ShiftAssignment's workspace at creation. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

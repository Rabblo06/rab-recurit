import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per (notification, device) — a single `Notification` fans out to however many of that
 * user's devices are currently `active` at creation time (see `PushDeliveryService.createForNotification`).
 * Mirrors `core.email_outbox`'s claim/lease shape (`processingToken`/`providerCallStartedAt`/
 * `dispatchGeneration`) rather than `core.realtime_event`'s batch-scan shape — see the migration's
 * own doc comment for why.
 *
 * `acceptedAt` — the provider ACCEPTED the message for delivery; this is never evidence the
 * device displayed it, and nothing in this codebase ever treats it as such (Stage 6 §3's own
 * explicit warning).
 */
export type PushDeliveryStatusType = 'PENDING' | 'PROCESSING' | 'ACCEPTED' | 'RETRY' | 'FAILED' | 'CANCELLED';

@Entity({ name: 'push_delivery', schema: 'core' })
@Index(['status', 'createdAt'])
export class PushDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'notification_id' })
  notificationId!: string;

  @Column({ name: 'push_device_id' })
  pushDeviceId!: string;

  @Column({ type: 'text', default: 'PENDING' })
  status!: PushDeliveryStatusType;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'max_attempts', type: 'int', default: 5 })
  maxAttempts!: number;

  @Column({ name: 'processing_token', type: 'uuid', nullable: true })
  processingToken?: string | null;

  @Column({ name: 'provider_call_started_at', type: 'timestamptz', nullable: true })
  providerCallStartedAt?: Date | null;

  @Column({ name: 'dispatch_generation', type: 'int', default: 0 })
  dispatchGeneration!: number;

  @Column({ type: 'text', nullable: true })
  provider?: string | null;

  @Column({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId?: string | null;

  @Column({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode?: string | null;

  @Column({ name: 'last_error_message_sanitized', type: 'text', nullable: true })
  lastErrorMessageSanitized?: string | null;

  @Column({ name: 'queued_at', type: 'timestamptz', nullable: true })
  queuedAt?: Date | null;

  @Column({ name: 'processing_at', type: 'timestamptz', nullable: true })
  processingAt?: Date | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt?: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

import { EmailOutboxJobTypeType, EmailOutboxStatus, EmailOutboxStatusType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { AccountInvite } from './account-invite.entity';
import { PasswordResetToken } from './password-reset-token.entity';
import { User } from './user.entity';

// Deliberately NOT re-exported from here — `core.datasource.ts` builds its
// entity list via `Object.values(identityEntities)` over this whole
// barrel's exports, so a runtime const object (not a TypeORM entity class)
// re-exported alongside `EmailOutbox` would get swept into that list and
// break the DataSource config. Import `EmailOutboxJobType`/`EmailOutboxStatus`
// directly from `@rab/shared`, same as every other status enum in this app.

/**
 * The transactional outbox row — see the migration's own doc comment for
 * why this exists and what durability property it provides. `type: 'text'`
 * on `jobType`/`status` per this repo's own convention: `emitDecoratorMetadata`
 * can't reflect a string-union type alias, so TypeORM would otherwise infer
 * `Object` and reject the column (CLAUDE.md's resolved-gotchas note).
 */
@Entity({ name: 'email_outbox' })
@Index(['status', 'createdAt'])
export class EmailOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'job_type', type: 'text' })
  jobType!: EmailOutboxJobTypeType;

  @Column({ type: 'text', default: EmailOutboxStatus.PENDING })
  status!: EmailOutboxStatusType;

  @Column({ name: 'recipient_email', type: 'citext' })
  recipientEmail!: string;

  @Column({ name: 'target_user_id', nullable: true })
  targetUserId?: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'target_user_id' })
  targetUser?: User;

  // Re-validated by the worker immediately before sending — see A9/A10 in
  // the design: a revoked/superseded/accepted invite must never be mailed
  // just because a queued row referencing it still exists.
  @Column({ name: 'account_invite_id', nullable: true })
  accountInviteId?: string;

  @ManyToOne(() => AccountInvite, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'account_invite_id' })
  accountInvite?: AccountInvite;

  @Column({ name: 'password_reset_token_id', nullable: true })
  passwordResetTokenId?: string;

  @ManyToOne(() => PasswordResetToken, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'password_reset_token_id' })
  passwordResetToken?: PasswordResetToken;

  // Rendered ONCE, at commit time — never re-rendered by the worker. See
  // the migration's own doc comment for why re-rendering later would be
  // wrong, not just wasteful.
  @Column({ name: 'rendered_subject' })
  renderedSubject!: string;

  @Column({ name: 'rendered_html', type: 'text', nullable: true })
  renderedHtml?: string;

  @Column({ name: 'rendered_text', type: 'text', nullable: true })
  renderedText?: string;

  /**
   * A pre-shift roster or final Timesheet PDF (Parts 47/50) — the storage
   * key of a file already durably written by whichever worker job enqueued
   * this row. `email-send.processor.ts` reads it via `StorageService.read`
   * immediately before calling the provider's send function; never set by
   * anything outside the worker process, so there is no cross-container
   * storage-read concern for this column specifically (see
   * `ShiftReport`'s own doc comment).
   */
  @Column({ name: 'attachment_key', nullable: true })
  attachmentKey?: string;

  @Column({ name: 'attachment_filename', nullable: true })
  attachmentFilename?: string;

  @Column({ name: 'infrastructure_attempt_count', type: 'int', default: 0 })
  infrastructureAttemptCount!: number;

  @Column({ name: 'max_infrastructure_attempts', type: 'int', default: 5 })
  maxInfrastructureAttempts!: number;

  @Column({ type: 'text', nullable: true })
  provider?: string;

  @Column({ name: 'provider_message_id', nullable: true })
  providerMessageId?: string;

  @Column({ name: 'last_error_code', nullable: true })
  lastErrorCode?: string;

  @Column({ name: 'last_error_message_sanitized', type: 'text', nullable: true })
  lastErrorMessageSanitized?: string;

  @Column({ name: 'queued_at', type: 'timestamptz', nullable: true })
  queuedAt?: Date;

  @Column({ name: 'processing_at', type: 'timestamptz', nullable: true })
  processingAt?: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

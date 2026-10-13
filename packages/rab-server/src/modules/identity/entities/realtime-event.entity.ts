import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { Organisation } from './organisation.entity';
import { User } from './user.entity';

// NOT exported, deliberately — `core.datasource.ts` builds its entity list via
// `Object.values(identityEntities)` over this whole barrel's exports (see
// `EmailOutbox`'s own identical doc comment); a runtime const object re-exported
// alongside the entity class would get swept into that list and break the
// DataSource config. Local-only; the service layer (`realtime-event.service.ts`)
// defines its own separate, exported `RealtimeEventType` for event *types*.
const RealtimeEventStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  RETRY: 'retry',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
type RealtimeEventStatusType = (typeof RealtimeEventStatus)[keyof typeof RealtimeEventStatus];

/**
 * See the migration's (`RealtimeEventOutbox1786698000000`) doc comment for
 * why this is a separate table from `core.worker_event`, not a reuse of it.
 * `payload` is a thin, non-secret reference (ids only) — the delivery
 * consumer (a later stage) re-fetches full state over the existing REST
 * API; never put a password, token, MFA secret, bank detail, or anything
 * beyond what's needed to know "something changed, go re-fetch X" in here.
 */
@Entity({ name: 'realtime_event', schema: 'core' })
@Index(['status'])
export class RealtimeEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  /**
   * NULL = org-wide event (RLS treats NULL as "matches any workspace in the
   * org," never as exempt from isolation). Plain column, no `@ManyToOne` —
   * `ManagerWorkspace` lives in a different NestJS module
   * (`modules/manager-workspace`); the DB-level FK the migration creates is
   * enough, and avoids an identity→manager-workspace entity coupling this
   * codebase doesn't otherwise have.
   */
  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId?: string | null;

  /** NULL = broadcast to everyone with access to the scope above (org/workspace), not one specific person. */
  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'target_user_id' })
  targetUser?: User;

  /** Stable, deterministic per logical occurrence — cross-replica dedup authority via the UNIQUE constraint, never a SELECT-then-INSERT. */
  @Column({ name: 'event_key' })
  eventKey!: string;

  @Column({ name: 'event_type' })
  eventType!: string;

  @Column({ name: 'entity_type' })
  entityType!: string;

  @Column({ name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'jsonb', default: {} })
  payload!: Record<string, unknown>;

  @Column({ name: 'schema_version', type: 'int', default: 1 })
  schemaVersion!: number;

  @Column({ type: 'text', default: RealtimeEventStatus.PENDING })
  status!: RealtimeEventStatusType;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'max_attempts', type: 'int', default: 10 })
  maxAttempts!: number;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt?: Date | null;

  /** Fencing token for the current claim — a worker whose lease expired and was reclaimed no longer holds the current token and must never write completed/retry/failed with it. */
  @Column({ name: 'claim_token', type: 'uuid', nullable: true })
  claimToken?: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt?: Date | null;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt?: Date | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  @Column({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode?: string | null;

  @Column({ name: 'last_error_at', type: 'timestamptz', nullable: true })
  lastErrorAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

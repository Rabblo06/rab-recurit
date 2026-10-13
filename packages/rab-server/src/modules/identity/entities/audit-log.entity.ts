import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Insert-only (CLAUDE.md) — `REVOKE UPDATE, DELETE ... FROM rab_app` in the
 * same migration that creates this table (AccountLifecycleSchema), and no
 * update/delete route is ever added for it at the application layer
 * either. Never write a password or token value into `metadata`.
 *
 * `actorUserId`/`targetUserId` are immutable historical identifiers, not a
 * live foreign key (`AuditLogImmutableHistoricalIdentifiers1786692000000`
 * dropped the `ON DELETE SET NULL` FK that used to back them — Postgres
 * enforces that action with the referencing table's OWNER privileges, which
 * this table's insert-only lockdown deliberately revoked, making every
 * user deletion that ever touched the FK 500). A row's value here may
 * outlive the `core.user` row it once pointed to; callers reading these
 * columns (`AuditService.list`/`listForUser`'s `LEFT JOIN`) already treat a
 * non-matching id the same as a NULL one. `AuditService.record()` is the
 * only write path and validates both ids resolve to a real user at the
 * moment the event is recorded — that's the only "was this legitimate"
 * guarantee this column now has, since nothing re-validates it afterward.
 */
@Entity({ name: 'audit_log', schema: 'core' })
@Index(['organisationId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'actor_user_id', nullable: true })
  actorUserId?: string;

  @Column({ name: 'target_user_id', nullable: true })
  targetUserId?: string;

  /** Polymorphic target, e.g. `'offer'` + a `job_offer.id` — additive to `targetUserId`, which stays account-lifecycle-only. */
  @Column({ name: 'entity_type', nullable: true })
  entityType?: string;

  @Column({ name: 'entity_id', nullable: true })
  entityId?: string;

  @Column({ type: 'text' })
  action!: string;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

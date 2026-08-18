import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Insert-only (CLAUDE.md) — `REVOKE UPDATE, DELETE ... FROM rab_app` in the
 * same migration that creates this table (AccountLifecycleSchema), and no
 * update/delete route is ever added for it at the application layer
 * either. Never write a password or token value into `metadata`.
 */
@Entity({ name: 'audit_log' })
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

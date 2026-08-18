import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * RLS scopes by `organisation_id` only — the tenant-context session never
 * sets a per-user variable, only `core.current_org()` (see
 * TenantContextService). Ownership within an org (`user_id = caller`) is
 * enforced in `NotificationService`, the same way `OfferService.listMine`
 * already scopes to the caller's own staff profile in the service layer
 * rather than via RLS. `channel_state` is reserved for a future push-
 * delivery dispatcher — unused this pass, in-app/polling only.
 */
@Entity({ name: 'notification' })
@Index(['userId', 'readAt', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ name: 'related_entity_type', nullable: true })
  relatedEntityType?: string;

  @Column({ name: 'related_entity_id', nullable: true })
  relatedEntityId?: string;

  @Column({ name: 'channel_state', type: 'jsonb', default: {} })
  channelState!: Record<string, unknown>;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

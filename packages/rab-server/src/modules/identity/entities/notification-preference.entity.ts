import { NotificationTypeType } from '@rab/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { User } from './user.entity';

/**
 * Consulted by NotificationService.notify() before it inserts a row or
 * sends an email — a real gate, not a dead checkbox. `notificationType` is
 * CHECK-constrained (migration) to the real notify() call sites that exist
 * today, all in offer.service.ts.
 */
@Entity({ name: 'notification_preference' })
export class NotificationPreference {
  @PrimaryColumn({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @PrimaryColumn({ name: 'notification_type', type: 'text' })
  notificationType!: NotificationTypeType;

  @Column({ name: 'in_app_enabled', default: true })
  inAppEnabled!: boolean;

  @Column({ name: 'email_enabled', default: false })
  emailEnabled!: boolean;
}

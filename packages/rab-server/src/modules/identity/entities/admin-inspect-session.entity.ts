import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Organisation } from './organisation.entity';
import { User } from './user.entity';

/**
 * A server-side "Admin Inspect" session — the platform admin viewing the
 * app as another user would see it, for support/debugging. Deliberately
 * NOT embedded in the JWT (`AccessTokenService`'s payload stays the
 * minimal `{sub, org, roles, sid}` it's always been — see that service's
 * own docstring on why nothing extra is ever added there); this table is
 * the only place inspection state lives, looked up per-request by
 * `JwtAuthGuard` via the `X-Inspect-Session-Id` header, always re-verified
 * against the CALLING admin's own real, already-verified token identity —
 * never trusted from the header alone. Read-only: `PermissionGuard`
 * rejects any mutating request while a session is active, regardless of
 * the admin's own permissions (see `AuthContext.inspectedBy`).
 */
@Entity({ name: 'admin_inspect_session' })
@Index(['adminUserId', 'organisationId'])
export class AdminInspectSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ name: 'admin_user_id' })
  adminUserId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'admin_user_id' })
  adminUser?: User;

  @Column({ name: 'target_user_id' })
  targetUserId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'target_user_id' })
  targetUser?: User;

  @CreateDateColumn({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt?: Date;
}

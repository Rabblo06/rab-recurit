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
@Index(['adminUserId', 'legacyOrganisationId'])
export class AdminInspectSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Renamed from `organisation_id` by the Private Workspace migration's
   * `WorkspaceIdExpand` step — kept, not dropped or reinterpreted, since an
   * organisation UUID and a workspace UUID are different value spaces and
   * historical rows can't be silently repointed. Still written on every new
   * session (this migration hasn't cut writes over to `workspaceId` yet);
   * becomes purely historical once that happens.
   */
  @Column({ name: 'legacy_organisation_id' })
  legacyOrganisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'legacy_organisation_id' })
  legacyOrganisation?: Organisation;

  /** Nullable until the Workspace backfill step resolves it deterministically (or leaves it NULL). */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

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

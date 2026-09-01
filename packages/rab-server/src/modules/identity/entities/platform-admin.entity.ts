import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { User } from './user.entity';

/**
 * Stage 2A Phase 2 — genuinely platform-wide, not tenant-scoped: no
 * `organisationId`, no `workspaceId`. Replaces `PlatformAdminClaim`'s
 * retired "first user to claim their own org wins" semantics (org-scoped,
 * automatic) with an explicit grant/revoke model (`grantedBy`/`revokedBy`
 * always name a deliberate actor — `NULL` only for the one-time bootstrap
 * CLI grant, which has no authenticated actor by construction).
 *
 * `userId` is the primary key, not a unique index — a platform admin is a
 * single global fact about a user, not a per-organisation relationship.
 * Revocation sets `revokedAt`/`revokedBy` but never deletes the row (matches
 * the retired entity's own non-repromotion-by-accident precedent) so a
 * re-grant is always an explicit `UPDATE`, never a fresh `INSERT` racing
 * against history.
 *
 * Never grantable through the ordinary role/permission-override system —
 * see `PlatformAdminService`.
 */
@Entity({ name: 'platform_admin' })
export class PlatformAdmin {
  @PrimaryColumn({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @CreateDateColumn({ name: 'granted_at', type: 'timestamptz' })
  grantedAt!: Date;

  @Column({ name: 'granted_by', nullable: true })
  grantedBy?: string;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @Column({ name: 'revoked_by', nullable: true })
  revokedBy?: string;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from './user.entity';

/**
 * Backs the invitation-based account-activation flow — distinct from
 * `PasswordResetToken` (that entity has no per-user attempt-counting or
 * distinct-revocation shape; conflating the two would mix two different
 * lifecycles). `tokenHash` mirrors `PasswordResetToken`'s convention exactly
 * (SHA-256 of a `randomBytes(32)` raw token; the raw token is returned once
 * to the caller and never stored). Only ONE row per user is ever "active"
 * (`revokedAt IS NULL AND acceptedAt IS NULL`) — `AccountInviteService.issue`
 * revokes every prior active row before inserting a new one, same discipline
 * `PasswordResetTokenService.issue` already uses.
 */
@Entity({ name: 'account_invite' })
@Index(['userId'])
export class AccountInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'token_hash', unique: true })
  tokenHash!: string;

  // 1 = the initial invitation, 2 = first resend, 3 = second (final) resend.
  // Never incremented past 3 by the normal resend path — see
  // AccountInviteService.issue's own guard.
  @Column({ name: 'send_number', type: 'int' })
  sendNumber!: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt?: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  // Set only on the 3rd attempt's row, at the moment it's known to be final
  // (issued with sendNumber 3, or expired with no further resend possible)
  // — `expiresAt + 7 days`. The cleanup job never acts on a user before this
  // is both set and passed. Left null on attempt 1/2's rows (superseded by
  // the next issue() call before it would ever matter).
  @Column({ name: 'cleanup_at', type: 'timestamptz', nullable: true })
  cleanupAt?: Date;

  // The admin/manager who triggered this send — distinct from the eventual
  // activating user, who is always the account itself. Nullable only for
  // symmetry with other `createdBy`-style columns in this codebase that
  // predate ownership tracking; every row this feature ever writes sets it.
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

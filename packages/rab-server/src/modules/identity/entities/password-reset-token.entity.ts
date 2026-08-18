import { PasswordResetTokenPurposeType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from './user.entity';

/**
 * Opaque, hashed at rest — mirrors `RefreshToken`'s convention exactly
 * (SHA-256 of the raw token, raw token returned once and never stored).
 * Backs three flows off one mechanism: the initial-setup link sent on
 * account creation, a self-service forgot-password link, and an
 * admin-triggered reset — `purpose` is metadata for the audit trail, not a
 * different validation path.
 */
@Entity({ name: 'password_reset_token' })
@Index(['userId'])
export class PasswordResetToken {
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

  @Column({ type: 'text' })
  purpose!: PasswordResetTokenPurposeType;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

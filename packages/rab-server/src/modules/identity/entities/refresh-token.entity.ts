import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from './user.entity';

/**
 * Opaque, hashed at rest — the raw token never touches the database.
 * `familyId` links every token minted from one login through every
 * rotation; a replayed (already-`replacedBy`'d) token revokes the whole
 * family (rab-workforce-architecture.md §5.1).
 */
@Entity({ name: 'refresh_token' })
@Index(['userId', 'expiresAt'])
export class RefreshToken {
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

  @Column({ name: 'family_id' })
  familyId!: string;

  @Column({ name: 'device_id', nullable: true })
  deviceId?: string;

  @Column({ name: 'user_agent', nullable: true })
  userAgent?: string;

  @Column({ nullable: true })
  ip?: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @Column({ name: 'replaced_by', nullable: true })
  replacedBy?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

import { UserStatus, UserStatusType } from '@rab/shared';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Organisation } from './organisation.entity';

/**
 * One identity system for every role — see rab-workforce-architecture.md
 * §11. `passwordHash` is argon2id (§5.1); `totpSecretEncrypted` is
 * encrypted via SecretEncryptionService, never plaintext.
 */
@Entity({ name: 'user' })
@Index(['organisationId', 'email'], { unique: true, where: '"deleted_at" IS NULL' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ type: 'citext' })
  email!: string;

  // Nullable — a pending (INVITED) account created under the invitation
  // flow genuinely has no password yet; one is set for the first time at
  // activation. No fake/temporary hash is ever written in its place.
  @Column({ name: 'password_hash', select: false, nullable: true })
  passwordHash?: string;

  @Column({ name: 'first_name' })
  firstName!: string;

  @Column({ name: 'last_name' })
  lastName!: string;

  @Column({ nullable: true })
  phone?: string;

  // Plain text + a CHECK constraint in the migration (matching every other
  // status column in this schema), not a native Postgres ENUM type — see
  // rab-workforce-architecture.md §11. Valid values enforced at the DB
  // layer; `UserStatusType` is the compile-time mirror.
  @Column({ type: 'text', default: UserStatus.INVITED })
  status!: UserStatusType;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt?: Date;

  @Column({ name: 'totp_secret_encrypted', type: 'bytea', nullable: true, select: false })
  totpSecretEncrypted?: Buffer;

  @Column({ name: 'totp_enabled', default: false })
  totpEnabled!: boolean;

  // Forces the account through /auth/set-password before any other route
  // is reachable (MustResetPasswordGuard) — set true on creation, on an
  // admin-triggered reset, and after a forgot-password reset lands; never
  // set directly by a client request.
  @Column({ name: 'must_reset_password', default: false })
  mustResetPassword!: boolean;

  @Column({ name: 'avatar_key', nullable: true })
  avatarKey?: string;

  // Set once, at invitation-activation — proof the account holder received
  // and clicked the emailed link to this address. Never set any other way.
  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt?: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

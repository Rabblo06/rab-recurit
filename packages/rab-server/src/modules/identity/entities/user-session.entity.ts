import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';
import { User } from './user.entity';

/**
 * P1B — the first-class server-side session aggregate. See the owning migration
 * (`1786678000000-UserSession.ts`) for the full design rationale, RLS, and why `workspace_id`
 * is a snapshot, never authority.
 *
 * Canonical identity: `id` = the owning `RefreshToken` row's `familyId` = the JWT's `sid`
 * claim. Created exactly once per genuinely new login (`RefreshTokenService.issue()`, only
 * when no `familyExpiresAt` is passed through — a rotation always passes it, a new login
 * never does), never regenerated on rotation.
 */
@Entity({ name: 'user_session', schema: 'core' })
@Index(['userId', 'revokedAt'])
export class UserSession {
  /** No `@PrimaryGeneratedColumn` — this is always supplied explicitly by the caller (the same UUID as the refresh-token family id / JWT sid), never database-generated. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /** Snapshot only, taken at session creation — NEVER authorization authority. See the migration's own doc comment. */
  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId?: string | null;

  @Column({ name: 'application_target', type: 'text' })
  applicationTarget!: 'manager_web' | 'venue_manager_app' | 'staff_app';

  @Column({ name: 'auth_provider', type: 'text', nullable: true })
  authProvider?: 'password' | 'google' | 'microsoft' | null;

  /**
   * P1C.1B — Twenty-style opaque web session credential's hash. Deliberately NULL for every
   * session this checkpoint creates (see WebSessionCredentialAndAuthProvider1786680000000's own
   * doc comment) — no code path generates or writes a raw value yet. Immutable after creation
   * (core.enforce_user_session_mutation_invariants).
   */
  @Column({ name: 'web_session_token_hash', type: 'text', nullable: true })
  webSessionTokenHash?: string | null;

  /** Opaque, random, non-secret — never a hardware fingerprint. See `device-id.util.ts`. */
  @Column({ name: 'device_id', type: 'text', nullable: true })
  deviceId?: string | null;

  @Column({ name: 'device_name', type: 'text', nullable: true })
  deviceName?: string | null;

  @Column({ name: 'device_type', type: 'text', nullable: true })
  deviceType?: string | null;

  @Column({ type: 'text', nullable: true })
  platform?: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent?: string | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Bounded-write "real activity" timestamp — see `SessionValidityService`'s own doc comment for the throttling policy. */
  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  /** Copied once from the owning refresh-token family's own `familyExpiresAt` at creation — never recomputed. */
  @Column({ name: 'absolute_expires_at', type: 'timestamptz' })
  absoluteExpiresAt!: Date;

  /** Not enforced in P1B — reserved for P2 idle-timeout. */
  @Column({ name: 'idle_expires_at', type: 'timestamptz', nullable: true })
  idleExpiresAt?: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @Column({ name: 'revoked_reason', type: 'text', nullable: true })
  revokedReason?: string | null;

  @Column({ name: 'mfa_verified_at', type: 'timestamptz', nullable: true })
  mfaVerifiedAt?: Date | null;

  /** P1B scope only — this session's own revocation/mutation counter. The full cross-domain version-vector is P1D. */
  @Column({ name: 'security_version', type: 'bigint', transformer: bigintAsNumber })
  securityVersion!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

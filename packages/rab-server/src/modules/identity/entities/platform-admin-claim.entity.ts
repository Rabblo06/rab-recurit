import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Organisation } from './organisation.entity';
import { User } from './user.entity';

/**
 * The "first legitimate owner" mechanism. `organisationId` is the primary
 * key, not just a unique index — that's what makes `tryClaim()`'s
 * `INSERT ... ON CONFLICT (organisation_id) DO NOTHING` race-safe (exactly
 * one concurrent claim ever wins) AND non-repromotable (revocation sets
 * `revokedAt` but never deletes the row, so the PK permanently blocks any
 * later claim attempt for that organisation). Never grantable through the
 * ordinary role/permission-override system — see PlatformAdminService.
 */
@Entity({ name: 'platform_admin_claim' })
export class PlatformAdminClaim {
  @PrimaryColumn({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @CreateDateColumn({ name: 'claimed_at', type: 'timestamptz' })
  claimedAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @Column({ name: 'revoked_by', nullable: true })
  revokedBy?: string;
}

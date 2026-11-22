import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A pending, email-first invitation — intent only, never an identity. See
 * `MemberInvitationSchema1786715000000` for the full design and the database invariants. No `core.user`
 * exists for the recipient until `MemberInvitationService.accept` creates it from the recipient's own
 * name and password. Only the SHA-256 hash of the token is stored; the raw token lives only in the email.
 */
@Entity({ name: 'member_invitation', schema: 'core' })
export class MemberInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  /** The inviter's workspace (immutable UUID). The recipient joins this existing workspace. */
  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  /** Normalised (trimmed, lower-case) — enforced by a CHECK constraint, not only by the service. */
  @Column({ type: 'citext' })
  email!: string;

  /** A custom workspace-member role of the SAME workspace — guaranteed by the composite FK (role_id, workspace_id). */
  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @Column({ name: 'token_hash', type: 'text', select: false })
  tokenHash!: string;

  @Column({ name: 'send_count', type: 'int', default: 1 })
  sendCount!: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt!: Date;

  @Column({ name: 'invited_by', type: 'uuid', nullable: true })
  invitedBy!: string | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'accepted_user_id', type: 'uuid', nullable: true })
  acceptedUserId!: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revoked_by', type: 'uuid', nullable: true })
  revokedBy!: string | null;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

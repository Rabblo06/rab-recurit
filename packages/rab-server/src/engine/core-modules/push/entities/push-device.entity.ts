import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per (user, device) — `deviceId` is an opaque, client-generated, non-secret identifier.
 * `core.refresh_token`/`core.user_session` already carry an OPTIONAL `deviceId` column for this
 * same purpose, but nothing populates it today (no controller/DTO threads a client-supplied value
 * into it) — `rab-mobile`'s `PushDeviceStore` is the first real generator/persister of a device id
 * in this system (see its own doc comment for why push registration is the first feature that
 * actually needs one). A token refresh/replacement UPDATEs this row's `pushTokenEncrypted`; it
 * never inserts a second row for the same (userId, deviceId) pair — see the migration's
 * `UNIQUE (user_id, device_id)` constraint.
 *
 * `pushTokenEncrypted` is `bytea`/`select:false`, encrypted via `SecretEncryptionService`, same
 * convention as `User.totpSecretEncrypted`/`PlatformConfig.smtpPasswordEncrypted` — never
 * returned by an ordinary `find()`, never logged.
 */
@Entity({ name: 'push_device', schema: 'core' })
@Index(['userId'])
export class PushDevice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ name: 'device_id', type: 'text' })
  deviceId!: string;

  @Column({ type: 'text' })
  platform!: 'ios' | 'android';

  @Column({ name: 'push_token_encrypted', type: 'bytea', select: false })
  pushTokenEncrypted!: Buffer;

  @Column({ name: 'app_version', type: 'text', nullable: true })
  appVersion?: string | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'registered_at', type: 'timestamptz' })
  registeredAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  @Column({ name: 'deactivated_at', type: 'timestamptz', nullable: true })
  deactivatedAt?: Date | null;

  @Column({ name: 'deactivated_reason', type: 'text', nullable: true })
  deactivatedReason?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

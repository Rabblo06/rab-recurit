import { SmtpEncryptionType } from '@rab/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { Organisation } from './organisation.entity';
import { User } from './user.entity';

/**
 * One row per organisation — Admin Panel → Config (SMTP override,
 * Maintenance Mode). Typed/validated columns rather than jsonb because the
 * SMTP values feed directly into nodemailer's transport options, where a
 * malformed value is a send-time failure, not a display bug.
 * `smtpPasswordEncrypted` is AES-256-GCM via SecretEncryptionService (same
 * primitive already used for bank details/NI number/TOTP secret) and is
 * `select: false` — never returned to the client, only a derived
 * `hasPassword` boolean is.
 */
@Entity({ name: 'platform_config' })
export class PlatformConfig {
  @PrimaryColumn({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ name: 'smtp_host', nullable: true })
  smtpHost?: string;

  @Column({ name: 'smtp_port', type: 'integer', nullable: true })
  smtpPort?: number;

  @Column({ name: 'smtp_encryption', type: 'text', nullable: true })
  smtpEncryption?: SmtpEncryptionType;

  @Column({ name: 'smtp_username', nullable: true })
  smtpUsername?: string;

  @Column({ name: 'smtp_password_encrypted', type: 'bytea', nullable: true, select: false })
  smtpPasswordEncrypted?: Buffer;

  @Column({ name: 'smtp_from_name', nullable: true })
  smtpFromName?: string;

  @Column({ name: 'smtp_from_email', nullable: true })
  smtpFromEmail?: string;

  @Column({ name: 'maintenance_mode_enabled', default: false })
  maintenanceModeEnabled!: boolean;

  @Column({ name: 'maintenance_mode_message', nullable: true })
  maintenanceModeMessage?: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', nullable: true })
  updatedBy?: string;
}

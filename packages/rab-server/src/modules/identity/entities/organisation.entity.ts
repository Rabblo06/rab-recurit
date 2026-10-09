import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

/**
 * The tenant root. Has no `organisation_id` of its own — it IS the tenant —
 * and no RLS policy: which organisations a session may see is controlled
 * entirely by which `organisation_id` gets bound into that session's
 * tenant context, not by row filtering on this table.
 */
@Entity({ name: 'organisation', schema: 'core' })
export class Organisation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  /** Human-readable login identifier, e.g. "acme-widgets" — resolved pre-auth, see IdentitySchema's trade-off note. */
  @Column({ type: 'citext', unique: true })
  slug!: string;

  @Column({ name: 'legal_name', nullable: true })
  legalName?: string;

  @Column({ type: 'jsonb', default: {} })
  address!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: {} })
  contact!: Record<string, unknown>;

  /** @deprecated legacy object key - superseded by `logoFileId`. */
  @Column({ name: 'logo_key', nullable: true })
  logoKey?: string;

  @Column({ name: 'logo_file_id', type: 'uuid', nullable: true })
  logoFileId?: string | null;

  @Column({ default: 'Europe/London' })
  timezone!: string;

  @Column({ type: 'jsonb', default: {} })
  settings!: Record<string, unknown>;

  /**
   * P1C.1B (OrganisationAuthProviders1786680200000) — tenant-level auth-provider toggles.
   * Effective availability is always `system AND organisation`; see
   * OrganisationAuthProvidersService. A plain boolean column, not folded into `settings` jsonb,
   * specifically so the lockout-prevention CHECK constraint
   * (organisation_auth_provider_not_all_disabled) can be enforced by Postgres itself.
   */
  @Column({ name: 'password_auth_enabled', default: true })
  passwordAuthEnabled!: boolean;

  @Column({ name: 'google_auth_enabled', default: true })
  googleAuthEnabled!: boolean;

  @Column({ name: 'microsoft_auth_enabled', default: true })
  microsoftAuthEnabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /**
   * P1D — this organisation's security-configuration version: the three auth-provider toggles
   * above, and (by convention, not by column) `core.platform_config.maintenance_mode_enabled`,
   * which lives on a different table keyed by the same organisation id — see
   * `SecurityVersionVectors1786683000000`'s own doc comment for why both are folded into one
   * domain rather than two.
   */
  @Column({ name: 'security_version', type: 'bigint', transformer: bigintAsNumber })
  securityVersion!: number;
}

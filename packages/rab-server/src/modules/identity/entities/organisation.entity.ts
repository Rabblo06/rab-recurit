import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The tenant root. Has no `organisation_id` of its own — it IS the tenant —
 * and no RLS policy: which organisations a session may see is controlled
 * entirely by which `organisation_id` gets bound into that session's
 * tenant context, not by row filtering on this table.
 */
@Entity({ name: 'organisation' })
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

  @Column({ name: 'logo_key', nullable: true })
  logoKey?: string;

  @Column({ default: 'Europe/London' })
  timezone!: string;

  @Column({ type: 'jsonb', default: {} })
  settings!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

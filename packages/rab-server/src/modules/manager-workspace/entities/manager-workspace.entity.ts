import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A private, individually-owned workspace belonging to exactly one Manager
 * (`ownerUserId`, `UNIQUE` — one Manager, one Workspace) inside their
 * Organisation. Deliberately named `ManagerWorkspace`, not `Workspace` —
 * `WorkspaceController`/`WorkspaceService` (`modules/identity/`) already own
 * that name for a different, pre-existing concept: editing the shared
 * Organisation's own name/logo/timezone/subdomain. This entity is a new,
 * separate concept — per-Manager private tenancy — confirmed with the user
 * before building (see the plan file's Context section). User-facing copy
 * still says "Workspace" throughout; only the internal identifiers differ.
 *
 * `subdomain` is globally unique across ALL organisations (a `citext`
 * column, same idiom as `Organisation.slug`) — it maps to a real hostname
 * (`{subdomain}.{FRONT_DOMAIN}`), not an org-scoped label.
 */
@Entity({ name: 'manager_workspace' })
export class ManagerWorkspace {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'owner_user_id' })
  ownerUserId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'citext' })
  subdomain!: string;

  @Column({ name: 'logo_key', nullable: true })
  logoKey?: string;

  @Column({ type: 'text', default: 'active' })
  status!: string;

  @Column({ name: 'onboarding_completed_at', type: 'timestamptz', nullable: true })
  onboardingCompletedAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

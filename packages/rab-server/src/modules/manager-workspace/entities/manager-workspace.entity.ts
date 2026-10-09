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
@Entity({ name: 'manager_workspace', schema: 'core' })
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

  /** @deprecated legacy object key - superseded by `logoFileId`. */
  @Column({ name: 'logo_key', nullable: true })
  logoKey?: string;

  @Column({ name: 'logo_file_id', type: 'uuid', nullable: true })
  logoFileId?: string | null;

  @Column({ type: 'text', default: 'active' })
  status!: string;

  /**
   * Physical workspace-schema lifecycle (core.manager_workspace.schema_status). A new workspace is written CREATING, which is
   * non-routable. Legacy rows may be NULL, which is also non-routable. Only READY routes. See core.workspace_schema_routable().
   */
  @Column({ name: 'schema_status', type: 'text', nullable: true })
  schemaStatus?: string | null;

  @Column({ name: 'onboarding_completed_at', type: 'timestamptz', nullable: true })
  onboardingCompletedAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

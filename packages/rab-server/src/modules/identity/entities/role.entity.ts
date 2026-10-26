import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';
import { Organisation } from './organisation.entity';

/** A named bundle of permissions, scoped to one organisation. */
@Entity({ name: 'role', schema: 'core' })
@Index(['organisationId', 'key'], { unique: true })
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Organisation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  /** Stable machine key, e.g. "org_admin", "manager" — never renamed. */
  @Column()
  key!: string;

  @Column()
  name!: string;

  /** System roles ship with the org and cannot be deleted by a user. */
  @Column({ name: 'is_system', default: false })
  isSystem!: boolean;

  /**
   * The Manager-owned workspace a CUSTOM workspace-member role belongs to (key always `custom_…`); NULL for
   * system roles and legacy organisation-level roles. Immutable after creation (`role_identity_immutable`), and
   * RLS hides other workspaces' roles (WorkspaceMemberRoles1786714500000).
   */
  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId!: string | null;

  /** Role editor settings (custom workspace-member roles). RoleObjectFieldPermissions1786716000000. */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  icon!: string | null;

  /** When false the role is not offered in Invite and cannot be assigned. */
  @Column({ name: 'assignable_to_members', type: 'boolean', default: true })
  assignableToMembers!: boolean;

  /**
   * AI Phase 6a (RoleAssignableToAgents1786721040000): an AGENT role — a flag ceiling for AI agents only. Never a system
   * role, never assignable to members, never "read all objects", never held by a human and never given object / field
   * rules (all enforced in the database); immutable after creation. Managed only from Settings → AI → Agents.
   */
  @Column({ name: 'assignable_to_agents', type: 'boolean', default: false })
  assignableToAgents!: boolean;

  /** "All Objects → See" baseline; per-object rules in core.role_object_permission override it. */
  @Column({ name: 'can_read_all_objects', type: 'boolean', default: false })
  canReadAllObjects!: boolean;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  /**
   * P1D — which permissions THIS role grants. Bumped by `SecurityVersionService.bumpRole`
   * whenever `RoleService.setPermissions` changes `core.role_permission` for this role — once per
   * role, never fanned out to every current holder's own row (see
   * `SecurityVersionVectors1786683000000`'s own doc comment for why).
   */
  @Column({ name: 'permission_version', type: 'bigint', transformer: bigintAsNumber })
  permissionVersion!: number;
}

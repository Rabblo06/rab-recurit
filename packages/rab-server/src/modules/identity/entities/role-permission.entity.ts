import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Permission } from './permission.entity';
import { Role } from './role.entity';

/**
 * `organisationId` is denormalised from `role` onto every junction table in
 * this module so each one gets its own simple, fast RLS predicate
 * (`organisation_id = current_org()`) instead of a cross-table subquery.
 */
@Entity({ name: 'role_permission' })
export class RolePermission {
  @PrimaryColumn({ name: 'role_id' })
  roleId!: string;

  @PrimaryColumn({ name: 'permission_id' })
  permissionId!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_id' })
  permission?: Permission;
}

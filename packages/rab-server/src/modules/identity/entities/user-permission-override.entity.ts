import { PermissionOverrideEffectType } from '@rab/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Permission } from './permission.entity';
import { User } from './user.entity';

/** Per-user grant/revoke on top of whatever their roles resolve to. */
@Entity({ name: 'user_permission_override' })
export class UserPermissionOverride {
  @PrimaryColumn({ name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ name: 'permission_id' })
  permissionId!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ type: 'text' })
  effect!: PermissionOverrideEffectType;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_id' })
  permission?: Permission;
}

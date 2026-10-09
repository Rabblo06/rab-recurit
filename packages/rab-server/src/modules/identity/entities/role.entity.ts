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
   * P1D — which permissions THIS role grants. Bumped by `SecurityVersionService.bumpRole`
   * whenever `RoleService.setPermissions` changes `core.role_permission` for this role — once per
   * role, never fanned out to every current holder's own row (see
   * `SecurityVersionVectors1786683000000`'s own doc comment for why).
   */
  @Column({ name: 'permission_version', type: 'bigint', transformer: bigintAsNumber })
  permissionVersion!: number;
}

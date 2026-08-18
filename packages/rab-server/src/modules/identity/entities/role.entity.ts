import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Organisation } from './organisation.entity';

/** A named bundle of permissions, scoped to one organisation. */
@Entity({ name: 'role' })
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
}

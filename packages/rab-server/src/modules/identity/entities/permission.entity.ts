import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Global reference data, not tenant-scoped — the same permission catalogue
 * applies to every organisation. `key` matches `PermissionFlag` in
 * `@rab/shared` exactly (e.g. "payroll.approve").
 */
@Entity({ name: 'permission' })
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  key!: string;

  @Column()
  resource!: string;

  @Column()
  action!: string;

  @Column({ nullable: true })
  description?: string;
}

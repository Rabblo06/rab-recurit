import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `core.index_metadata` (MetadataEngineTables1786721550000): a custom BTREE index (`ix_<base36>`) on an object, no free-text
 * WHERE clause. Re-implements Twenty's `indexMetadata` (twentyhq/twenty @ eedb0a73
 * `engine/metadata-modules/index-metadata/index-metadata.entity.ts:33-95`). Its fields are IndexFieldMetadata rows.
 */
@Entity({ name: 'index_metadata', schema: 'core' })
export class IndexMetadata {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  @Column({ name: 'object_metadata_id', type: 'uuid' })
  objectMetadataId!: string;

  @Column({ name: 'physical_name', type: 'text' })
  physicalName!: string;

  @Column({ name: 'is_unique', type: 'boolean' })
  isUnique!: boolean;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

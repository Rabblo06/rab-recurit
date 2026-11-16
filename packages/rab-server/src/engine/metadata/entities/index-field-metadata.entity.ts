import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `core.index_field_metadata` (MetadataEngineTables1786721550000): the ordered fields (position 0..2) of an IndexMetadata.
 * Every referenced field belongs to the index's own object (composite foreign keys), and a field still used by an index
 * cannot be deleted. Twenty keeps the same rows as `indexFieldMetadata` (twentyhq/twenty @ eedb0a73
 * `engine/metadata-modules/index-metadata/index-field-metadata.entity.ts`).
 */
@Entity({ name: 'index_field_metadata', schema: 'core' })
export class IndexFieldMetadata {
  @PrimaryColumn({ name: 'index_metadata_id', type: 'uuid' })
  indexMetadataId!: string;

  @PrimaryColumn({ type: 'smallint' })
  position!: number;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  @Column({ name: 'object_metadata_id', type: 'uuid' })
  objectMetadataId!: string;

  @Column({ name: 'field_metadata_id', type: 'uuid' })
  fieldMetadataId!: string;
}

import type { ObjectMetadataStorage } from '@rab/shared';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `core.object_metadata` (MetadataEngineTables1786721550000): one object (a standard table, a custom `c_…` table, or a
 * read-only core reference object) per workspace. Re-implements Twenty's `objectMetadata` (twentyhq/twenty @ eedb0a73
 * `engine/metadata-modules/object-metadata/object-metadata.entity.ts:48-243`). FORCE RLS: rows are visible only inside a
 * tenant transaction bound to their organisation AND workspace.
 *
 * Immutable after insert (database trigger core.metadata_guard): id, organisationId, workspaceId, physicalTable, storage,
 * isCustom, isSystem, universalIdentifier, nameSingular, namePlural (OB-10). Write the tenant columns from the bound session
 * only, never from a request body.
 */
@Entity({ name: 'object_metadata', schema: 'core' })
export class ObjectMetadata {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  @Column({ name: 'universal_identifier', type: 'uuid', nullable: true })
  universalIdentifier!: string | null;

  @Column({ type: 'text' })
  storage!: ObjectMetadataStorage;

  @Column({ name: 'name_singular', type: 'text' })
  nameSingular!: string;

  @Column({ name: 'name_plural', type: 'text' })
  namePlural!: string;

  @Column({ name: 'label_singular', type: 'text' })
  labelSingular!: string;

  @Column({ name: 'label_plural', type: 'text' })
  labelPlural!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  icon!: string | null;

  @Column({ type: 'text', nullable: true })
  color!: string | null;

  @Column({ name: 'physical_table', type: 'text' })
  physicalTable!: string;

  @Column({ name: 'is_custom', type: 'boolean' })
  isCustom!: boolean;

  @Column({ name: 'is_system', type: 'boolean' })
  isSystem!: boolean;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'allows_custom_fields', type: 'boolean' })
  allowsCustomFields!: boolean;

  @Column({ name: 'is_searchable', type: 'boolean' })
  isSearchable!: boolean;

  @Column({ name: 'label_identifier_field_id', type: 'uuid', nullable: true })
  labelIdentifierFieldId!: string | null;

  @Column({ name: 'nav_position', type: 'double precision', nullable: true })
  navPosition!: number | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

import type { StoredFieldMetadataType } from '@rab/shared';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `core.field_metadata` (MetadataEngineTables1786721550000): one field per object. Relations are fields of type RELATION
 * (`settings.relationType` MANY_TO_ONE | ONE_TO_MANY; only MANY_TO_ONE owns a column), as in Twenty. Re-implements Twenty's
 * `fieldMetadata` (twentyhq/twenty @ eedb0a73 `engine/metadata-modules/field-metadata/field-metadata.entity.ts:52-217`).
 *
 * Immutable after insert (database trigger core.metadata_guard): id, tenant columns, objectMetadataId, type, name,
 * physicalColumn, isCustom, isSystem, isMoney, universalIdentifier, relationTargetObjectMetadataId; a locked field stays
 * locked and keeps its isActive. Crewflow flags (OWNER-METADATA-ENGINE §0.3 / §0.5): isLocked, isMoney, isUiReadOnly,
 * isSensitive, isExportableWhenSensitive.
 */
@Entity({ name: 'field_metadata', schema: 'core' })
export class FieldMetadata {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  @Column({ name: 'object_metadata_id', type: 'uuid' })
  objectMetadataId!: string;

  @Column({ name: 'universal_identifier', type: 'uuid', nullable: true })
  universalIdentifier!: string | null;

  @Column({ type: 'text' })
  type!: StoredFieldMetadataType;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  label!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  icon!: string | null;

  @Column({ name: 'physical_column', type: 'text', nullable: true })
  physicalColumn!: string | null;

  @Column({ name: 'default_value', type: 'jsonb', nullable: true })
  defaultValue!: unknown;

  @Column({ type: 'jsonb' })
  settings!: Record<string, unknown>;

  @Column({ name: 'is_custom', type: 'boolean' })
  isCustom!: boolean;

  @Column({ name: 'is_system', type: 'boolean' })
  isSystem!: boolean;

  @Column({ name: 'is_locked', type: 'boolean' })
  isLocked!: boolean;

  @Column({ name: 'is_ui_read_only', type: 'boolean' })
  isUiReadOnly!: boolean;

  @Column({ name: 'is_money', type: 'boolean' })
  isMoney!: boolean;

  @Column({ name: 'is_sensitive', type: 'boolean' })
  isSensitive!: boolean;

  @Column({ name: 'is_exportable_when_sensitive', type: 'boolean' })
  isExportableWhenSensitive!: boolean;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'is_nullable', type: 'boolean' })
  isNullable!: boolean;

  @Column({ name: 'is_unique', type: 'boolean' })
  isUnique!: boolean;

  @Column({ name: 'is_searchable', type: 'boolean' })
  isSearchable!: boolean;

  @Column({ name: 'relation_target_object_metadata_id', type: 'uuid', nullable: true })
  relationTargetObjectMetadataId!: string | null;

  @Column({ name: 'relation_target_field_metadata_id', type: 'uuid', nullable: true })
  relationTargetFieldMetadataId!: string | null;

  @Column({ type: 'double precision' })
  position!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

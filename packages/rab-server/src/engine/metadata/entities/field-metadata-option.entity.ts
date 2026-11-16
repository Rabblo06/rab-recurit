import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `core.field_metadata_option` (MetadataEngineTables1786721550000): the options of a SELECT / MULTI_SELECT / RATING field.
 * Re-implements Twenty's `fieldMetadataOption` (twentyhq/twenty @ eedb0a73
 * `engine/metadata-modules/field-metadata-option/entities/field-metadata-option.entity.ts:27-73`). Standard options keep
 * the stored database value (e.g. `pending_compliance`); custom options are UPPER_SNAKE (service rule, as in Twenty).
 */
@Entity({ name: 'field_metadata_option', schema: 'core' })
export class FieldMetadataOption {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  @Column({ name: 'field_metadata_id', type: 'uuid' })
  fieldMetadataId!: string;

  @Column({ type: 'text' })
  value!: string;

  @Column({ type: 'text' })
  label!: string;

  @Column({ type: 'text', nullable: true })
  color!: string | null;

  @Column({ type: 'double precision' })
  position!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

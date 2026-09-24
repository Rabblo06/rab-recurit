import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** See migration `StoredFileMetadata1786672600000` for the schema, RLS and the no-DELETE-grant rationale. */
@Entity({ name: 'stored_file' })
export class StoredFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId?: string | null;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ name: 'resource_type', type: 'text' })
  resourceType!: string;

  @Column({ name: 'resource_id' })
  resourceId!: string;

  @Column({ name: 'storage_driver', type: 'text' })
  storageDriver!: string;

  @Column({ type: 'text', nullable: true })
  bucket?: string | null;

  @Column({ name: 'object_key', type: 'text' })
  objectKey!: string;

  @Column({ name: 'original_filename', type: 'text' })
  originalFilename!: string;

  @Column({ name: 'mime_type', type: 'text' })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } })
  sizeBytes!: number;

  @Column({ type: 'char', length: 64, nullable: true })
  sha256?: string | null;

  @Column({ type: 'text', default: 'PENDING' })
  status!: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

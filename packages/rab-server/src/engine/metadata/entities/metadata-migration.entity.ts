import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `core.metadata_migration` (MetadataMigrationLog1786721640000; M2-PLAN §10 S-1, OB-1): the insert-only runtime log of
 * data-model changes, one row per applied change, written in the same transaction as the change (release 2, the change
 * runner). Read-only from the application's point of view: the database refuses every UPDATE and DELETE except the two
 * foreign-key actions (workspace deleted → rows deleted; actor deleted → `actorUserId` set to NULL).
 *
 * No Twenty counterpart (twentyhq/twenty @ eedb0a73 keeps no runtime log).
 */
@Entity({ name: 'metadata_migration', schema: 'core' })
export class MetadataMigration {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  /** bigint: returned as a string by the driver, never coerced to a JS number. */
  @Column({ name: 'previous_version', type: 'bigint' })
  previousVersion!: string;

  @Column({ name: 'metadata_version', type: 'bigint' })
  metadataVersion!: string;

  @Column({ name: 'change_kind', type: 'text' })
  changeKind!: string;

  @Column({ type: 'jsonb' })
  actions!: Array<Record<string, unknown>>;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({ name: 'request_id', type: 'text', nullable: true })
  requestId!: string | null;

  @Column({ name: 'executor_version', type: 'integer' })
  executorVersion!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

@Entity({ name: 'job_role' })
export class JobRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column()
  name!: string;

  @Column({ name: 'default_rate_pence', type: 'bigint', default: 0, transformer: bigintAsNumber })
  defaultRatePence!: number;

  /** Nullable — same "never guess ownership" precedent as `Venue.createdBy`; existing rows have no recoverable creator. */
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  /** Private Workspace migration — trusted server-side value, nullable until every Manager has completed onboarding. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  /**
   * Wave 5 archive (ArchiveAndSearchSchema1786719920000). Written ONLY by the named archive/restore actions in the
   * owning service (never by create/update: no DTO declares these, so a client sending them gets a 400). Archived rows
   * are excluded from LISTS and search by default but stay readable in history/FK reads (shifts, payslips, attendance).
   * `archivedBy` is a historical user id (no FK), like audit_log's identifiers.
   */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  @Column({ name: 'archived_by', type: 'uuid', nullable: true })
  archivedBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * One row per Shift — the Venue Manager attendance Report (Parts 38-51).
 * `shiftId` UNIQUE: a shift has exactly one report, generated/regenerated
 * by the worker's `shift-report-scheduler.job.ts`, never created by the API
 * directly (the API only reads it and drives `finalise`).
 *
 * No `preShiftPdfKey`/`finalPdfKey` columns — both PDFs are email-delivered
 * only (rendered, stored, and attached entirely inside the worker process),
 * not served back through the API, because `rab-server`/`rab-worker` are
 * separate containers with separate local disks on the current deployment
 * topology and no S3-class storage driver exists yet (see
 * `StorageService`'s own doc comment). `preShiftPdfSentAt`/`finalPdfSentAt`
 * record that the email actually went out, without implying a file is
 * retrievable via this API.
 */
@Entity({ name: 'shift_report' })
export class ShiftReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @Column({ name: 'shift_id' })
  shiftId!: string;

  /** `'pending' | 'ready' | 'finalised'` — see `ShiftReportStatus` constants. */
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  @Column({ name: 'pre_shift_pdf_generated_at', type: 'timestamptz', nullable: true })
  preShiftPdfGeneratedAt?: Date;

  @Column({ name: 'pre_shift_pdf_sent_at', type: 'timestamptz', nullable: true })
  preShiftPdfSentAt?: Date;

  @Column({ name: 'finalised_at', type: 'timestamptz', nullable: true })
  finalisedAt?: Date;

  @Column({ name: 'finalised_by', nullable: true })
  finalisedBy?: string;

  @Column({ name: 'final_pdf_sent_at', type: 'timestamptz', nullable: true })
  finalPdfSentAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

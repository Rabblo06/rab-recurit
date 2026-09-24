import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * One row per Shift — the Venue Manager attendance Report (Parts 38-51).
 * `shiftId` UNIQUE: a shift has exactly one report, generated/regenerated
 * by the worker's `shift-report-scheduler.job.ts`, never created by the API
 * directly (the API only reads it and drives `finalise`).
 *
 * Both PDFs live in shared object storage (`stored_file`, S3-compatible), so
 * the worker that RENDERS a report and the worker that EMAILS it, and the API
 * that lets a manager DOWNLOAD it, need not share a disk. `preShiftPdfSentAt`
 * / `finalPdfSentAt` record that the email went out; `preShiftFileId` /
 * `finalFileId` point at the stored evidence.
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

  /** The CURRENT roster PDF (`stored_file`). Regeneration writes a NEW immutable object and re-points this; old versions stay for evidence/lifecycle. */
  @Column({ name: 'pre_shift_file_id', type: 'uuid', nullable: true })
  preShiftFileId?: string | null;

  /** The one authoritative final timesheet PDF. Set exactly once, in the same transaction that claims delivery. */
  @Column({ name: 'final_file_id', type: 'uuid', nullable: true })
  finalFileId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

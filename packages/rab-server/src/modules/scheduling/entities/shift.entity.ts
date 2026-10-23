import { ShiftStatus, ShiftStatusType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';

@Entity({ name: 'shift' })
export class Shift {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'venue_id' })
  venueId!: string;

  @Column({ name: 'job_role_id' })
  jobRoleId!: string;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt!: Date;

  @Column({ name: 'default_starts_at', type: 'timestamptz', nullable: true })
  defaultStartsAt?: Date | null;

  @Column({ name: 'default_ends_at', type: 'timestamptz', nullable: true })
  defaultEndsAt?: Date | null;

  @Column({ name: 'break_minutes', default: 0 })
  breakMinutes!: number;

  @Column({ name: 'required_count' })
  requiredCount!: number;

  @Column({ name: 'filled_count', default: 0 })
  filledCount!: number;

  @Column({ name: 'pay_rate_pence', type: 'bigint', transformer: bigintAsNumber })
  payRatePence!: number;

  @Column({ name: 'charge_rate_pence', type: 'bigint', default: 0, transformer: bigintAsNumber })
  chargeRatePence!: number;

  @Column({ nullable: true })
  notes?: string;

  /** Snapshotted from the venue at creation, freely editable per-shift afterward — see ShiftAddressColumn1786666400000. */
  @Column({ nullable: true })
  address?: string;

  @Column({ type: 'text', default: ShiftStatus.DRAFT })
  status!: ShiftStatusType;

  @Column({ name: 'recurrence_group_id', nullable: true })
  recurrenceGroupId?: string;

  @Column({ name: 'created_by' })
  createdBy!: string;

  /** Private Workspace migration — trusted server-side value, inherited from the creating Manager's own workspace, nullable until every Manager has onboarded. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Column({ name: 'cancelled_reason', nullable: true })
  cancelledReason?: string;

  @Column({ name: 'cancelled_by', nullable: true })
  cancelledBy?: string;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  /**
   * The Venue Manager who submitted this as a shift request — null for
   * every shift created directly by an Internal Manager (`createShiftAndSend`/
   * `SchedulingService.create`). This is what `OfferService.staffAccept`
   * checks to decide whether a staff acceptance immediately confirms
   * (no second manager action) or still requires the original two-step
   * manager-confirm flow — see that method's own doc comment.
   */
  @Column({ name: 'requested_by', nullable: true })
  requestedBy?: string;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Column({ name: 'approved_by', nullable: true })
  approvedBy?: string;

  @Column({ name: 'declined_at', type: 'timestamptz', nullable: true })
  declinedAt?: Date;

  @Column({ name: 'declined_by', nullable: true })
  declinedBy?: string;

  @Column({ name: 'declined_reason', nullable: true })
  declinedReason?: string;

  /** Bumped to invalidate an already-printed Shift QR (e.g. a venue reassignment) — see `AttendanceQrService`. */
  @Column({ name: 'qr_version', default: 1 })
  qrVersion!: number;

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

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

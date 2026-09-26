import { AttendanceStatus, AttendanceStatusType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';
import { numericAsNumber } from '../../../engine/utils/numeric-transformer';

/**
 * One row per clock-in. `shiftAssignmentId` is UNIQUE — an assignment can be
 * attended at most once, ever (the assignment's own status machine already
 * makes `CONFIRMED` terminal-on-completion via `COMPLETED`, so a second
 * clock-in against the same assignment is rejected before it would even
 * reach here — see `AttendanceService.clockIn`). `staffProfileId`/`shiftId`
 * are denormalized the same way `ShiftAssignment` itself denormalizes them,
 * for query simplicity and RLS — not a second source of truth, always
 * written from the assignment row at clock-in.
 *
 * `clockInAt`/`clockOutAt` are always server timestamps (`now()` at the
 * moment the request is processed) — never accepted from the client body
 * (CLAUDE.md: "no mock production logic... never client-local elapsed
 * time"). `workedMinutes`/`earnedPence` are snapshotted once, at clock-out,
 * via `@rab/shared`'s `computeWorkedMinutes`/`payForMinutes` — the same
 * canonical functions the payroll engine will use — never recalculated
 * later even if the underlying pay rate changes afterward.
 */
@Entity({ name: 'attendance' })
export class Attendance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'shift_assignment_id' })
  shiftAssignmentId!: string;

  @Column({ name: 'shift_id' })
  shiftId!: string;

  @Column({ name: 'staff_profile_id' })
  staffProfileId!: string;

  /** Private Workspace migration — inherited from the parent Shift's workspace at clock-in. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @Column({ name: 'clock_in_at', type: 'timestamptz' })
  clockInAt!: Date;

  @Column({ name: 'clock_out_at', type: 'timestamptz', nullable: true })
  clockOutAt?: Date;

  @Column({ name: 'post_shift_completed_at', type: 'timestamptz', nullable: true })
  postShiftCompletedAt?: Date;

  @Column({ name: 'post_shift_expired_at', type: 'timestamptz', nullable: true })
  postShiftExpiredAt?: Date;

  @Column({ type: 'text', default: AttendanceStatus.CLOCKED_IN })
  status!: AttendanceStatusType;

  @Column({ name: 'worked_minutes', type: 'int', nullable: true })
  workedMinutes?: number;

  @Column({ name: 'earned_pence', type: 'bigint', nullable: true, transformer: bigintAsNumber })
  earnedPence?: number;

  @Column({ name: 'clock_in_lat', type: 'numeric', precision: 9, scale: 6, nullable: true, transformer: numericAsNumber })
  clockInLat?: number;

  @Column({ name: 'clock_in_lng', type: 'numeric', precision: 9, scale: 6, nullable: true, transformer: numericAsNumber })
  clockInLng?: number;

  @Column({ name: 'clock_in_accuracy_m', type: 'int', nullable: true })
  clockInAccuracyM?: number;

  @Column({ name: 'clock_out_lat', type: 'numeric', precision: 9, scale: 6, nullable: true, transformer: numericAsNumber })
  clockOutLat?: number;

  @Column({ name: 'clock_out_lng', type: 'numeric', precision: 9, scale: 6, nullable: true, transformer: numericAsNumber })
  clockOutLng?: number;

  @Column({ name: 'clock_out_accuracy_m', type: 'int', nullable: true })
  clockOutAccuracyM?: number;

  /** Set only when the venue's geofence was actually enforced AND the check passed — never merely "coordinates were present." */
  @Column({ name: 'location_verified', default: false })
  locationVerified!: boolean;

  /** `'manual' | 'auto_geofence' | 'manager_correction'` — null until clocked out. See `AttendanceService.performClockOut`. */
  @Column({ name: 'clock_out_method', nullable: true })
  clockOutMethod?: string;

  /** Manager-confirmed/-corrected actual break, in minutes — null until a Venue Manager sets it during Report review (there is no staff-facing break feature). Falls back to `shift.breakMinutes` when null. */
  @Column({ name: 'break_minutes', type: 'int', nullable: true })
  breakMinutes?: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

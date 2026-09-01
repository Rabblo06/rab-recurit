import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';
import { AttendanceStatus, AttendanceStatusType } from '../constants/attendance-status';

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

  @Column({ type: 'text', default: AttendanceStatus.ACTIVE })
  status!: AttendanceStatusType;

  @Column({ name: 'worked_minutes', type: 'int', nullable: true })
  workedMinutes?: number;

  @Column({ name: 'earned_pence', type: 'bigint', nullable: true, transformer: bigintAsNumber })
  earnedPence?: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

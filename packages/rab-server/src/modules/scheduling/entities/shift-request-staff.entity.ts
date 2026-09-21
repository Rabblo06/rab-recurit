import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The Venue Manager's Staff selection at shift-REQUEST time — pure intent,
 * not an offer (no `ShiftAssignment`/`JobOffer` exists until the Internal
 * Manager approves; see ShiftRequestStaffSelection migration's own doc
 * comment for why this is a separate table rather than a new
 * `ShiftAssignment` status). Composite key: one row per (shift, staff)
 * pair, no separate `id` needed since nothing else ever references a row
 * here directly.
 */
@Entity({ name: 'shift_request_staff' })
export class ShiftRequestStaff {
  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @PrimaryColumn({ name: 'shift_id' })
  shiftId!: string;

  @PrimaryColumn({ name: 'staff_profile_id' })
  staffProfileId!: string;

  /** Private Workspace migration — inherited from the parent Shift's workspace at creation. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

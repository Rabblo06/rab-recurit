import { EmploymentStatus, EmploymentStatusType } from '@rab/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { bigintAsNumber } from '../../../engine/utils/bigint-transformer';
import { User } from '../../identity/entities';
import { JobRole } from '../../scheduling/entities/job-role.entity';

@Entity({ name: 'staff_profile' })
export class StaffProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'staff_ref' })
  staffRef!: string;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth?: string;

  @Column({ name: 'employment_status', type: 'text', default: EmploymentStatus.PENDING_COMPLIANCE })
  employmentStatus!: EmploymentStatusType;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate?: string;

  @Column({ name: 'default_pay_rate_pence', type: 'bigint', default: 0, transformer: bigintAsNumber })
  defaultPayRatePence!: number;

  @Column({ nullable: true })
  notes?: string;

  @Column({ name: 'emergency_contact_name', nullable: true })
  emergencyContactName?: string;

  @Column({ name: 'emergency_contact_relationship', nullable: true })
  emergencyContactRelationship?: string;

  @Column({ name: 'emergency_contact_phone', nullable: true })
  emergencyContactPhone?: string;

  @Column({ name: 'preferred_name', nullable: true })
  preferredName?: string;

  /** No authoritative enum exists elsewhere in the schema — a small fixed suggestion list is enforced at the DTO layer only, not a DB constraint (see CreateStaffDto's own doc comment on this field). */
  @Column({ name: 'employment_type', nullable: true })
  employmentType?: string;

  @Column({ nullable: true })
  address?: string;

  @Column({ nullable: true })
  city?: string;

  @Column({ nullable: true })
  postcode?: string;

  /** Free text, comma-separated — no tag-input component exists anywhere in this codebase; see the Create Staff wizard's own doc comment for why this stays simple. */
  @Column({ name: 'other_skills', nullable: true })
  otherSkills?: string;

  @Column({ name: 'years_experience', type: 'int', nullable: true })
  yearsExperience?: number;

  @Column({ name: 'available_days', type: 'text', array: true, nullable: true })
  availableDays?: string[];

  @Column({ name: 'preferred_shift_times', nullable: true })
  preferredShiftTimes?: string;

  @Column({ name: 'max_hours_per_week', type: 'int', nullable: true })
  maxHoursPerWeek?: number;

  // Free text, deliberately not a fixed enum of legal/compliance categories —
  // no authoritative right-to-work taxonomy exists anywhere in this codebase,
  // and inventing one here would be exactly the "invent a business rule
  // silently where it touches compliance" case CLAUDE.md prohibits. A real
  // taxonomy, if the business defines one, is a follow-up migration to
  // constrain this column — not a decision made silently now.
  @Column({ name: 'right_to_work_status', nullable: true })
  rightToWorkStatus?: string;

  @Column({ name: 'document_type', nullable: true })
  documentType?: string;

  @Column({ name: 'expiry_date', type: 'date', nullable: true })
  expiryDate?: string;

  @Column({ type: 'text', array: true, nullable: true })
  languages?: string[];

  /** Reuses the existing `JobRole` entity built for Shift creation — never a second, free-text "job role" concept. Nullable: not every org has set one up before hiring. */
  @Column({ name: 'job_role_id', nullable: true })
  jobRoleId?: string;

  @ManyToOne(() => JobRole, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_role_id' })
  jobRole?: JobRole;

  // The manager whose private scope this Staff profile belongs to — NULL
  // for profiles that predate ownership tracking (see
  // ResourceOwnershipSchema1786666700000's doc comment: unrecoverable,
  // never guessed). A NULL owner is visible to the platform admin only.
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  /** Private Workspace migration — trusted server-side value, nullable until every Manager has completed onboarding. */
  @Column({ name: 'workspace_id', nullable: true })
  workspaceId?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

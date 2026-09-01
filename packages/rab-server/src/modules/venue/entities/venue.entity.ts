import { VenueStatus, VenueStatusType, VenueType, VenueTypeType } from '@rab/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'venue' })
export class Venue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column()
  name!: string;

  @Column({ name: 'client_name', nullable: true })
  clientName?: string;

  @Column({ type: 'text', default: VenueType.OTHER })
  type!: VenueTypeType;

  @Column({ type: 'jsonb', default: {} })
  address!: Record<string, unknown>;

  @Column({ type: 'numeric', precision: 9, scale: 6, nullable: true })
  lat?: number;

  @Column({ type: 'numeric', precision: 9, scale: 6, nullable: true })
  lng?: number;

  @Column({ name: 'geofence_radius_m', default: 200 })
  geofenceRadiusM!: number;

  @Column({ name: 'enforce_geofence', default: false })
  enforceGeofence!: boolean;

  @Column({ type: 'jsonb', default: {} })
  contact!: Record<string, unknown>;

  @Column({ nullable: true })
  instructions?: string;

  @Column({ nullable: true })
  uniform?: string;

  @Column({ name: 'check_in_instructions', nullable: true })
  checkInInstructions?: string;

  @Column({ nullable: true })
  parking?: string;

  @Column({ name: 'access_notes', nullable: true })
  accessNotes?: string;

  @Column({ name: 'break_paid', default: false })
  breakPaid!: boolean;

  @Column({ type: 'text', default: VenueStatus.ACTIVE })
  status!: VenueStatusType;

  /**
   * Nullable — existing venues predating this column have no recoverable
   * creator (no audit trail exists for venue creation) and stay NULL,
   * visible only to the platform admin, matching the same "never guess
   * ownership" precedent already set for `staff_profile.created_by`. Every
   * new venue stamps this at creation (`VenueService.create`).
   */
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

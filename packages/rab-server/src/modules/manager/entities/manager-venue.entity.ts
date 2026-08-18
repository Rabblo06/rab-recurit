import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'manager_venue' })
export class ManagerVenue {
  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @PrimaryColumn({ name: 'manager_profile_id' })
  managerProfileId!: string;

  @PrimaryColumn({ name: 'venue_id' })
  venueId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

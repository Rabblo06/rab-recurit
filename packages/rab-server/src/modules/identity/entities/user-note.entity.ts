import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A free-text manager/admin note attached to a person's account — backs the
 * Staff and Manager detail panels' "Note" tab. Keyed by `subjectUserId`
 * (`core.user.id`), not `staff_profile.id`/`manager_profile.id`, so one
 * table/service serves both panels instead of two near-identical ones.
 * Visibility is enforced by whichever caller already resolved and
 * authorized the subject profile (`StaffService`/`ManagerService`) — this
 * entity itself only carries the organisation-tenant RLS boundary.
 */
@Entity({ name: 'user_note' })
@Index(['subjectUserId', 'createdAt'])
export class UserNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ name: 'subject_user_id' })
  subjectUserId!: string;

  @Column({ name: 'author_user_id', nullable: true })
  authorUserId?: string;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

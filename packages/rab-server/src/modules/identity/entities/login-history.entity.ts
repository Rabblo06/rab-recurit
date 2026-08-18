import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Every login attempt, success or failure. `userId` is null for an attempt
 * against an email that doesn't exist — `email` records what was tried, for
 * lockout/enumeration analysis. Append-only in practice (no update/delete
 * route), though — unlike audit_log — not yet DB-grant-enforced; that lands
 * with audit_log's own migration.
 */
@Entity({ name: 'login_history' })
export class LoginHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', nullable: true })
  organisationId?: string;

  @Column({ name: 'user_id', nullable: true })
  userId?: string;

  @Column()
  email!: string;

  @Column({ nullable: true })
  ip?: string;

  @Column({ name: 'user_agent', nullable: true })
  userAgent?: string;

  @Column()
  success!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

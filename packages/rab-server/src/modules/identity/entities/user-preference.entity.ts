import {
  DateFormat,
  DateFormatType,
  FirstDayOfWeek,
  FirstDayOfWeekType,
  NavPreference,
  NavPreferenceType,
  Theme,
  ThemeType,
  TimeFormat,
  TimeFormatType,
} from '@rab/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { User } from './user.entity';

/**
 * One row per user — Experience/Formats settings. `timezone` is nullable:
 * NULL means "inherit organisation.timezone" rather than duplicating it.
 * `language`/`interfaceScale` are deliberately not columns here — English
 * is the only supported language (no fake i18n) and interface scale is a
 * client-only cosmetic value with no other consumer.
 */
@Entity({ name: 'user_preference' })
export class UserPreference {
  @PrimaryColumn({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'organisation_id' })
  organisationId!: string;

  @Column({ type: 'text', default: Theme.SYSTEM })
  theme!: ThemeType;

  @Column({ name: 'nav_preference', type: 'text', default: NavPreference.SIDE_PANEL })
  navPreference!: NavPreferenceType;

  @Column({ type: 'text', nullable: true })
  timezone?: string;

  @Column({ name: 'date_format', type: 'text', default: DateFormat.DD_MM_YYYY })
  dateFormat!: DateFormatType;

  @Column({ name: 'time_format', type: 'text', default: TimeFormat.H24 })
  timeFormat!: TimeFormatType;

  @Column({ name: 'first_day_of_week', type: 'text', default: FirstDayOfWeek.MONDAY })
  firstDayOfWeek!: FirstDayOfWeekType;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

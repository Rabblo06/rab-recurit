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
import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateUserPreferenceDto {
  @IsOptional()
  @IsIn(Object.values(Theme))
  theme?: ThemeType;

  @IsOptional()
  @IsIn(Object.values(NavPreference))
  navPreference?: NavPreferenceType;

  /** Empty string clears the override, reverting to the organisation's timezone. */
  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsIn(Object.values(DateFormat))
  dateFormat?: DateFormatType;

  @IsOptional()
  @IsIn(Object.values(TimeFormat))
  timeFormat?: TimeFormatType;

  @IsOptional()
  @IsIn(Object.values(FirstDayOfWeek))
  firstDayOfWeek?: FirstDayOfWeekType;
}

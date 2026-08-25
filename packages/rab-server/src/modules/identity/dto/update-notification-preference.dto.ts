import { NotificationType, NotificationTypeType } from '@rab/shared';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class UpdateNotificationPreferenceDto {
  @IsIn(Object.values(NotificationType))
  notificationType!: NotificationTypeType;

  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;
}

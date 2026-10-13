import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Deliberately has NO `userId`/`organisationId`/`workspaceId` field — `forbidNonWhitelisted`
 * (wired globally in `main.ts`) rejects any request body that tries to send one, same anti-
 * mass-assignment control every other DTO in this app relies on (Stage 6 §5).
 */
export class RegisterPushDeviceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  deviceId!: string;

  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  pushToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  appVersion?: string;
}

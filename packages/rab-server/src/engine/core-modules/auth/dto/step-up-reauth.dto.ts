import { IsString, MinLength } from 'class-validator';

/** P2.8 — required on every destructive action gated by `StepUpReauthService` (platform-admin grant/revoke, user deletion). */
export class StepUpReauthDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;
}

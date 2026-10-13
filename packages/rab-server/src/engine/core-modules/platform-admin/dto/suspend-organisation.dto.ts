import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * P2.8 — `confirmSlug` is the EXPLICIT CONFIRMATION the owner's spec requires in addition to
 * step-up reauth (`currentPassword`, see `StepUpReauthDto`): the caller must echo back the target
 * organisation's own slug, verified server-side in `OrganisationSuspensionService.suspend`
 * against the real row — never accepted as a bare boolean flag, which a UI could send without the
 * admin ever having seen which organisation they're about to suspend.
 */
export class SuspendOrganisationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @IsString()
  @MinLength(1)
  confirmSlug!: string;

  @IsString()
  @MinLength(1)
  currentPassword!: string;
}

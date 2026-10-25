import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * P2.8 — `confirmSlug` is the EXPLICIT CONFIRMATION the owner's spec requires in addition to step-up: the caller must
 * echo back the target organisation's own slug, verified server-side in `OrganisationSuspensionService.suspend` against
 * the real row — never accepted as a bare boolean flag, which a UI could send without the admin ever having seen which
 * organisation they're about to suspend.
 *
 * Admin panel follow-up (step-1 report point 4): no `currentPassword` any more — the service requires a recent step-up of
 * this session ('organisation.suspend'), which an SSO-only admin can also earn. The reason is trimmed, 3–500.
 */
export class SuspendOrganisationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsString()
  @MinLength(1)
  confirmSlug!: string;
}

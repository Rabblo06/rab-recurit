import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * No `staffProfileIds` here (deliberately — see `OfferService
 * .approveShiftRequest`'s own doc comment): the recipient list for an
 * approval is always re-derived server-side from `shift_request_staff`,
 * the same persisted table the Venue Offers detail drawer edits via its
 * own add/remove actions. A client-supplied list at approval time would
 * either re-trust a stale page load or let approval silently re-include
 * someone already removed — this DTO can't accept that field at all
 * (`forbidNonWhitelisted`, already wired globally in `main.ts`), not just
 * "ignore" it.
 */
export class ApproveShiftRequestDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours?: number;
}

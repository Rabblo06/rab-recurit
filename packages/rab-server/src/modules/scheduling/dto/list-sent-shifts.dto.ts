import { IsIn, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

/** Sent Shifts tabs. `all` = every submitted request that is NOT expired; `expired` = only genuinely expired ones. */
export const SENT_SHIFT_VIEWS = ['all', 'pending', 'accepted', 'confirmed', 'declined', 'expired'] as const;
export type SentShiftView = (typeof SENT_SHIFT_VIEWS)[number];

export class ListSentShiftsDto extends PaginationDto {
  @IsOptional()
  @IsIn(SENT_SHIFT_VIEWS)
  view?: SentShiftView;
}

import { IsUUID } from 'class-validator';

/** The manager's choice from the worker-prepared shortlist — re-validated fresh against live eligibility in `ReplacementRequestService.approve()`, never trusted as authorization on its own. */
export class ApproveReplacementRequestDto {
  @IsUUID()
  staffProfileId!: string;
}

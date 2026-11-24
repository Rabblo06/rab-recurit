import { IsOptional, IsUUID } from 'class-validator';
import { RequestedStaffTimeDto } from '../../scheduling/dto/submit-shift-request.dto';

/** Manager-selected role and scheduled window for one recipient on the parent shift. */
export class StaffOfferAssignmentDto extends RequestedStaffTimeDto {
  @IsOptional()
  @IsUUID()
  jobRoleId?: string;
}

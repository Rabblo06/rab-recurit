import { PermissionFlag } from '@rab/shared';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { CancelShiftDto } from '../../scheduling/dto/cancel-shift.dto';
import { SendBulkOfferDto } from '../dto/send-bulk-offer.dto';
import { VenueOfferPipelineService } from '../services/venue-offer-pipeline.service';
@Controller('rest/v1/shifts/:id/pipeline')
@UseGuards(JwtAuthGuard, RequireWorkspaceGuard)
@ManagerApplication()
export class VenueOfferPipelineController {
  constructor(private readonly pipeline: VenueOfferPipelineService) {}
  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.get(ctx, id);
  }
  @Post('offers/:offerId/cancel')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_WITHDRAW))
  cancel(
    @AuthUser() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() dto: CancelShiftDto,
  ) {
    return this.pipeline.cancel(ctx, id, offerId, dto.reason);
  }
  @Post('replacements')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_SEND))
  replace(
    @AuthUser() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendBulkOfferDto,
  ) {
    return this.pipeline.replace(ctx, id, dto.staffProfileIds);
  }
}

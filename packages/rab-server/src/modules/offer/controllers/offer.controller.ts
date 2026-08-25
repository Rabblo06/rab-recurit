import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateShiftAndSendDto } from '../dto/create-shift-and-send.dto';
import { DeclineOfferDto } from '../dto/decline-offer.dto';
import { RejectOfferDto } from '../dto/reject-offer.dto';
import { SendBulkOfferDto } from '../dto/send-bulk-offer.dto';
import { SendOfferDto } from '../dto/send-offer.dto';
import { OfferService } from '../services/offer.service';

@Controller('rest/v1')
@UseGuards(JwtAuthGuard)
export class OfferController {
  constructor(private readonly offerService: OfferService) {}

  @Get('offers')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.offerService.list(ctx, pagination);
  }

  /** Staff-facing (mobile): only the caller's own offers — gated on the same permission staff need to respond at all. */
  @Get('offers/mine')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_RESPOND))
  listMine(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.offerService.listMine(ctx, pagination);
  }

  @Post('shifts/:shiftId/offers')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_SEND))
  send(@AuthUser() ctx: AuthContext, @Param('shiftId') shiftId: string, @Body() dto: SendOfferDto) {
    return this.offerService.send(ctx, shiftId, dto);
  }

  /** Same permission as a single send — a manager who can send one offer can send N to the same shift. */
  @Post('shifts/:shiftId/offers/bulk')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_SEND))
  sendBulk(@AuthUser() ctx: AuthContext, @Param('shiftId') shiftId: string, @Body() dto: SendBulkOfferDto) {
    return this.offerService.sendBulk(ctx, shiftId, dto);
  }

  /**
   * The unified "New Shift" drawer: one call creates the shift and sends
   * every selected staff member their offer. Gated on OFFER_SEND alone,
   * same as `sendBulk` — the action's primary effect for the permission
   * matrix is "sending an offer," shift creation is incidental to that.
   */
  @Post('shifts/with-offers')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_SEND))
  createShiftAndSend(@AuthUser() ctx: AuthContext, @Body() dto: CreateShiftAndSendDto) {
    return this.offerService.createShiftAndSend(ctx, dto);
  }

  @Get('offers/batches/:batchId')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  getBatch(@AuthUser() ctx: AuthContext, @Param('batchId') batchId: string) {
    return this.offerService.getBatch(ctx, batchId);
  }

  /** Same permission as a single confirm — see `sendBulk`. */
  @Post('offers/batches/:batchId/confirm-all')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_CONFIRM))
  confirmAll(@AuthUser() ctx: AuthContext, @Param('batchId') batchId: string) {
    return this.offerService.confirmAll(ctx, batchId);
  }

  @Post('offers/:id/withdraw')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_WITHDRAW))
  withdraw(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.offerService.withdraw(ctx, id);
  }

  /** Step 1 of 2 — staff accepting only reserves the offer; see OfferService.staffAccept doc comment. */
  @Post('offers/:id/accept')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_RESPOND))
  accept(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.offerService.staffAccept(ctx, id);
  }

  @Post('offers/:id/decline')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_RESPOND))
  decline(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: DeclineOfferDto) {
    return this.offerService.decline(ctx, id, dto);
  }

  /** Step 2 of 2 — manager-only, only valid from STAFF_ACCEPTED. This is the only path to MANAGER_CONFIRMED. */
  @Post('offers/:id/confirm')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_CONFIRM))
  confirm(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.offerService.managerConfirm(ctx, id);
  }

  @Post('offers/:id/reject')
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_CONFIRM))
  reject(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: RejectOfferDto) {
    return this.offerService.managerReject(ctx, id, dto);
  }
}

import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { AiProposalService } from '../actions/ai-proposal.service';
import { ApproveAiProposalDto, RejectAiProposalDto } from '../dto/ai-proposal.dto';

/**
 * AI Phase 5a — proposal cards (PHASE5_TWENTY_PLAN §2.4; route table AI_CONTRACTS.md §3). Web console only. Transport
 * only: `AiProposalService` re-checks access (AI off / organisation off / not eligible / Admin Inspect → the uniform 404),
 * ownership (RLS: someone else's proposal is a 404), the state machine, step-up and the domain permission itself. A ready
 * model is not required (D9). Organisation, workspace and user come from the verified session only; a body carrying
 * `organisationId`, `status` or any undeclared key is a 400 (forbidNonWhitelisted).
 */
@Controller('rest/v1/ai')
@ManagerApplication()
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_USE))
export class AiProposalController {
  constructor(private readonly proposals: AiProposalService) {}

  @Get('conversations/:id/proposals')
  list(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.proposals.list(ctx, id);
  }

  @Post('proposals/:id/approve')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  approve(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveAiProposalDto) {
    return this.proposals.approve(ctx, id, dto);
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reject(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectAiProposalDto) {
    return this.proposals.reject(ctx, id, dto);
  }
}

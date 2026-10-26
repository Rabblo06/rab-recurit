import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AiProposalService } from '../actions/ai-proposal.service';
import { AiDecidableGuard } from '../actions/ai-decidable.guard';
import { ApproveAiProposalDto, RejectAiProposalDto } from '../dto/ai-proposal.dto';
import { AnswerAiInputDto } from '../dto/ai-input-answer.dto';
import { AiInputRequestService } from '../services/ai-input-request.service';

/**
 * AI Phase 5a — proposal cards (PHASE5_TWENTY_PLAN §2.4; route table AI_CONTRACTS.md §3). Web console only. Transport
 * only: `AiProposalService` re-checks access (AI off / organisation off / not eligible / Admin Inspect → the uniform 404),
 * ownership (RLS: someone else's proposal is a 404), the state machine, step-up and the domain permission itself. A ready
 * model is not required (D9). Organisation, workspace and user come from the verified session only; a body carrying
 * `organisationId`, `status` or any undeclared key is a 400 (forbidNonWhitelisted).
 */
@Controller('rest/v1/ai')
@ManagerApplication()
// p5 merge (Agent 5 Q4): layer 1 is AiDecidableGuard, not PermissionGuard(ai.use). Without `ai.use` (or any earlier gate) the
// answer is the SAME uniform 404 as every other AI route (Phase 1 status order), never a 403 that discloses the feature.
@UseGuards(JwtAuthGuard, AiDecidableGuard)
export class AiProposalController {
  constructor(
    private readonly proposals: AiProposalService,
    // Batch 3 S7: the question / form cards and the named answer action (no data write; the answer feeds a continuation).
    private readonly inputs: AiInputRequestService,
  ) {}

  @Get('conversations/:id/inputs')
  listInputs(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inputs.list(ctx, id);
  }

  @Post('conversations/:id/inputs/:requestId/answer')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  answer(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: AnswerAiInputDto) {
    return this.inputs.answer(ctx, id, requestId, { answer: dto.answer });
  }

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

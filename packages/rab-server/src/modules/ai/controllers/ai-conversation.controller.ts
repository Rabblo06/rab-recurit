import { Body, Controller, Delete, Get, Headers, HttpCode, MessageEvent, Param, ParseUUIDPipe, Post, Query, Sse, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Observable } from 'rxjs';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { CreateAiConversationDto } from '../dto/create-ai-conversation.dto';
import { ListAiConversationsDto, StreamAiTurnDto } from '../dto/list-ai-conversations.dto';
import { PostAiMessageDto } from '../dto/post-ai-message.dto';
import { AiConversationService } from '../services/ai-conversation.service';
import { AiSseService } from '../services/ai-sse.service';
import { AiAvailableGuard } from './ai-available.guard';
import { AiStreamAccessGuard } from './ai-stream-access.guard';

/**
 * AI Phase 1 conversation API (contract: docs/ai/API_CONTRACT.md). Web console only (`@ManagerApplication()`: the Staff
 * and Venue Manager mobile apps are refused before anything else runs). Transport only — every rule lives in the
 * services, which re-check availability themselves. Organisation, workspace and user come from the verified session;
 * no body accepts them (forbidNonWhitelisted). Malformed ids are refused by the global UuidPathParamsInterceptor (404).
 */
@Controller('rest/v1/ai')
@ManagerApplication()
@UseGuards(JwtAuthGuard)
export class AiConversationController {
  constructor(
    private readonly conversations: AiConversationService,
    private readonly sse: AiSseService,
  ) {}

  /** Never 404s for "unavailable": tells the web UI which state to show (and the limits to enforce in the composer). */
  @Get('availability')
  availability(@AuthUser() ctx: AuthContext) {
    return this.conversations.availability(ctx);
  }

  @Post('conversations')
  @UseGuards(AiAvailableGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateAiConversationDto) {
    return this.conversations.create(ctx, dto);
  }

  @Get('conversations')
  @UseGuards(AiAvailableGuard)
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListAiConversationsDto) {
    return this.conversations.list(ctx, dto);
  }

  @Get('conversations/:id')
  @UseGuards(AiAvailableGuard)
  get(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.get(ctx, id);
  }

  /** 202: the question is queued; follow it on the stream. The per-user/org limits answer 429 with `retryAfterSeconds`. */
  @Post('conversations/:id/messages')
  @HttpCode(202)
  @UseGuards(AiAvailableGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  submit(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PostAiMessageDto) {
    return this.conversations.submit(ctx, id, dto);
  }

  @Post('conversations/:id/turns/:turnId/cancel')
  @HttpCode(200)
  @UseGuards(AiAvailableGuard)
  cancel(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('turnId', ParseUUIDPipe) turnId: string) {
    return this.conversations.cancel(ctx, id, turnId);
  }

  /** The owner may always delete their own conversation (no availability gate: erasure never depends on a switch). */
  @Delete('conversations/:id')
  @HttpCode(204)
  async remove(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.conversations.remove(ctx, id);
  }

  @Sse('conversations/:id/stream')
  @UseGuards(AiAvailableGuard, AiStreamAccessGuard)
  stream(
    @AuthUser() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: StreamAiTurnDto,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<Observable<MessageEvent>> {
    return this.sse.open(ctx, id, dto.turnId, lastEventId);
  }
}

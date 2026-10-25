import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { AiSkillActionDto, CreateAiSkillDto, UpdateAiSkillDto } from '../dto/ai-skill.dto';
import { AiSkillService } from '../services/ai-skill.service';
import { AiAvailableGuard } from './ai-available.guard';

const WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * AI Phase 4 skills API (docs/ai/PHASE4_TWENTY_PLAN.md §2.6; route table AI_API_ROUTES / AI_CONTRACTS §3). Web console
 * only (`@ManagerApplication`). Transport only: every rule is in AiSkillService, which re-checks it (layer 2).
 *
 *   GET  /ai/skills                                   AiAvailableGuard: the composer's tag menu (active skills' name,
 *                                                      label and description; never content)
 *   GET  /ai/settings/skills                           PermissionGuard(ai.settings) + CEO (service): built-ins + custom
 *   POST /ai/settings/skills                           create a custom skill
 *   PATCH/DELETE /ai/settings/skills/:id               label/description/content; delete (custom only)
 *   POST /ai/settings/skills/:id/(activate|deactivate) named actions — there is no `isActive` field
 *   POST /ai/settings/skills/builtin/:name/(activate|deactivate)  a built-in is switched, never edited
 * Writes need a recent step-up (`organisation.ai.skill.update`) and a reason; they answer the fresh settings view.
 * Malformed `:id` values are refused 404 by the global UuidPathParamsInterceptor (and again by the service).
 */
@Controller('rest/v1/ai')
@ManagerApplication()
export class AiSkillsController {
  constructor(private readonly skills: AiSkillService) {}

  @Get('skills')
  @UseGuards(JwtAuthGuard, AiAvailableGuard)
  chatList(@AuthUser() ctx: AuthContext) {
    return this.skills.listForChat(ctx);
  }

  @Get('settings/skills')
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  list(@AuthUser() ctx: AuthContext) {
    return this.skills.listForSettings(ctx);
  }

  @Post('settings/skills')
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  @Throttle(WRITE_THROTTLE)
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateAiSkillDto) {
    return this.skills.create(ctx, { name: dto.name, label: dto.label, description: dto.description, content: dto.content, reason: dto.reason });
  }

  @Patch('settings/skills/:id')
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  @Throttle(WRITE_THROTTLE)
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateAiSkillDto) {
    return this.skills.update(ctx, id, { label: dto.label, description: dto.description, content: dto.content, reason: dto.reason });
  }

  @Delete('settings/skills/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  @Throttle(WRITE_THROTTLE)
  remove(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: AiSkillActionDto) {
    return this.skills.remove(ctx, id, dto.reason);
  }

  @Post('settings/skills/:id/activate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  @Throttle(WRITE_THROTTLE)
  activate(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: AiSkillActionDto) {
    return this.skills.activate(ctx, { id }, dto.reason);
  }

  @Post('settings/skills/:id/deactivate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  @Throttle(WRITE_THROTTLE)
  deactivate(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: AiSkillActionDto) {
    return this.skills.deactivate(ctx, { id }, dto.reason);
  }

  @Post('settings/skills/builtin/:name/activate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  @Throttle(WRITE_THROTTLE)
  activateBuiltin(@AuthUser() ctx: AuthContext, @Param('name') name: string, @Body() dto: AiSkillActionDto) {
    return this.skills.activate(ctx, { builtin: name }, dto.reason);
  }

  @Post('settings/skills/builtin/:name/deactivate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
  @Throttle(WRITE_THROTTLE)
  deactivateBuiltin(@AuthUser() ctx: AuthContext, @Param('name') name: string, @Body() dto: AiSkillActionDto) {
    return this.skills.deactivate(ctx, { builtin: name }, dto.reason);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AiAgentActionDto, CreateAiAgentDto, CreateAiAgentTriggerDto, SetAiAgentRoleDto, UpdateAiAgentDto, UpdateAiAgentTriggerDto } from '../dto/ai-agent.dto';
import { AiAgentRoleService } from '../services/ai-agent-role.service';
import { AiAgentTriggerService } from '../services/ai-agent-trigger.service';
import { AiAgentService } from '../services/ai-agent.service';
import { AiAgentsSwitchGuard } from './ai-agents-switch.guard';

const WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * AI Phase 6a agents API — STORAGE ONLY (docs/ai/PHASE6_TWENTY_PLAN.md §4; AI_API_ROUTES / AI_CONTRACTS §3, XD-3). Web
 * console only (`@ManagerApplication`). Transport only: every rule lives in the services, which re-check it (layer 2).
 *
 *   GET/POST          /ai/agents                                  list (live agents + triggers) / create
 *   GET/PATCH/DELETE  /ai/agents/:id                              one agent / edit (never the name) / soft delete
 *   GET/PUT           /ai/agents/:id/role                         the agent role's flags (REQUEST.md: new routes)
 *   POST              /ai/agents/:id/triggers                     create a trigger (stored switched OFF)
 *   PATCH/DELETE      /ai/agents/:id/triggers/:triggerId          edit the schedule / events; delete
 *   POST              /ai/agents/:id/triggers/:triggerId/enable   REFUSED 409 AI_AGENT_EXECUTION_NOT_APPROVED (EX-3)
 *   POST              /ai/agents/:id/triggers/:triggerId/disable  always allowed
 * There is no run, runs or test route (6b, after EX-3). Every route: JwtAuthGuard → AiAgentsSwitchGuard (uniform 404 while
 * AI_AGENTS_ENABLED / AI_ENABLED is off, and — p6 merge — no ai.use / ai.agents.manage / not the CEO: the same 404, never a
 * 403). Writes need a recent step-up
 * (`organisation.ai.agent.update`) and a reason. Malformed ids are refused 404 by the global UuidPathParamsInterceptor
 * (and again by the services).
 */
@Controller('rest/v1/ai/agents')
@ManagerApplication()
export class AiAgentController {
  constructor(
    private readonly agents: AiAgentService,
    private readonly triggers: AiAgentTriggerService,
    private readonly roles: AiAgentRoleService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  list(@AuthUser() ctx: AuthContext) {
    return this.agents.list(ctx);
  }

  @Post()
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateAiAgentDto) {
    return this.agents.create(ctx, {
      name: dto.name,
      label: dto.label,
      description: dto.description,
      prompt: dto.prompt,
      model: { tier: dto.model.tier, modelId: dto.model.modelId ?? null },
      responseFormat: dto.responseFormat,
      roleId: dto.roleId,
      reason: dto.reason,
    });
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.agents.get(ctx, id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateAiAgentDto) {
    return this.agents.update(ctx, id, {
      label: dto.label,
      description: dto.description,
      prompt: dto.prompt,
      model: dto.model === undefined ? undefined : { tier: dto.model.tier, modelId: dto.model.modelId ?? null },
      responseFormat: dto.responseFormat,
      roleId: dto.roleId,
      reason: dto.reason,
    });
  }

  @Delete(':id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  remove(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: AiAgentActionDto) {
    return this.agents.remove(ctx, id, dto.reason);
  }

  @Get(':id/role')
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  role(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.roles.get(ctx, id);
  }

  @Put(':id/role')
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  setRole(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: SetAiAgentRoleDto) {
    return this.roles.setFlags(ctx, id, { flags: dto.flags, reason: dto.reason });
  }

  @Post(':id/triggers')
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  createTrigger(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: CreateAiAgentTriggerDto) {
    return this.triggers.create(ctx, id, {
      kind: dto.kind,
      schedule: dto.schedule === undefined ? undefined : { every: dto.schedule.every, at: dto.schedule.at, ...(dto.schedule.dow === undefined ? {} : { dow: dto.schedule.dow }) },
      eventTypes: dto.eventTypes,
      reason: dto.reason,
    });
  }

  @Patch(':id/triggers/:triggerId')
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  updateTrigger(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('triggerId') triggerId: string, @Body() dto: UpdateAiAgentTriggerDto) {
    return this.triggers.update(ctx, id, triggerId, {
      schedule: dto.schedule === undefined ? undefined : { every: dto.schedule.every, at: dto.schedule.at, ...(dto.schedule.dow === undefined ? {} : { dow: dto.schedule.dow }) },
      eventTypes: dto.eventTypes,
      reason: dto.reason,
    });
  }

  @Delete(':id/triggers/:triggerId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  removeTrigger(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('triggerId') triggerId: string, @Body() dto: AiAgentActionDto) {
    return this.triggers.remove(ctx, id, triggerId, dto.reason);
  }

  /** EX-3 not approved: always 409 AI_AGENT_EXECUTION_NOT_APPROVED after the usual authorisation (outsiders get 404). */
  @Post(':id/triggers/:triggerId/enable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  enableTrigger(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('triggerId') triggerId: string, @Body() dto: AiAgentActionDto) {
    void dto;
    return this.triggers.enable(ctx, id, triggerId);
  }

  @Post(':id/triggers/:triggerId/disable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AiAgentsSwitchGuard)
  @Throttle(WRITE_THROTTLE)
  disableTrigger(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('triggerId') triggerId: string, @Body() dto: AiAgentActionDto) {
    return this.triggers.disable(ctx, id, triggerId, dto.reason);
  }
}

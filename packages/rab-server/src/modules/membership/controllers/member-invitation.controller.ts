import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { ListMemberInvitationsDto, SendMemberInvitationsDto } from '../dto/member-invitation.dto';
import { MemberInvitationService } from '../services/member-invitation.service';

/**
 * Administrator side of email-first workspace-member invitations. The route guard requires ROLE_MANAGE (assigning a
 * role is role management, as in Twenty); `MemberInvitationService` then re-derives, inside each transaction, that
 * the caller owns their workspace, which custom roles they may assign, and which invitations they may act on
 * (another workspace's ⇒ 404). Organisation and workspace are never read from the request.
 */
@ManagerApplication()
@Controller('rest/v1/member-invitations')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.ROLE_MANAGE))
export class MemberInvitationController {
  constructor(private readonly invitations: MemberInvitationService) {}

  @Get('assignable-roles')
  assignableRoles(@AuthUser() ctx: AuthContext) {
    return this.invitations.assignableRoles(ctx);
  }

  @Get()
  list(@AuthUser() ctx: AuthContext, @Query() query: ListMemberInvitationsDto) {
    return this.invitations.list(ctx, query.page ?? 1, query.limit ?? 25, { q: query.q, status: query.status });
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  send(@AuthUser() ctx: AuthContext, @Body() dto: SendMemberInvitationsDto) {
    return this.invitations.send(ctx, dto.emails, dto.roleId);
  }

  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  resend(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.invitations.resend(ctx, id);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.invitations.revoke(ctx, id);
  }
}

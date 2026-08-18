import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { NotificationService } from '../services/notification.service';

/** Every authenticated user has their own inbox — no permission flag beyond auth, same pattern as `/offers/mine`. */
@Controller('rest/v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  list(@AuthUser() ctx: AuthContext) {
    return this.notificationService.list(ctx);
  }

  @Get('unread-count')
  unreadCount(@AuthUser() ctx: AuthContext) {
    return this.notificationService.unreadCount(ctx);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.notificationService.markRead(ctx, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  markAllRead(@AuthUser() ctx: AuthContext) {
    return this.notificationService.markAllRead(ctx);
  }
}

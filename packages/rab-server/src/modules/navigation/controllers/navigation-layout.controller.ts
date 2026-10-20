import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { SaveNavigationLayoutDto } from '../dto/save-navigation-layout.dto';
import { NavigationLayoutService } from '../services/navigation-layout.service';

/**
 * The caller's own sidebar layout ("Your navigation") for their workspace. Web console only (`@ManagerApplication()`:
 * mobile Staff / Venue Manager tokens are refused); cookie mutations pass the JwtAuthGuard CSRF/origin check; no
 * permission flag because a user always may arrange their OWN navigation — and nothing here grants access to anything.
 */
@Controller('rest/v1/navigation-layout')
@UseGuards(JwtAuthGuard, RequireWorkspaceGuard)
@ManagerApplication()
export class NavigationLayoutController {
  constructor(private readonly layouts: NavigationLayoutService) {}

  @Get()
  get(@AuthUser() ctx: AuthContext) {
    return this.layouts.get(ctx);
  }

  @Put()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  save(@AuthUser() ctx: AuthContext, @Body() dto: SaveNavigationLayoutDto) {
    return this.layouts.save(ctx, dto);
  }
}

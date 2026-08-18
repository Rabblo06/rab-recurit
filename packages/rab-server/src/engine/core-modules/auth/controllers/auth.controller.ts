import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../decorators/auth-user.decorator';
import { AuthContext } from '../../tenant/auth-context.interface';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { SetPasswordDto } from '../dto/set-password.dto';
import { AuthenticatedRequest, JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthService, AuthTokens, LoginResult } from '../services/auth.service';

function requestMeta(request: AuthenticatedRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

@Controller('rest/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() request: AuthenticatedRequest): Promise<LoginResult> {
    return this.authService.login(dto, requestMeta(request));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto, @Req() request: AuthenticatedRequest): Promise<AuthTokens> {
    return this.authService.refresh(dto.refreshToken, requestMeta(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(@Body() dto: RefreshDto, @AuthUser() ctx: AuthContext): Promise<void> {
    await this.authService.logout(ctx, dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@AuthUser() ctx: AuthContext) {
    return this.authService.me(ctx);
  }

  /** The forced-reset completion step — see AuthService.setPassword's doc comment. */
  @Post('set-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async setPassword(@Body() dto: SetPasswordDto, @AuthUser() ctx: AuthContext): Promise<void> {
    await this.authService.setPassword(ctx, dto.newPassword);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.authService.resetPassword(dto);
  }
}

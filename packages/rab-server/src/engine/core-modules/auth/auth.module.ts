import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './controllers/auth.controller';
import { AccountLifecycleService } from './services/account-lifecycle.service';
import { AuthService } from './services/auth.service';
import { PasswordHashingService } from './services/password-hashing.service';
import { AccessTokenService } from './token/services/access-token.service';
import { PasswordResetTokenService } from './token/services/password-reset-token.service';
import { RefreshTokenService } from './token/services/refresh-token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MaintenanceModeGuard } from './guards/maintenance-mode.guard';
import { MustResetPasswordGuard } from './guards/must-reset-password.guard';

@Module({
  // No default secret/options here — AccessTokenService passes APP_SECRET
  // explicitly on every sign()/verify() call instead, so it stays sourced
  // from EnvironmentService rather than duplicated into JwtModule config.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccountLifecycleService,
    PasswordHashingService,
    AccessTokenService,
    RefreshTokenService,
    PasswordResetTokenService,
    JwtAuthGuard,
    MustResetPasswordGuard,
    MaintenanceModeGuard,
  ],
  exports: [
    AccessTokenService,
    AccountLifecycleService,
    JwtAuthGuard,
    MustResetPasswordGuard,
    MaintenanceModeGuard,
    PasswordHashingService,
    PasswordResetTokenService,
    RefreshTokenService,
  ],
})
export class AuthModule {}

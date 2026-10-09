import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ThrottlerRedisClientModule } from '../throttler/throttler-redis-client.module';
import { AuthController } from './controllers/auth.controller';
import { GoogleAuthController } from './controllers/google-auth.controller';
import { MicrosoftAuthController } from './controllers/microsoft-auth.controller';
import { AccountInviteService } from './services/account-invite.service';
import { AccountLifecycleService } from './services/account-lifecycle.service';
import { AuthCacheRedisClientProvider } from './services/auth-cache-redis-client.provider';
import { AuthContextCacheService } from './services/auth-context-cache.service';
import { AuthSecuritySnapshotService } from './services/auth-security-snapshot.service';
import { AuthService } from './services/auth.service';
import { OAuthTransactionStateService } from './services/oauth-transaction-state.service';
import { OidcClientFactoryService } from './services/oidc-client-factory.service';
import { OidcLoginService } from './services/oidc-login.service';
import { OrganisationAuthProvidersService } from './services/organisation-auth-providers.service';
import { PasswordHashingService } from './services/password-hashing.service';
import { SecurityVersionService } from './services/security-version.service';
import { SessionValidityService } from './services/session-validity.service';
import { UserAuthIdentityService } from './services/user-auth-identity.service';
import { AccessTokenService } from './token/services/access-token.service';
import { PasswordResetTokenService } from './token/services/password-reset-token.service';
import { RefreshTokenService } from './token/services/refresh-token.service';
import { ActiveAccountGuard } from './guards/active-account.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MaintenanceModeGuard } from './guards/maintenance-mode.guard';
import { MustResetPasswordGuard } from './guards/must-reset-password.guard';

@Module({
  // No default secret/options here — AccessTokenService passes APP_SECRET
  // explicitly on every sign()/verify() call instead, so it stays sourced
  // from EnvironmentService rather than duplicated into JwtModule config.
  imports: [JwtModule.register({}), ThrottlerRedisClientModule],
  controllers: [AuthController, GoogleAuthController, MicrosoftAuthController],
  providers: [
    AuthService,
    AccountLifecycleService,
    AccountInviteService,
    PasswordHashingService,
    AccessTokenService,
    RefreshTokenService,
    PasswordResetTokenService,
    SessionValidityService,
    AuthSecuritySnapshotService,
    SecurityVersionService,
    AuthCacheRedisClientProvider,
    AuthContextCacheService,
    OrganisationAuthProvidersService,
    UserAuthIdentityService,
    OAuthTransactionStateService,
    OidcClientFactoryService,
    OidcLoginService,
    JwtAuthGuard,
    ActiveAccountGuard,
    MustResetPasswordGuard,
    MaintenanceModeGuard,
  ],
  exports: [
    AccessTokenService,
    AccountLifecycleService,
    AccountInviteService,
    JwtAuthGuard,
    ActiveAccountGuard,
    MustResetPasswordGuard,
    MaintenanceModeGuard,
    PasswordHashingService,
    PasswordResetTokenService,
    RefreshTokenService,
    SessionValidityService,
    AuthSecuritySnapshotService,
    SecurityVersionService,
    AuthContextCacheService,
    OrganisationAuthProvidersService,
    UserAuthIdentityService,
  ],
})
export class AuthModule {}

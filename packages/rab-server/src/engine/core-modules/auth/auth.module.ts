import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ThrottlerRedisClientModule } from '../throttler/throttler-redis-client.module';
import { AuthController } from './controllers/auth.controller';
import { GoogleAuthController } from './controllers/google-auth.controller';
import { MicrosoftAuthController } from './controllers/microsoft-auth.controller';
import { OAuthHandoffController } from './controllers/oauth-handoff.controller';
import { MfaAdminController, MfaController } from './controllers/mfa.controller';
import { MfaStore } from './mfa/mfa-store';
import { MfaChallengeService } from './services/mfa-challenge.service';
import { MfaFactorService } from './services/mfa-factor.service';
import { MfaLoginService } from './services/mfa-login.service';
import { MfaManagementService } from './services/mfa-management.service';
import { AccountInviteService } from './services/account-invite.service';
import { AccountLifecycleService } from './services/account-lifecycle.service';
import { AuthCacheRedisClientProvider } from './services/auth-cache-redis-client.provider';
import { AuthContextCacheService } from './services/auth-context-cache.service';
import { AuthSecuritySnapshotService } from './services/auth-security-snapshot.service';
import { AuthService } from './services/auth.service';
import { LoginAttemptLimiterService } from './services/login-attempt-limiter.service';
import { AuthCookieMigrationService } from './services/auth-cookie-migration.service';
import { LoginSecondFactorPolicyService } from './services/login-second-factor-policy.service';
import { OAuthInvitationHandlerRegistry } from './services/oauth-invitation-handler.registry';
import { OAuthSignInFlowService } from './services/oauth-sign-in-flow.service';
import { OAuthTransactionStateService } from './services/oauth-transaction-state.service';
import { OidcClientFactoryService } from './services/oidc-client-factory.service';
import { OidcLoginService } from './services/oidc-login.service';
import { OrganisationAuthProvidersService } from './services/organisation-auth-providers.service';
import { PasswordHashingService } from './services/password-hashing.service';
import { PasswordSessionRevocationService } from './services/password-session-revocation.service';
import { SecurityVersionService } from './services/security-version.service';
import { SessionValidityService } from './services/session-validity.service';
import { StepUpReauthService } from './services/step-up-reauth.service';
import { MfaSecurityNoticeService } from './services/mfa-security-notice.service';
import { OidcReauthService } from './services/oidc-reauth.service';
import { UserAuthIdentityService } from './services/user-auth-identity.service';
import { UserSessionCacheService } from './services/user-session-cache.service';
import { AccessTokenService } from './token/services/access-token.service';
import { PasswordResetTokenService } from './token/services/password-reset-token.service';
import { RefreshTokenService } from './token/services/refresh-token.service';
import { ActiveAccountGuard } from './guards/active-account.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MaintenanceModeGuard } from './guards/maintenance-mode.guard';
import { MustResetPasswordGuard } from './guards/must-reset-password.guard';
import { OrganisationSuspendedGuard } from './guards/organisation-suspended.guard';

@Module({
  // No default secret/options here — AccessTokenService passes its purpose key
  // (keyring kid, or the HKDF-derived default) explicitly on every sign()/verify()
  // call, so no APP_SECRET-rooted key is ever duplicated into JwtModule config.
  imports: [JwtModule.register({}), ThrottlerRedisClientModule],
  controllers: [AuthController, GoogleAuthController, MicrosoftAuthController, OAuthHandoffController, MfaController, MfaAdminController],
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
    UserSessionCacheService,
    OrganisationAuthProvidersService,
    UserAuthIdentityService,
    OAuthTransactionStateService,
    OidcClientFactoryService,
    OidcLoginService,
    OAuthSignInFlowService,
    OAuthInvitationHandlerRegistry,
    LoginSecondFactorPolicyService,
    LoginAttemptLimiterService,
    AuthCookieMigrationService,
    PasswordSessionRevocationService,
    JwtAuthGuard,
    ActiveAccountGuard,
    MustResetPasswordGuard,
    MaintenanceModeGuard,
    OrganisationSuspendedGuard,
    StepUpReauthService,
    // Wave 4 lane MFA
    MfaStore,
    MfaChallengeService,
    MfaFactorService,
    MfaLoginService,
    MfaManagementService,
    // Account security step 1
    MfaSecurityNoticeService,
    OidcReauthService,
  ],
  exports: [
    // Wave 4 lane MFA: LoginHandoffModule issues the workspace-host session through the same AuthService.
    AuthService,
    AccessTokenService,
    AccountLifecycleService,
    AccountInviteService,
    JwtAuthGuard,
    ActiveAccountGuard,
    MustResetPasswordGuard,
    MaintenanceModeGuard,
    OrganisationSuspendedGuard,
    PasswordHashingService,
    PasswordResetTokenService,
    RefreshTokenService,
    SessionValidityService,
    AuthSecuritySnapshotService,
    SecurityVersionService,
    AuthContextCacheService,
    UserSessionCacheService,
    OrganisationAuthProvidersService,
    UserAuthIdentityService,
    StepUpReauthService,
    OAuthInvitationHandlerRegistry,
    // Redis checkpoint — Core/Workspace Metadata Cache: exported so EntityCacheModule can reuse
    // this exact fail-fast client (same REDIS_URL, same bounded-timeout config already tuned for
    // a request's hot path) instead of opening a second connection. See that provider's own doc
    // comment for why its timeout/retry shape differs from BullMQ's/the throttler's own client.
    AuthCacheRedisClientProvider,
  ],
})
export class AuthModule {}

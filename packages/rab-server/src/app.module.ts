import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { coreDataSourceOptions } from './database/typeorm/core/core.datasource';
import { AuditModule } from './engine/core-modules/audit/audit.module';
import { AuthModule } from './engine/core-modules/auth/auth.module';
import { EmailModule } from './engine/core-modules/email/email.module';
import { EnvironmentModule } from './engine/core-modules/environment/environment.module';
import { HealthModule } from './engine/core-modules/health/health.module';
import { PermissionsModule } from './engine/core-modules/permissions/permissions.module';
import { AdminPanelModule } from './engine/core-modules/platform-admin/admin-panel.module';
import { PlatformAdminModule } from './engine/core-modules/platform-admin/platform-admin.module';
import { ResourceScopeModule } from './engine/core-modules/resource-scope/resource-scope.module';
import { SecretEncryptionModule } from './engine/core-modules/secret-encryption/secret-encryption.module';
import { StorageModule } from './engine/core-modules/storage/storage.module';
import { TenantModule } from './engine/core-modules/tenant/tenant.module';
import { RabThrottlerModule } from './engine/core-modules/throttler/throttler.module';
import { AllExceptionsFilter } from './engine/filters/all-exceptions.filter';
import { InvalidTransitionFilter } from './engine/filters/invalid-transition.filter';
import { IdentityModule } from './modules/identity/identity.module';
import { ManagerModule } from './modules/manager/manager.module';
import { NotificationModule } from './modules/notification/notification.module';
import { OfferModule } from './modules/offer/offer.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { StaffModule } from './modules/staff/staff.module';
import { VenueModule } from './modules/venue/venue.module';

@Module({
  imports: [
    EnvironmentModule,
    TypeOrmModule.forRoot(coreDataSourceOptions),
    HealthModule,
    RabThrottlerModule,
    TenantModule,
    SecretEncryptionModule,
    PermissionsModule,
    PlatformAdminModule,
    ResourceScopeModule,
    AdminPanelModule,
    StorageModule,
    AuditModule,
    EmailModule,
    AuthModule,
    IdentityModule,
    StaffModule,
    ManagerModule,
    VenueModule,
    SchedulingModule,
    NotificationModule,
    OfferModule,
  ],
  providers: [
    // Order matters — Nest checks APP_FILTER providers in reverse
    // registration order (confirmed empirically: registering
    // AllExceptionsFilter second still made it run first and shadow
    // InvalidTransitionFilter, breaking every 409-on-bad-transition test).
    // AllExceptionsFilter must be declared first so InvalidTransitionFilter
    // — the more specific one — is actually checked first at runtime.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: InvalidTransitionFilter },
  ],
})
export class AppModule {}

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
import { SecretEncryptionModule } from './engine/core-modules/secret-encryption/secret-encryption.module';
import { TenantModule } from './engine/core-modules/tenant/tenant.module';
import { InvalidTransitionFilter } from './engine/filters/invalid-transition.filter';
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
    TenantModule,
    SecretEncryptionModule,
    PermissionsModule,
    AuditModule,
    EmailModule,
    AuthModule,
    StaffModule,
    ManagerModule,
    VenueModule,
    SchedulingModule,
    NotificationModule,
    OfferModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: InvalidTransitionFilter }],
})
export class AppModule {}

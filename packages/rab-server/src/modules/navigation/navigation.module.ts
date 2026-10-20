import { Module } from '@nestjs/common';
import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { StaffModule } from '../staff/staff.module';
import { VenueModule } from '../venue/venue.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ManagerModule } from '../manager/manager.module';
import { RealtimeEventModule } from '../../engine/core-modules/realtime/realtime-event.module';
import { NavigationLayoutController } from './controllers/navigation-layout.controller';
import { NavigationLayoutService } from './services/navigation-layout.service';

/** Personal sidebar layout (draft/Save/Cancel editor). Reads the domain modules' scoped services to re-check shortcuts. */
@Module({
  imports: [AuthModule, StaffModule, VenueModule, SchedulingModule, ManagerModule, RealtimeEventModule],
  controllers: [NavigationLayoutController],
  providers: [NavigationLayoutService],
})
export class NavigationModule {}

import { Module, OnModuleInit } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { EntityCacheModule } from '../../engine/core-modules/entity-cache/entity-cache.module';
import { FileAccessRegistry } from '../../engine/core-modules/storage/file-access.registry';
import { FileKind } from '../../engine/core-modules/storage/file-kinds';
import { VenueController } from './controllers/venue.controller';
import { VenuePhotoFilePolicy } from './files/venue-photo-file.policy';
import { VenueService } from './services/venue.service';

@Module({
  imports: [AuthModule, EntityCacheModule],
  controllers: [VenueController],
  providers: [VenueService],
  exports: [VenueService],
})
export class VenueModule implements OnModuleInit {
  constructor(
    private readonly registry: FileAccessRegistry,
    private readonly venueService: VenueService,
  ) {}

  onModuleInit(): void {
    // engine/ cannot import modules/: the venue domain registers its own read rule for venue photos (see VenuePhotoFilePolicy).
    this.registry.register([FileKind.VENUE_PHOTO], new VenuePhotoFilePolicy(this.venueService));
  }
}

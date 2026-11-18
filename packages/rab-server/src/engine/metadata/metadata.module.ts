import { Module } from '@nestjs/common';

import { DataModelAuthorityService } from './services/data-model-authority.service';
import { MetadataReadService } from './services/metadata-read.service';

/**
 * Metadata engine (OWNER-METADATA-ENGINE.md; M0-BACKEND.md §2.1): platform machinery under engine/, so it never imports
 * modules/ (CLAUDE.md). M1 / E1 ships the read service; M2 phase 1 adds the layer-2 data-model authority (PermissionsService
 * comes from the global PermissionsModule). Later phases import this module.
 */
@Module({
  providers: [MetadataReadService, DataModelAuthorityService],
  exports: [MetadataReadService, DataModelAuthorityService],
})
export class MetadataModule {}

import { Module } from '@nestjs/common';

import { MetadataReadService } from './services/metadata-read.service';

/**
 * Metadata engine (OWNER-METADATA-ENGINE.md; M0-BACKEND.md §2.1): platform machinery under engine/, so it never imports
 * modules/ (CLAUDE.md). M1 / E1 ships only the read service; later phases import this module.
 */
@Module({
  providers: [MetadataReadService],
  exports: [MetadataReadService],
})
export class MetadataModule {}

import { Global, Module, OnModuleInit } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FileAccessRegistry } from './file-access.registry';
import { FileKind } from './file-kinds';
import { FileService } from './file.service';
import { FilesController } from './files.controller';
import { StorageDriverFactory } from './storage-driver.factory';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [FilesController],
  providers: [StorageDriverFactory, FileService, FileAccessRegistry],
  exports: [FileService, FileAccessRegistry, StorageDriverFactory],
})
export class StorageModule implements OnModuleInit {
  constructor(private readonly registry: FileAccessRegistry) {}

  onModuleInit(): void {
    // Logos (PROFILE_IMAGE is registered by ProfileService, which owns what an avatar upload means): the tenant/workspace boundary is enforced by RLS on `stored_file`; there is no finer rule.
    // Document kinds (report PDFs) register their own stricter policy from the domain module that owns them.
    this.registry.register([FileKind.ORGANISATION_LOGO, FileKind.WORKSPACE_LOGO], { canRead: async () => true });
  }
}

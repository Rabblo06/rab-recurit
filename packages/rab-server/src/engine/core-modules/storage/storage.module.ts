import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesController } from './files.controller';
import { StorageDriverFactory } from './storage-driver.factory';
import { StorageService } from './storage.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [FilesController],
  providers: [StorageDriverFactory, StorageService],
  exports: [StorageService],
})
export class StorageModule {}

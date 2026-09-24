import { Injectable } from '@nestjs/common';

import { EnvironmentService } from '../environment/environment.service';
import { StorageDriverInterface } from './drivers/interfaces/storage-driver.interface';
import { LocalDiskDriver } from './drivers/local-disk.driver';
import { S3StorageDriver } from './drivers/s3.driver';
import { StorageDriver } from './enums/storage-driver.enum';

/**
 * One driver per process, selected from validated env. The S3 client (and
 * its connection pool) is created once and reused; env cannot change at
 * runtime so there is nothing to invalidate.
 */
@Injectable()
export class StorageDriverFactory {
  private cached?: StorageDriverInterface;

  constructor(private readonly env: EnvironmentService) {}

  getDriver(): StorageDriverInterface {
    if (this.cached) return this.cached;
    const driver = this.env.get('STORAGE_DRIVER');
    switch (driver) {
      case StorageDriver.LOCAL:
        this.cached = new LocalDiskDriver(this.env.get('STORAGE_LOCAL_ROOT'));
        break;
      case StorageDriver.S3:
        // env.validation.ts already refused to boot without these.
        this.cached = new S3StorageDriver({
          bucket: this.env.get('S3_BUCKET')!,
          region: this.env.get('S3_REGION')!,
          endpoint: this.env.get('S3_ENDPOINT'),
          accessKeyId: this.env.get('S3_ACCESS_KEY_ID')!,
          secretAccessKey: this.env.get('S3_SECRET_ACCESS_KEY')!,
          forcePathStyle: this.env.get('S3_FORCE_PATH_STYLE'),
          serverSideEncryption: this.env.get('S3_SERVER_SIDE_ENCRYPTION'),
          kmsKeyId: this.env.get('S3_KMS_KEY_ID'),
        });
        break;
      default:
        throw new Error(`Invalid STORAGE_DRIVER: "${driver}". Expected LOCAL or S3.`);
    }
    return this.cached;
  }
}

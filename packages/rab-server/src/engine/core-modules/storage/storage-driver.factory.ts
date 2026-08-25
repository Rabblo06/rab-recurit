import { Injectable } from '@nestjs/common';

import { EnvironmentService } from '../environment/environment.service';
import { StorageDriverInterface } from './drivers/interfaces/storage-driver.interface';
import { LocalDiskDriver } from './drivers/local-disk.driver';
import { StorageDriver } from './enums/storage-driver.enum';

/** Same shape as EmailDriverFactory — resolved fresh per call, env-selected. */
@Injectable()
export class StorageDriverFactory {
  constructor(private readonly env: EnvironmentService) {}

  getDriver(): StorageDriverInterface {
    const driver = this.env.get('STORAGE_DRIVER');
    switch (driver) {
      case StorageDriver.LOCAL:
        return new LocalDiskDriver(this.env.get('STORAGE_LOCAL_ROOT'));
      default:
        throw new Error(`Invalid STORAGE_DRIVER: "${driver}". Expected LOCAL.`);
    }
  }
}

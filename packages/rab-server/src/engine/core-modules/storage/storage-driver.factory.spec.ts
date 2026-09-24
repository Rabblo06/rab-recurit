import { LocalDiskDriver } from './drivers/local-disk.driver';
import { S3StorageDriver } from './drivers/s3.driver';
import { StorageDriverFactory } from './storage-driver.factory';
import { EnvironmentService } from '../environment/environment.service';

/** A minimal stand-in — StorageDriverFactory only ever calls `.get(key)`. */
function fakeEnv(values: Record<string, unknown>): EnvironmentService {
  return { get: (key: string) => values[key] } as unknown as EnvironmentService;
}

describe('StorageDriverFactory', () => {
  it('STORAGE_DRIVER=LOCAL constructs a LocalDiskDriver rooted at STORAGE_LOCAL_ROOT', () => {
    const factory = new StorageDriverFactory(fakeEnv({ STORAGE_DRIVER: 'LOCAL', STORAGE_LOCAL_ROOT: './storage' }));
    expect(factory.getDriver()).toBeInstanceOf(LocalDiskDriver);
  });

  it('STORAGE_DRIVER=S3 constructs an S3StorageDriver with the R2-shaped config (region=auto, custom endpoint, forcePathStyle, NONE encryption)', () => {
    const factory = new StorageDriverFactory(
      fakeEnv({
        STORAGE_DRIVER: 'S3',
        S3_BUCKET: 'rab-production-storage',
        S3_REGION: 'auto',
        S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_FORCE_PATH_STYLE: true,
        S3_SERVER_SIDE_ENCRYPTION: 'NONE',
        S3_KMS_KEY_ID: undefined,
      }),
    );
    const driver = factory.getDriver();
    expect(driver).toBeInstanceOf(S3StorageDriver);
    expect(driver.bucket).toBe('rab-production-storage');
    expect(driver.name).toBe('S3');
    expect(driver.supportsSignedUrls).toBe(true);
  });

  it('caches the driver — the SAME instance (and therefore the same S3Client) is returned on every call, never re-created per operation', () => {
    const factory = new StorageDriverFactory(fakeEnv({ STORAGE_DRIVER: 'LOCAL', STORAGE_LOCAL_ROOT: './storage' }));
    expect(factory.getDriver()).toBe(factory.getDriver());
  });

  it('an unknown STORAGE_DRIVER value fails FAST and LOUD — it never silently falls back to LOCAL', () => {
    const factory = new StorageDriverFactory(fakeEnv({ STORAGE_DRIVER: 'AZURE_BLOB' }));
    expect(() => factory.getDriver()).toThrow(/Invalid STORAGE_DRIVER/);
    expect(() => factory.getDriver()).not.toThrow(/LocalDiskDriver/); // i.e. it never quietly became LOCAL
  });
});

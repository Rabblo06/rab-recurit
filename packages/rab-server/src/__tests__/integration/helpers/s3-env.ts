/**
 * Import FIRST in any spec that boots AppModule against the S3 driver:
 * `AppModule`'s ConfigModule freezes the environment at IMPORT time.
 *
 * Defaults point at the throwaway MinIO from `packages/rab-docker/docker-compose.yml`
 * (`docker compose --profile s3 up -d minio minio-init`). They are dev-only test
 * values for a localhost container, never real credentials. CI supplies its own
 * via RAB_TEST_S3_* and needs no cloud account.
 */
export const S3_TEST = {
  endpoint: process.env.RAB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  bucket: process.env.RAB_TEST_S3_BUCKET ?? 'rab-dev',
  region: process.env.RAB_TEST_S3_REGION ?? 'eu-west-2',
  accessKeyId: process.env.RAB_TEST_S3_ACCESS_KEY_ID ?? 'rab_minio_dev',
  secretAccessKey: process.env.RAB_TEST_S3_SECRET_ACCESS_KEY ?? 'rab_minio_dev_only_secret',
  enabled: process.env.RAB_TEST_S3 === '1',
};

export function useS3Env(overrides: Record<string, string> = {}): void {
  process.env.STORAGE_DRIVER = 'S3';
  process.env.S3_BUCKET = S3_TEST.bucket;
  process.env.S3_REGION = S3_TEST.region;
  process.env.S3_ENDPOINT = S3_TEST.endpoint;
  process.env.S3_ACCESS_KEY_ID = S3_TEST.accessKeyId;
  process.env.S3_SECRET_ACCESS_KEY = S3_TEST.secretAccessKey;
  process.env.S3_FORCE_PATH_STYLE = 'true';
  process.env.S3_SERVER_SIDE_ENCRYPTION = 'AES256';
  process.env.STORAGE_KEY_PREFIX = 'test';
  Object.assign(process.env, overrides);
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S3_TEST, useS3Env } from './s3-env';

/**
 * FIRST import of the multi-worker storage spec (env is frozen when AppModule is imported).
 *  - object storage: the real S3 driver against MinIO;
 *  - local disk: pointed at an EMPTY temp directory that the spec later proves stayed empty — the workers must have
 *    no dependency on any local file;
 *  - email: the real SMTP driver -> a local SMTP endpoint, so attachments can be inspected as MIME on the wire.
 */
export const LOCAL_ROOT = mkdtempSync(join(tmpdir(), 'rab-no-local-storage-'));
export const REPORT_SMTP_PORT = 21000 + (process.pid % 20000);

if (S3_TEST.enabled) {
  useS3Env({ STORAGE_LOCAL_ROOT: LOCAL_ROOT });
  process.env.EMAIL_DRIVER = 'SMTP';
  process.env.EMAIL_SMTP_HOST = '127.0.0.1';
  process.env.EMAIL_SMTP_PORT = String(REPORT_SMTP_PORT);
  process.env.EMAIL_SMTP_NO_TLS = 'true';
  process.env.EMAIL_FROM_ADDRESS = 'noreply@rab.test';
  delete process.env.EMAIL_SMTP_USER;
  delete process.env.EMAIL_SMTP_PASSWORD;
}

import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import { mimetypeForExt, sniffImageType } from './image-sniff';
import { StorageDriverFactory } from './storage-driver.factory';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB, matching the app's stated upload limit
const MAX_PDF_BYTES = 20 * 1024 * 1024; // generous for a text+one-image A4 report

export interface StoredFile {
  key: string;
  mimetype: string;
}

/**
 * Keys are always server-constructed — never the client-supplied filename
 * — the only client-influenced part is the extension, and that's derived
 * from the sniffed magic bytes, not the upload's declared name or
 * Content-Type header. This is the path-traversal and content-spoofing
 * defense; LocalDiskDriver's own path resolution is a second, independent
 * layer of the same defense.
 */
@Injectable()
export class StorageService {
  constructor(private readonly driverFactory: StorageDriverFactory) {}

  private validateImage(buffer: Buffer): { ext: string; mimetype: string } {
    if (buffer.length === 0) {
      throw new BadRequestException('The uploaded file is empty.');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('The uploaded file exceeds the 10MB limit.');
    }
    const sniffed = sniffImageType(buffer);
    if (!sniffed) {
      throw new BadRequestException('Unsupported file type. Only PNG, JPG and WEBP images are accepted.');
    }
    return sniffed;
  }

  async uploadAvatar(organisationId: string, userId: string, buffer: Buffer): Promise<StoredFile> {
    const { ext, mimetype } = this.validateImage(buffer);
    const key = `org/${organisationId}/avatar/${userId}/${randomUUID()}.${ext}`;
    await this.driverFactory.getDriver().write(key, buffer);
    return { key, mimetype };
  }

  async uploadLogo(organisationId: string, buffer: Buffer): Promise<StoredFile> {
    const { ext, mimetype } = this.validateImage(buffer);
    const key = `org/${organisationId}/logo/${randomUUID()}.${ext}`;
    await this.driverFactory.getDriver().write(key, buffer);
    return { key, mimetype };
  }

  /**
   * Worker-generated PDFs only (pre-shift roster, final Timesheet — see
   * `queue-worker/reports/*.job.ts`) — never called with client-uploaded
   * content, so the magic-byte check here is defense-in-depth against a
   * broken render producing garbage, not an adversarial-input defense, same
   * spirit as `validateImage` above applied to a different content type.
   */
  async storePdf(key: string, buffer: Buffer): Promise<StoredFile> {
    if (buffer.length === 0) {
      throw new BadRequestException('Generated PDF is empty.');
    }
    if (buffer.length > MAX_PDF_BYTES) {
      throw new BadRequestException('Generated PDF exceeds the size limit.');
    }
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))) {
      throw new BadRequestException('Generated content is not a valid PDF.');
    }
    await this.driverFactory.getDriver().write(key, buffer);
    return { key, mimetype: 'application/pdf' };
  }

  /** Best-effort — a delete failure (e.g. already gone) must never block the caller's own request from succeeding. */
  async deleteQuietly(key: string | null | undefined): Promise<void> {
    if (!key) return;
    try {
      await this.driverFactory.getDriver().delete(key);
    } catch {
      // Intentional no-op — see doc comment.
    }
  }

  async read(key: string): Promise<{ buffer: Buffer; mimetype: string } | null> {
    const buffer = await this.driverFactory.getDriver().read(key);
    if (!buffer) return null;
    const ext = key.split('.').pop() ?? '';
    return { buffer, mimetype: mimetypeForExt(ext) };
  }

  /** Admin Panel → Health's storage probe — writes and deletes a throwaway key, proving the configured driver is genuinely reachable/writable. */
  async healthCheck(): Promise<void> {
    const driver = this.driverFactory.getDriver();
    const probeKey = `.health-check-${Date.now()}`;
    await driver.write(probeKey, Buffer.from('ok'));
    await driver.delete(probeKey);
  }
}

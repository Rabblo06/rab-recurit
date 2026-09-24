import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EnvironmentService } from '../environment/environment.service';
import { StorageDriverInterface } from './drivers/interfaces/storage-driver.interface';
import { StoredFile } from './entities/stored-file.entity';
import { FILE_KIND_RULES, FileKind, FileKindType, FileStatus } from './file-kinds';
import { sniffImageType } from './image-sniff';
import { sanitiseFilename } from './safe-filename';
import { StorageDriverFactory } from './storage-driver.factory';
import { normaliseKeyPrefix } from './storage-key-prefix';
import { StorageError, StorageErrorCode } from './storage.errors';

/** A file whose bytes are durably in the object store and verified, but whose metadata row is not written yet. */
export interface UploadedObject {
  kind: FileKindType;
  organisationId: string;
  workspaceId: string | null;
  resourceType: string;
  resourceId: string;
  objectKey: string;
  bucket: string | null;
  storageDriver: 'LOCAL' | 'S3';
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalFilename: string;
  createdBy: string | null;
}

export interface PutParams {
  kind: FileKindType;
  organisationId: string;
  workspaceId: string | null;
  resourceType: string;
  resourceId: string;
  buffer: Buffer;
  /** Display metadata only; sanitised. Never used in a key. */
  filename?: string;
  createdBy?: string | null;
  /** Objects at the same logical location must be immutable: report versions get their own key. */
  version?: number;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const PENDING_UPLOAD_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_USER = 5;

/**
 * The single DB-aware entry point to object storage. PostgreSQL holds the
 * truth about what a file is and who may see it; the object store holds
 * bytes. They are NOT one transaction, so the consistency model is explicit:
 *
 *   1. `putObject`     — validate, hash, upload, HEAD-verify.   (S3 only)
 *   2. `registerAvailable` — insert the metadata row, AVAILABLE.  (PostgreSQL, caller's tenant transaction)
 *
 * - upload fails               -> nothing is claimed AVAILABLE; StorageError surfaces, caller retries.
 * - upload ok, DB write fails  -> an ORPHAN object (no row); `storage:reconcile` reports it. Never auto-deleted.
 * - row says AVAILABLE, object missing -> STORAGE_OBJECT_NOT_FOUND on read, never a false success.
 * - object present, hash differs      -> STORAGE_INTEGRITY_FAILED on read; the bytes are never served/emailed.
 */
@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly driverFactory: StorageDriverFactory,
    private readonly env: EnvironmentService,
  ) {}

  private get driver(): StorageDriverInterface {
    return this.driverFactory.getDriver();
  }

  get signedUrlTtlSeconds(): number {
    return this.env.get('S3_SIGNED_URL_TTL_SECONDS');
  }

  get supportsSignedUrls(): boolean {
    return this.driver.supportsSignedUrls;
  }

  // ---------------------------------------------------------------------------------------------- validation

  /** Content is decided by the bytes, never by the client's filename or Content-Type. */
  validateContent(kind: FileKindType, buffer: Buffer): { ext: string; mimeType: string } {
    const rules = FILE_KIND_RULES[kind];
    if (buffer.length === 0) throw new BadRequestException('The uploaded file is empty.');
    const limit = Math.min(rules.maxBytes, this.env.get('S3_MAX_UPLOAD_BYTES'));
    if (buffer.length > limit) throw new BadRequestException(`The uploaded file exceeds the ${Math.floor(limit / (1024 * 1024))}MB limit.`);
    if (rules.content === 'pdf') {
      if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) throw new BadRequestException('The content is not a valid PDF.');
      return { ext: 'pdf', mimeType: 'application/pdf' };
    }
    const sniffed = sniffImageType(buffer);
    if (!sniffed) throw new BadRequestException('Unsupported file type. Only PNG, JPG and WEBP images are accepted.');
    return { ext: sniffed.ext, mimeType: sniffed.mimetype };
  }

  buildObjectKey(input: { organisationId: string; workspaceId: string | null; kind: FileKindType; resourceId: string; ext: string; version?: number }): string {
    const rules = FILE_KIND_RULES[input.kind];
    const prefix = normaliseKeyPrefix(this.env.get('STORAGE_KEY_PREFIX'));
    const version = input.version ? `${input.version}/` : '';
    // Only opaque UUIDs and a server-chosen folder appear here — no name, email, phone or payroll data — and none of
    // it authorises anything: every read goes JWT -> RLS -> policy -> server-resolved key.
    return `${prefix}organisations/${input.organisationId}/workspaces/${input.workspaceId ?? 'none'}/${rules.folder}/${input.resourceId}/${version}${randomUUID()}.${input.ext}`;
  }

  // ---------------------------------------------------------------------------------------------- write path

  async putObject(params: PutParams): Promise<UploadedObject> {
    const started = Date.now();
    const { ext, mimeType } = this.validateContent(params.kind, params.buffer);
    const sha256 = createHash('sha256').update(params.buffer).digest('hex');
    const objectKey = this.buildObjectKey({ ...params, ext });
    const driver = this.driver;
    try {
      await driver.put(objectKey, params.buffer, { contentType: mimeType, sha256 });
      // Trust, but verify: the object must exist with the size we sent before anything claims it is stored.
      const head = await driver.head(objectKey);
      if (!head || head.sizeBytes !== params.buffer.length) {
        await driver.delete(objectKey).catch(() => undefined);
        throw new StorageError(StorageErrorCode.UPLOAD_FAILED, 'The object could not be verified after upload.', true);
      }
    } catch (error) {
      this.logOp('put', params.kind, driver.name, params.buffer.length, started, error instanceof StorageError ? error.code : 'error');
      throw error;
    }
    this.logOp('put', params.kind, driver.name, params.buffer.length, started, 'ok');
    return {
      kind: params.kind,
      organisationId: params.organisationId,
      workspaceId: params.workspaceId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      objectKey,
      bucket: driver.bucket,
      storageDriver: driver.name,
      mimeType,
      sizeBytes: params.buffer.length,
      sha256,
      originalFilename: sanitiseFilename(params.filename, `${params.kind.toLowerCase()}.${ext}`),
      createdBy: params.createdBy ?? null,
    };
  }

  async registerAvailable(manager: EntityManager, uploaded: UploadedObject): Promise<StoredFile> {
    const inserted = await manager.insert(StoredFile, {
      organisationId: uploaded.organisationId,
      workspaceId: uploaded.workspaceId,
      kind: uploaded.kind,
      resourceType: uploaded.resourceType,
      resourceId: uploaded.resourceId,
      storageDriver: uploaded.storageDriver,
      bucket: uploaded.bucket,
      objectKey: uploaded.objectKey,
      originalFilename: uploaded.originalFilename,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      sha256: uploaded.sha256,
      status: FileStatus.AVAILABLE,
      createdBy: uploaded.createdBy,
    });
    return manager.findOneByOrFail(StoredFile, { id: inserted.identifiers[0]!.id as string });
  }

  /**
   * Removes an object THIS caller just uploaded and never registered (its
   * transaction rolled back, or it lost a claim race). Safe because the key is
   * unique to the attempt: nothing else can reference it. Best-effort — if it
   * fails the object is a reconcilable orphan, never a correctness problem.
   */
  async discardUnregistered(uploaded: UploadedObject): Promise<void> {
    await this.driver.delete(uploaded.objectKey).catch(() => undefined);
  }

  /** Convenience for small API-mediated uploads inside a caller's tenant transaction. */
  async store(manager: EntityManager, params: PutParams): Promise<StoredFile> {
    return this.registerAvailable(manager, await this.putObject(params));
  }

  // ---------------------------------------------------------------------------------------------- read path

  /** RLS-scoped lookup. `null` for missing, other tenants, wrong workspace, PENDING, FAILED and DELETED alike — no state leaks. */
  async findAvailable(manager: EntityManager, fileId: string): Promise<StoredFile | null> {
    return manager.findOne(StoredFile, { where: { id: fileId, status: FileStatus.AVAILABLE } });
  }

  /**
   * Bytes for an AVAILABLE file, integrity-checked against the SHA-256 stored
   * at write time. Never returns unverified bytes for evidence files.
   */
  async readVerified(file: StoredFile): Promise<Buffer> {
    const started = Date.now();
    let bytes: Buffer | null;
    try {
      bytes = await this.driver.get(file.objectKey);
    } catch (error) {
      this.logOp('get', file.kind as FileKindType, this.driver.name, 0, started, error instanceof StorageError ? error.code : 'error', file.id);
      throw error;
    }
    if (!bytes) {
      this.logOp('get', file.kind as FileKindType, this.driver.name, 0, started, StorageErrorCode.OBJECT_NOT_FOUND, file.id);
      throw new StorageError(StorageErrorCode.OBJECT_NOT_FOUND, 'The stored object was not found.', false);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (!file.sha256 || actual !== file.sha256 || bytes.length !== file.sizeBytes) {
      this.logOp('get', file.kind as FileKindType, this.driver.name, bytes.length, started, StorageErrorCode.INTEGRITY_FAILED, file.id);
      throw new StorageError(StorageErrorCode.INTEGRITY_FAILED, 'The stored object failed its integrity check.', false);
    }
    this.logOp('get', file.kind as FileKindType, this.driver.name, bytes.length, started, 'ok', file.id);
    return bytes;
  }

  /**
   * Cheap existence + size check used before handing out a presigned URL (the
   * API never sees the bytes on that path, so it cannot hash them). Catches a
   * deleted or truncated object; the SHA-256 is enforced on every path that
   * DOES read the bytes (proxy download, email attachment, reconciliation).
   */
  async assertObjectPresent(file: StoredFile): Promise<void> {
    const head = await this.driver.head(file.objectKey);
    if (!head) throw new StorageError(StorageErrorCode.OBJECT_NOT_FOUND, 'The stored object was not found.', false);
    if (head.sizeBytes !== file.sizeBytes) throw new StorageError(StorageErrorCode.INTEGRITY_FAILED, 'The stored object failed its integrity check.', false);
  }

  async signedDownloadUrl(file: StoredFile, filename: string, contentType: string): Promise<string> {
    return this.driver.signedGetUrl(file.objectKey, { ttlSeconds: this.signedUrlTtlSeconds, filename, contentType });
  }

  // ---------------------------------------------------------------------------------------------- lifecycle

  /**
   * Tombstone, never hard-delete: the row stays (`DELETED`) so evidence and
   * audit history are intact; the object is removed only for kinds where the
   * business has no retention duty (images). Final reports keep their object.
   */
  async tombstone(manager: EntityManager, file: StoredFile, options: { removeObject: boolean }): Promise<void> {
    await manager.update(StoredFile, { id: file.id }, { status: FileStatus.DELETED, deletedAt: () => 'now()' } as never);
    if (options.removeObject) await this.driver.delete(file.objectKey).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------- direct upload

  /**
   * Step 1 of a presigned direct upload. Creates a PENDING row with a
   * SERVER-generated key and returns a short-lived URL bound to that exact
   * key, content type and length. The client never supplies a key, bucket,
   * organisation or workspace.
   */
  async createUploadIntent(
    manager: EntityManager,
    ctx: { organisationId: string; workspaceId: string | null; userId: string },
    input: { kind: FileKindType; resourceType: string; resourceId: string; filename: string; sizeBytes: number; contentType: string },
  ): Promise<{ file: StoredFile; uploadUrl: string; headers: Record<string, string>; expiresInSeconds: number }> {
    if (!this.driver.supportsSignedUrls) {
      throw new StorageError(StorageErrorCode.NOT_SUPPORTED, 'Direct upload requires the S3 storage driver.', false);
    }
    const rules = FILE_KIND_RULES[input.kind];
    const limit = Math.min(rules.maxBytes, this.env.get('S3_MAX_UPLOAD_BYTES'));
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > limit) {
      throw new BadRequestException(`The file size must be between 1 byte and ${Math.floor(limit / (1024 * 1024))}MB.`);
    }
    const allowedTypes = rules.content === 'pdf' ? ['application/pdf'] : ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedTypes.includes(input.contentType)) throw new BadRequestException('Unsupported file type.');

    // Abuse control: a user cannot mint unlimited abandoned uploads.
    const pending = await manager.count(StoredFile, { where: { createdBy: ctx.userId, status: FileStatus.PENDING } });
    if (pending >= MAX_PENDING_PER_USER) {
      throw new HttpException('Too many uploads in progress. Finish or wait for them to expire.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const ext = input.contentType === 'image/png' ? 'png' : input.contentType === 'image/webp' ? 'webp' : input.contentType === 'application/pdf' ? 'pdf' : 'jpg';
    const objectKey = this.buildObjectKey({ organisationId: ctx.organisationId, workspaceId: ctx.workspaceId, kind: input.kind, resourceId: input.resourceId, ext });
    const inserted = await manager.insert(StoredFile, {
      organisationId: ctx.organisationId,
      workspaceId: ctx.workspaceId,
      kind: input.kind,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      storageDriver: this.driver.name,
      bucket: this.driver.bucket,
      objectKey,
      originalFilename: sanitiseFilename(input.filename, `upload.${ext}`),
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: null,
      status: FileStatus.PENDING,
      createdBy: ctx.userId,
      expiresAt: new Date(Date.now() + PENDING_UPLOAD_TTL_MS),
    });
    const file = await manager.findOneByOrFail(StoredFile, { id: inserted.identifiers[0]!.id as string });
    const uploadUrl = await this.driver.signedPutUrl(objectKey, { ttlSeconds: this.signedUrlTtlSeconds, contentType: input.contentType, contentLength: input.sizeBytes });
    return {
      file,
      uploadUrl,
      headers: { 'Content-Type': input.contentType, ...(this.env.get('S3_SERVER_SIDE_ENCRYPTION') === 'AES256' ? { 'x-amz-server-side-encryption': 'AES256' } : {}) },
      expiresInSeconds: this.signedUrlTtlSeconds,
    };
  }

  /**
   * Step 2. The client's word that "the upload finished" is worth nothing: the
   * server HEADs the object, checks the exact size, downloads and SNIFFS the
   * real bytes, hashes them, and only then flips PENDING -> AVAILABLE.
   */
  async completeUpload(manager: EntityManager, file: StoredFile): Promise<{ file: StoredFile } | { rejected: string }> {
    if (file.status !== FileStatus.PENDING) throw new BadRequestException('This upload is not pending.');
    // A REJECTION is returned, not thrown: the caller must COMMIT the FAILED state (a throw would roll it back and leave
    // the row PENDING, letting the same bad object be re-presented) and only then answer 400.
    if (file.expiresAt && file.expiresAt.getTime() < Date.now()) {
      await this.failPending(manager, file);
      return { rejected: 'This upload has expired.' };
    }
    const head = await this.driver.head(file.objectKey);
    if (!head) throw new BadRequestException('The file has not been uploaded yet.');
    if (head.sizeBytes !== file.sizeBytes) {
      await this.failPending(manager, file);
      return { rejected: 'The uploaded file does not match the declared size.' };
    }
    const bytes = await this.driver.get(file.objectKey);
    if (!bytes) throw new BadRequestException('The file has not been uploaded yet.');
    let mimeType: string;
    try {
      ({ mimeType } = this.validateContent(file.kind as FileKindType, bytes));
    } catch (error) {
      await this.failPending(manager, file);
      return { rejected: error instanceof BadRequestException ? String(error.message) : 'The uploaded content is not valid.' };
    }
    if (mimeType !== file.mimeType) {
      await this.failPending(manager, file);
      return { rejected: 'The uploaded content does not match the declared type.' };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const flipped = await manager
      .createQueryBuilder()
      .update(StoredFile)
      .set({ status: FileStatus.AVAILABLE, sha256, expiresAt: null })
      .where('id = :id AND status = :pending', { id: file.id, pending: FileStatus.PENDING })
      .execute();
    if (!flipped.affected) throw new BadRequestException('This upload is not pending.');
    return { file: await manager.findOneByOrFail(StoredFile, { id: file.id }) };
  }

  private async failPending(manager: EntityManager, file: StoredFile): Promise<void> {
    await manager.update(StoredFile, { id: file.id }, { status: FileStatus.FAILED });
    await this.driver.delete(file.objectKey).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------- health / logging

  /** Write/read/delete a throwaway object — proves the configured driver is really reachable and writable. */
  async healthProbe(): Promise<void> {
    const key = `${normaliseKeyPrefix(this.env.get('STORAGE_KEY_PREFIX'))}.health/${randomUUID()}`;
    const body = Buffer.from('ok');
    await this.driver.put(key, body, { contentType: 'text/plain' });
    try {
      const back = await this.driver.get(key);
      if (!back || !back.equals(body)) throw new StorageError(StorageErrorCode.INTEGRITY_FAILED, 'Health probe read-back mismatch.', false);
    } finally {
      await this.driver.delete(key).catch(() => undefined);
    }
  }

  /** Structured, secret-free. Never includes the object key contents beyond the file id, nor URLs, nor bytes. */
  private logOp(operation: string, kind: FileKindType | string, driver: string, sizeBytes: number, startedAt: number, result: string, fileId?: string): void {
    this.logger.log(JSON.stringify({ operation, fileId, resourceKind: kind, storageDriver: driver, sizeBytes, durationMs: Date.now() - startedAt, result }));
  }
}

export { FileKind };

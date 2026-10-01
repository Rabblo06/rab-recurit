import { In } from 'typeorm';
import { FilePreviewsDto } from './dto/file-previews.dto';
import { BadRequestException, Body, Controller, Get, Header, HttpException, HttpStatus, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { AuditAction, AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { CreateUploadIntentDto } from './dto/create-upload-intent.dto';
import { StoredFile } from './entities/stored-file.entity';
import { FileAccessRegistry } from './file-access.registry';
import { FILE_KIND_RULES, FileKind, FileKindType } from './file-kinds';
import { FileService } from './file.service';
import { contentDisposition } from './safe-filename';
import { StorageError, StorageErrorCode } from './storage.errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PERF-02 — before this fix, the only per-item bound on `/files/previews`
 * was `sizeBytes <= 2 MiB`, with no aggregate cap across the batch. At the
 * DTO's own `ArrayMaxSize(32)`, the theoretical worst case was
 * 32 x 2 MiB = 64 MiB raw, x 4/3 for base64 = ~85.3 MiB of JSON in one
 * response — recalculated from current source, this matches the prior
 * audit's ~85 MiB estimate almost exactly; nothing had changed since.
 *
 * This endpoint is already scoped tightly — `FileKind.PROFILE_IMAGE` only,
 * i.e. avatars, never a report/timesheet/document — so the fix is the
 * smallest safe change, not a new thumbnail-generation subsystem: shrink
 * the per-item inline threshold to something an avatar actually needs
 * (200 KiB comfortably covers a photographic headshot at the size this UI
 * renders it), and add a hard AGGREGATE byte budget across the whole batch
 * so the worst case no longer scales linearly with item count. A file
 * exceeding either bound is omitted from the response exactly like an
 * unreadable one already was — the frontend's existing initials fallback
 * (`VenueOfferPipeline.tsx`) already handles a sparse `previews` map, so no
 * consumer change is needed.
 *
 * New theoretical worst case: min(32 x 200 KiB, 2 MiB aggregate) = 2 MiB
 * raw x 4/3 ~= 2.67 MiB base64-encoded — roughly a 32x reduction, and small
 * enough to be an unremarkable single API response.
 */
const MAX_INLINE_PREVIEW_BYTES = 200 * 1024; // 200 KiB per avatar
const MAX_AGGREGATE_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MiB raw bytes per batch, before base64 expansion

/**
 * Files are addressed by FILE ID only. There is no route that accepts an
 * object key, a bucket or a path: a client that sends `org/…/x.pdf` reaches no
 * handler at all, and a non-UUID id is a 404. Every read goes
 *   JWT -> AuthContext -> stored_file row under RLS -> per-kind policy ->
 *   server-resolved object key -> storage.
 * A file the caller may not see, a file that does not exist, a PENDING or
 * DELETED file and a guessed id are indistinguishable: 404 (never 403).
 */
@Controller('rest/v1/files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(
    private readonly files: FileService,
    private readonly registry: FileAccessRegistry,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /** Batch image access for boards/reports. Same RLS + registered policy as individual downloads. */
  @Post('previews')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async previews(@AuthUser() ctx: AuthContext, @Body() dto: FilePreviewsDto) {
    const allowed = await this.tenantContext.runInTenantContext(ctx, async manager => {
      const rows = await manager.find(StoredFile, { where: { id: In(dto.fileIds), status: 'AVAILABLE', kind: FileKind.PROFILE_IMAGE } });
      const files: StoredFile[] = [];
      for (const file of rows) {
        if (await this.registry.get(file.kind)?.canRead(manager, ctx, file)) files.push(file);
      }
      return files;
    });
    const previews: Record<string, string> = {};
    let aggregateBytes = 0;
    for (const file of allowed) {
      // PERF-02 — per-item AND aggregate bounds, checked before ever
      // reading/encoding the object. A file that would blow either budget
      // is skipped the same way an unreadable one already is (existing
      // initials fallback), never a partial/truncated read.
      if (file.sizeBytes > MAX_INLINE_PREVIEW_BYTES) continue;
      if (aggregateBytes + file.sizeBytes > MAX_AGGREGATE_PREVIEW_BYTES) continue;
      try {
        // Verified, bounded inline previews also work with private S3 endpoints.
        // No browser request per card and no storage keys or bearer URLs exposed.
        previews[file.id] = `data:${file.mimeType};base64,${(await this.files.readVerified(file)).toString('base64')}`;
        aggregateBytes += file.sizeBytes;
      } catch { /* Missing/unavailable images retain the existing initials fallback. */ }
    }
    return { previews, expiresInSeconds: this.files.signedUrlTtlSeconds };
  }

  /** Direct upload, step 1: server-generated key, short-lived URL. Only kinds a client may upload; the owner is always the caller. */
  @Post('upload-intent')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async createUploadIntent(@AuthUser() ctx: AuthContext, @Body() dto: CreateUploadIntentDto) {
    try {
      return await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const { file, uploadUrl, headers, expiresInSeconds } = await this.files.createUploadIntent(
          manager,
          { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId ?? null, userId: ctx.userId },
          // The resource is ALWAYS the caller — a client cannot upload "as" someone else.
          { kind: dto.kind as FileKindType, resourceType: 'user', resourceId: ctx.userId, filename: dto.filename, sizeBytes: dto.sizeBytes, contentType: dto.contentType },
        );
        return { fileId: file.id, uploadUrl, method: 'PUT', headers, expiresInSeconds };
      });
    } catch (error) {
      throw toHttp(error);
    }
  }

  /** Direct upload, step 2: the server re-verifies the object; the client's claim that it finished proves nothing. */
  @Post(':fileId/complete')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async completeUpload(@AuthUser() ctx: AuthContext, @Param('fileId') fileId: string) {
    requireUuid(fileId);
    let outcome: { fileId: string; status: string } | { rejected: string };
    try {
      outcome = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const pending = await manager.findOne(StoredFile, { where: { id: fileId, createdBy: ctx.userId, status: 'PENDING' } });
        if (!pending) throw new NotFoundException('File not found.');
        const result = await this.files.completeUpload(manager, pending);
        // A rejection COMMITS (the row is now FAILED and its object gone) — the 400 is raised after the transaction.
        if ('rejected' in result) return { rejected: result.rejected };
        await this.registry.get(result.file.kind)?.onUploadCompleted?.(manager, ctx, result.file);
        await this.audit.record(manager, ctx, AuditAction.FILE_UPLOADED, { entityType: 'stored_file', entityId: result.file.id, metadata: { kind: result.file.kind, sizeBytes: result.file.sizeBytes, direct: true } });
        return { fileId: result.file.id, status: result.file.status };
      });
    } catch (error) {
      throw toHttp(error);
    }
    if ('rejected' in outcome) throw new BadRequestException(outcome.rejected);
    return outcome;
  }

  /** Bytes through the API. Used for images the app renders (the web fetches them with its bearer token). */
  @Get(':fileId')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async serve(@AuthUser() ctx: AuthContext, @Param('fileId') fileId: string, @Res() response: Response): Promise<void> {
    await this.deliver(ctx, fileId, response, false);
  }

  /** Documents: a short-lived presigned URL (S3) or the bytes as an attachment (LOCAL). */
  @Get(':fileId/download')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async download(@AuthUser() ctx: AuthContext, @Param('fileId') fileId: string, @Res() response: Response): Promise<void> {
    await this.deliver(ctx, fileId, response, true);
  }

  // ------------------------------------------------------------------------------------------------

  private async deliver(ctx: AuthContext, fileId: string, response: Response, allowRedirect: boolean): Promise<void> {
    requireUuid(fileId);
    const file = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const found = await this.files.findAvailable(manager, fileId);
      if (!found) return null;
      const policy = this.registry.get(found.kind);
      if (!policy || !(await policy.canRead(manager, ctx, found))) {
        // RLS let the row through but the per-kind rule says no: record it, answer exactly like "missing".
        await this.audit.record(manager, ctx, AuditAction.FILE_ACCESS_DENIED, { entityType: 'stored_file', entityId: found.id, metadata: { kind: found.kind } });
        return null;
      }
      if (!FILE_KIND_RULES[found.kind as FileKindType].inline) {
        await this.audit.record(manager, ctx, AuditAction.FILE_DOWNLOAD_AUTHORIZED, { entityType: 'stored_file', entityId: found.id, metadata: { kind: found.kind } });
      }
      return found;
    });
    if (!file) throw new NotFoundException('File not found.');

    const inline = FILE_KIND_RULES[file.kind as FileKindType].inline;
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (allowRedirect && !inline && this.files.supportsSignedUrls) {
      // Never stored, never logged: minted per request after authorization — and only for an object that is really there.
      try {
        await this.files.assertObjectPresent(file);
      } catch (error) {
        if (error instanceof StorageError && (error.code === StorageErrorCode.INTEGRITY_FAILED || error.code === StorageErrorCode.OBJECT_NOT_FOUND)) {
          await this.recordIntegrityFailure(ctx, file, error.code);
        }
        throw toHttp(error);
      }
      const url = await this.files.signedDownloadUrl(file, safeAscii(file.originalFilename), file.mimeType).catch((error) => {
        throw toHttp(error);
      });
      response.setHeader('Cache-Control', 'no-store');
      response.redirect(302, url);
      return;
    }

    let bytes: Buffer;
    try {
      bytes = await this.files.readVerified(file);
    } catch (error) {
      if (error instanceof StorageError && (error.code === StorageErrorCode.INTEGRITY_FAILED || error.code === StorageErrorCode.OBJECT_NOT_FOUND)) {
        await this.recordIntegrityFailure(ctx, file, error.code);
      }
      throw toHttp(error);
    }
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Disposition', contentDisposition(file.originalFilename, inline));
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Object keys are immutable (a replaced avatar is a NEW file id), so images can be cached by the browser.
    response.setHeader('Cache-Control', inline ? 'private, max-age=3600' : 'no-store');
    response.send(bytes);
  }

  private async recordIntegrityFailure(ctx: AuthContext, file: StoredFile, code: string): Promise<void> {
    await this.tenantContext
      .runInTenantContext(ctx, (manager) => this.audit.record(manager, ctx, AuditAction.REPORT_INTEGRITY_FAILED, { entityType: 'stored_file', entityId: file.id, metadata: { kind: file.kind, code } }))
      .catch(() => undefined);
  }
}

function requireUuid(value: string): void {
  if (!UUID.test(value)) throw new NotFoundException('File not found.');
}

function safeAscii(name: string): string {
  return contentDisposition(name, false).match(/filename="([^"]*)"/)?.[1] ?? 'file';
}

/** Provider detail never reaches a client: StorageError codes map to generic, stable responses. */
export function toHttp(error: unknown): unknown {
  if (!(error instanceof StorageError)) return error;
  switch (error.code) {
    case StorageErrorCode.OBJECT_NOT_FOUND:
      return new NotFoundException('File not found.');
    case StorageErrorCode.TEMPORARILY_UNAVAILABLE:
      return new HttpException({ statusCode: 503, code: error.code, message: 'File storage is temporarily unavailable. Please try again.' }, HttpStatus.SERVICE_UNAVAILABLE);
    case StorageErrorCode.NOT_SUPPORTED:
      return new HttpException({ statusCode: 501, code: error.code, message: 'This operation is not available in this environment.' }, HttpStatus.NOT_IMPLEMENTED);
    default:
      return new HttpException({ statusCode: 502, code: error.code, message: 'The file could not be retrieved.' }, HttpStatus.BAD_GATEWAY);
  }
}

export { FileKind };

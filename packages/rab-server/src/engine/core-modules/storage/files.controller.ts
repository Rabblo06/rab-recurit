import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
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

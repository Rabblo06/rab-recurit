import { PermissionFlag } from '@rab/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { MobileApplication } from '../../../engine/core-modules/auth/guards/mobile-application.decorator';
import {
  STAFF_DOCUMENT_MAX_BYTES,
  singleDocumentUploadOptions,
} from '../../../engine/core-modules/storage/upload-limits';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import {
  RejectStaffDocumentDto,
  RevokeStaffDocumentDto,
  SetStaffDocumentRequirementsDto,
  UploadStaffDocumentDto,
} from '../dto/staff-document.dto';
import { StaffDocumentService } from '../services/staff-document.service';

/** Multipart: one `file` part (fast-fail at 10 MB; the service re-checks size and magic bytes) plus the three DTO fields. */
const DOCUMENT_UPLOAD_OPTIONS = singleDocumentUploadOptions(
  STAFF_DOCUMENT_MAX_BYTES,
  3,
);

/**
 * Manager console: one staff member's documents. Transport only. StaffDocumentService re-checks the flag, requires a
 * non-venue manager of the caller's own workspace and the staff profile in it (404 otherwise), and never lets a manager
 * decide on their own document. Mutations are named actions (verify / reject / revoke), never a status field.
 */
@Controller('rest/v1/staff')
@UseGuards(JwtAuthGuard)
@ManagerApplication()
export class StaffDocumentsController {
  constructor(private readonly documents: StaffDocumentService) {}

  @Get(':staffProfileId/documents')
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_VIEW),
    RequireWorkspaceGuard,
  )
  list(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
  ) {
    return this.documents.listForStaff(ctx, staffProfileId);
  }

  @Post(':staffProfileId/documents')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_MANAGE),
    RequireWorkspaceGuard,
  )
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  upload(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: UploadStaffDocumentDto,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.documents.uploadForStaff(ctx, staffProfileId, dto, file.buffer);
  }

  @Post(':staffProfileId/documents/:documentId/verify')
  @HttpCode(200)
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_MANAGE),
    RequireWorkspaceGuard,
  )
  verify(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.documents.verify(ctx, staffProfileId, documentId);
  }

  @Post(':staffProfileId/documents/:documentId/reject')
  @HttpCode(200)
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_MANAGE),
    RequireWorkspaceGuard,
  )
  reject(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: RejectStaffDocumentDto,
  ) {
    return this.documents.reject(ctx, staffProfileId, documentId, dto.reason);
  }

  @Post(':staffProfileId/documents/:documentId/revoke')
  @HttpCode(200)
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_MANAGE),
    RequireWorkspaceGuard,
  )
  revoke(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: RevokeStaffDocumentDto,
  ) {
    return this.documents.revoke(ctx, staffProfileId, documentId, dto.reason);
  }
}

/** Organisation configuration: which document types are REQUIRED before an offer can be sent (no row = the code default). */
@Controller('rest/v1/staff-documents/requirements')
@UseGuards(JwtAuthGuard)
@ManagerApplication()
export class StaffDocumentRequirementsController {
  constructor(private readonly documents: StaffDocumentService) {}

  @Get()
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_VIEW),
    RequireWorkspaceGuard,
  )
  get(@AuthUser() ctx: AuthContext) {
    return this.documents.getRequirements(ctx);
  }

  @Put()
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_CONFIGURE),
    RequireWorkspaceGuard,
  )
  set(
    @AuthUser() ctx: AuthContext,
    @Body() dto: SetStaffDocumentRequirementsDto,
  ) {
    return this.documents.setRequirements(ctx, dto.requiredTypes);
  }
}

/**
 * Staff app only (CF-08 default-deny for every other app): the caller's own documents and new uploads. A staff member never
 * verifies anything; the file downloads through GET /rest/v1/files/:fileId/download once it is scanned clean.
 */
@Controller('rest/v1/staff-documents/me')
@UseGuards(JwtAuthGuard)
export class MyStaffDocumentsController {
  constructor(private readonly documents: StaffDocumentService) {}

  @MobileApplication('staff_app')
  @Get()
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_OWN),
    RequireWorkspaceGuard,
  )
  list(@AuthUser() ctx: AuthContext) {
    return this.documents.listMine(ctx);
  }

  @MobileApplication('staff_app')
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_DOCUMENT_OWN),
    RequireWorkspaceGuard,
  )
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  upload(
    @AuthUser() ctx: AuthContext,
    @Body() dto: UploadStaffDocumentDto,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.documents.uploadMine(ctx, dto, file.buffer);
  }
}

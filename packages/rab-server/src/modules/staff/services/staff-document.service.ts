import {
  assertTransition,
  PermissionFlag,
  STAFF_DOCUMENT_TRANSITIONS,
  STAFF_DOCUMENT_TYPE_LABELS,
  STAFF_DOCUMENT_TYPES,
  StaffDocumentScanStatus,
  StaffDocumentStatus,
  StaffDocumentStatusType,
  StaffDocumentTypeType,
} from '@rab/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  AuditAction,
  AuditService,
} from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import {
  FileService,
  UploadedObject,
} from '../../../engine/core-modules/storage/file.service';
import {
  VirusScanner,
  VirusScanVerdict,
} from '../../../engine/core-modules/storage/virus-scan/virus-scanner';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { businessTables } from '../../../engine/core-modules/tenant/business-tables';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import {
  daysBetween,
  effectiveRequiredTypes,
  isCalendarDate,
  isExpiredOn,
  isFileVisible,
  londonDate,
} from './staff-document-rules';

export interface StaffDocumentView {
  id: string;
  documentType: string;
  documentTypeLabel: string;
  issuedOn: string | null;
  expiresOn: string | null;
  status: string;
  scanStatus: string;
  /** Present only when the file may be opened: scanned clean by a real scanner and not revoked (download via /rest/v1/files/:fileId/download). */
  fileId: string | null;
  uploadedAt: string;
  uploadedBySelf: boolean;
  verifiedAt: string | null;
  rejectionReason: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  expired: boolean;
  /** Days from today (London) to the expiry date; negative once expired; null without an expiry date. */
  daysUntilExpiry: number | null;
}

export interface StaffDocumentRequirementView {
  documentType: string;
  documentTypeLabel: string;
  required: boolean;
  source: 'default' | 'organisation';
}

interface DocumentRow {
  id: string;
  staff_user_id: string;
  document_type: string;
  file_id: string;
  issued_on: string | null;
  expires_on: string | null;
  status: string;
  scan_status: string;
  uploaded_by: string;
  created_at: Date;
  verified_at: Date | null;
  rejection_reason: string | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
}

const DOCUMENT_COLUMNS = `id, staff_user_id, document_type, file_id, to_char(issued_on, 'YYYY-MM-DD') AS issued_on, to_char(expires_on, 'YYYY-MM-DD') AS expires_on,
  status, scan_status, uploaded_by, created_at, verified_at, rejection_reason, revoked_at, revocation_reason`;

type UploadTarget =
  { kind: 'staff'; staffProfileId: string } | { kind: 'self' };

/**
 * Staff documents with an expiry (Lane D). Controllers are transport only; every rule is here so the console, the staff app,
 * jobs and other services meet the same checks:
 *   layer 2 — the route's flag re-checked in the transaction (assertPermissionTx), then the scope rule: a NON-venue manager
 *             of the caller's own workspace for another person's documents (404 for anyone else, never 403), or the
 *             caller's own staff profile in the workspace for their own;
 *   layer 3 — every query pinned to the bound organisation + workspace (and staff_user_id);
 *   layers 4–5 — FORCE RLS on core.staff_document (StaffDocumentSchema1786722300000) and the guard trigger.
 * Files: content decided by magic bytes (PDF / PNG / JPEG), 10 MB, server-built private object key, virus scan before
 * storing (infected = refused). A file is HIDDEN (no fileId, no download, no verification) until a real scanner said clean
 * (owner's recommended rule, OWNER DECISION) — with no scanner configured nothing is ever marked clean.
 */
@Injectable()
export class StaffDocumentService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly files: FileService,
    private readonly scanner: VirusScanner,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------------------------------------ reads

  async listForStaff(
    ctx: AuthContext,
    staffProfileId: string,
  ): Promise<{ documents: StaffDocumentView[]; requiredTypes: string[] }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(
        m,
        ctx,
        PermissionFlag.STAFF_DOCUMENT_VIEW,
      );
      const staffUserId = await this.resolveManagedStaff(
        m,
        ctx,
        staffProfileId,
      );
      return {
        documents: await this.listFor(m, ctx, staffUserId),
        requiredTypes: await this.requiredTypes(m, ctx),
      };
    });
  }

  async listMine(
    ctx: AuthContext,
  ): Promise<{ documents: StaffDocumentView[]; requiredTypes: string[] }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(
        m,
        ctx,
        PermissionFlag.STAFF_DOCUMENT_OWN,
      );
      await this.resolveOwnStaff(m, ctx);
      return {
        documents: await this.listFor(m, ctx, ctx.userId),
        requiredTypes: await this.requiredTypes(m, ctx),
      };
    });
  }

  async getRequirements(
    ctx: AuthContext,
  ): Promise<StaffDocumentRequirementView[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(
        m,
        ctx,
        PermissionFlag.STAFF_DOCUMENT_VIEW,
      );
      return (await effectiveRequiredTypes(m, ctx.organisationId!)).map(
        (r) => ({
          ...r,
          documentTypeLabel: STAFF_DOCUMENT_TYPE_LABELS[r.documentType],
        }),
      );
    });
  }

  // ------------------------------------------------------------------------------------------------ writes

  uploadForStaff(
    ctx: AuthContext,
    staffProfileId: string,
    input: { documentType: string; issuedOn?: string; expiresOn?: string },
    buffer: Buffer,
  ): Promise<StaffDocumentView> {
    return this.upload(ctx, { kind: 'staff', staffProfileId }, input, buffer);
  }

  uploadMine(
    ctx: AuthContext,
    input: { documentType: string; issuedOn?: string; expiresOn?: string },
    buffer: Buffer,
  ): Promise<StaffDocumentView> {
    return this.upload(ctx, { kind: 'self' }, input, buffer);
  }

  async verify(
    ctx: AuthContext,
    staffProfileId: string,
    documentId: string,
  ): Promise<StaffDocumentView> {
    return this.decide(
      ctx,
      staffProfileId,
      documentId,
      StaffDocumentStatus.VERIFIED,
      null,
    );
  }

  async reject(
    ctx: AuthContext,
    staffProfileId: string,
    documentId: string,
    reason: string,
  ): Promise<StaffDocumentView> {
    return this.decide(
      ctx,
      staffProfileId,
      documentId,
      StaffDocumentStatus.REJECTED,
      reason,
    );
  }

  async revoke(
    ctx: AuthContext,
    staffProfileId: string,
    documentId: string,
    reason?: string,
  ): Promise<StaffDocumentView> {
    return this.decide(
      ctx,
      staffProfileId,
      documentId,
      StaffDocumentStatus.REVOKED,
      reason ?? null,
    );
  }

  /** Replaces the organisation's configuration: every requirable type gets an explicit row (required or not). */
  async setRequirements(
    ctx: AuthContext,
    requiredTypes: readonly string[],
  ): Promise<StaffDocumentRequirementView[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(
        m,
        ctx,
        PermissionFlag.STAFF_DOCUMENT_CONFIGURE,
      );
      // Organisation-level setting: any non-venue manager of the organisation (RLS insert/update predicate is the same).
      const [isManager] = await m.query(
        `SELECT 1 FROM core.manager_profile WHERE user_id = $1 AND organisation_id = $2 AND type <> 'venue' AND archived_at IS NULL LIMIT 1`,
        [ctx.userId, ctx.organisationId],
      );
      if (!isManager)
        throw new ForbiddenException(
          'Only a manager can change required documents.',
        );
      const before = await effectiveRequiredTypes(m, ctx.organisationId!);
      for (const r of before) {
        await m.query(
          `INSERT INTO core.staff_document_requirement (organisation_id, document_type, required, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (organisation_id, document_type) DO UPDATE SET required = EXCLUDED.required, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [
            ctx.organisationId,
            r.documentType,
            requiredTypes.includes(r.documentType),
            ctx.userId,
          ],
        );
      }
      const after = await effectiveRequiredTypes(m, ctx.organisationId!);
      await this.audit.record(
        m,
        ctx,
        AuditAction.STAFF_DOCUMENT_REQUIREMENTS_CHANGED,
        {
          entityType: 'staff_document_requirement',
          metadata: {
            before: before.filter((r) => r.required).map((r) => r.documentType),
            after: after.filter((r) => r.required).map((r) => r.documentType),
          },
        },
      );
      return after.map((r) => ({
        ...r,
        documentTypeLabel: STAFF_DOCUMENT_TYPE_LABELS[r.documentType],
      }));
    });
  }

  // ------------------------------------------------------------------------------------------------ file policy (layer 2 of downloads)

  /**
   * Called by StaffDocumentFilePolicy inside the caller's own tenant transaction, after RLS let the stored_file row through.
   * True only for a STAFF_DOCUMENT file whose document row is visible under RLS, not revoked and scanned clean, read by its
   * own staff member (staff_document.own) or a non-venue manager of the workspace (staff_document.view). Everything else
   * is false (the controller answers 404 and records file.access_denied).
   */
  async canReadFile(
    m: EntityManager,
    ctx: AuthContext,
    file: StoredFile,
  ): Promise<boolean> {
    if (
      file.kind !== FileKind.STAFF_DOCUMENT ||
      file.resourceType !== 'staff_document' ||
      !ctx.organisationId ||
      !ctx.workspaceId
    )
      return false;
    const [doc] = await m.query(
      `SELECT staff_user_id, status, scan_status FROM core.staff_document WHERE file_id = $1 AND id = $2 AND organisation_id = $3 AND workspace_id = $4`,
      [file.id, file.resourceId, ctx.organisationId, ctx.workspaceId],
    );
    if (!doc || !isFileVisible(doc.status, doc.scan_status)) return false;
    if (doc.staff_user_id === ctx.userId)
      return this.permissions.userHasPermissionTx(
        m,
        ctx,
        PermissionFlag.STAFF_DOCUMENT_OWN,
      );
    return (
      (await this.isWorkspaceManager(m, ctx)) &&
      this.permissions.userHasPermissionTx(
        m,
        ctx,
        PermissionFlag.STAFF_DOCUMENT_VIEW,
      )
    );
  }

  // ------------------------------------------------------------------------------------------------ internals

  private async upload(
    ctx: AuthContext,
    target: UploadTarget,
    input: { documentType: string; issuedOn?: string; expiresOn?: string },
    buffer: Buffer,
  ): Promise<StaffDocumentView> {
    const outcome = await this.tenantContext.runInWorkspaceContext(
      ctx,
      async (m) => {
        let staffUserId: string;
        if (target.kind === 'self') {
          await this.permissions.assertPermissionTx(
            m,
            ctx,
            PermissionFlag.STAFF_DOCUMENT_OWN,
          );
          await this.resolveOwnStaff(m, ctx);
          staffUserId = ctx.userId;
        } else {
          await this.permissions.assertPermissionTx(
            m,
            ctx,
            PermissionFlag.STAFF_DOCUMENT_MANAGE,
          );
          staffUserId = await this.resolveManagedStaff(
            m,
            ctx,
            target.staffProfileId,
          );
        }
        const documentType = this.assertDocumentInput(input);
        // Bytes decide the type (magic bytes), then the size ceiling — before the scanner or the object store sees anything.
        const { ext } = this.files.validateContent(
          FileKind.STAFF_DOCUMENT,
          buffer,
        );
        const verdict = await this.scanner.scan(buffer);
        if (verdict.status === 'infected') {
          // Committed (the audit row), then answered 400 after the transaction; nothing was stored.
          await this.audit.record(
            m,
            ctx,
            AuditAction.STAFF_DOCUMENT_UPLOAD_REJECTED,
            {
              targetUserId: staffUserId,
              entityType: 'staff_document',
              metadata: {
                documentType,
                reason: 'virus_detected',
                engine: verdict.engine,
              },
            },
          );
          return {
            rejected: 'The file was rejected by the virus scanner.',
          } as const;
        }
        const documentId = (await m.query(`SELECT gen_random_uuid() AS id`))[0]
          .id as string;
        let uploaded: UploadedObject | null = null;
        try {
          uploaded = await this.files.putObject({
            kind: FileKind.STAFF_DOCUMENT,
            organisationId: ctx.organisationId!,
            workspaceId: ctx.workspaceId!,
            resourceType: 'staff_document',
            resourceId: documentId,
            buffer,
            filename: `${documentType}.${ext}`,
            createdBy: ctx.userId,
          });
          const file = await this.files.registerAvailable(m, uploaded);
          const scan = scanColumns(verdict);
          await m.query(
            `INSERT INTO core.staff_document (id, organisation_id, workspace_id, staff_user_id, document_type, file_id, issued_on, expires_on, uploaded_by, scan_status, scan_engine, scanned_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              documentId,
              ctx.organisationId,
              ctx.workspaceId,
              staffUserId,
              documentType,
              file.id,
              input.issuedOn ?? null,
              input.expiresOn ?? null,
              ctx.userId,
              scan.status,
              scan.engine,
              scan.at,
            ],
          );
          await this.audit.record(m, ctx, AuditAction.STAFF_DOCUMENT_UPLOADED, {
            targetUserId: staffUserId,
            entityType: 'staff_document',
            entityId: documentId,
            metadata: {
              documentType,
              issuedOn: input.issuedOn ?? null,
              expiresOn: input.expiresOn ?? null,
              fileId: file.id,
              sizeBytes: file.sizeBytes,
              scanStatus: scan.status,
              self: target.kind === 'self',
            },
          });
          return {
            view: this.toView(
              await this.loadDocument(m, ctx, documentId, staffUserId),
            ),
          } as const;
        } catch (error) {
          if (uploaded) await this.files.discardUnregistered(uploaded);
          throw error;
        }
      },
    );
    if ('rejected' in outcome) throw new BadRequestException(outcome.rejected);
    return outcome.view;
  }

  private async decide(
    ctx: AuthContext,
    staffProfileId: string,
    documentId: string,
    to: StaffDocumentStatusType,
    reason: string | null,
  ): Promise<StaffDocumentView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(
        m,
        ctx,
        PermissionFlag.STAFF_DOCUMENT_MANAGE,
      );
      const staffUserId = await this.resolveManagedStaff(
        m,
        ctx,
        staffProfileId,
      );
      const doc = await this.loadDocument(
        m,
        ctx,
        documentId,
        staffUserId,
        true,
      );
      // Exists and the caller may see it, but nobody decides on their own document (RLS WITH CHECK says the same).
      if (doc.staff_user_id === ctx.userId)
        throw new ForbiddenException(
          'You cannot verify, reject or revoke your own document.',
        );
      assertTransition(
        STAFF_DOCUMENT_TRANSITIONS,
        doc.status as StaffDocumentStatusType,
        to,
      );
      if (
        to === StaffDocumentStatus.VERIFIED &&
        doc.scan_status !== StaffDocumentScanStatus.CLEAN
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: 'STAFF_DOCUMENT_NOT_SCANNED',
          message:
            'This document cannot be verified until a virus scan has marked it clean.',
        });
      }
      const set =
        to === StaffDocumentStatus.VERIFIED
          ? `status = 'verified', verified_by = $3, verified_at = now()`
          : to === StaffDocumentStatus.REJECTED
            ? `status = 'rejected', rejected_by = $3, rejected_at = now(), rejection_reason = $4`
            : `status = 'revoked', revoked_by = $3, revoked_at = now(), revocation_reason = $4`;
      const params =
        to === StaffDocumentStatus.VERIFIED
          ? [documentId, doc.status, ctx.userId]
          : [documentId, doc.status, ctx.userId, reason];
      const [, affected] = await m.query(
        // sql-injection-reviewed: `set` is one of three code-constant fragments chosen above; every value is a bound parameter.
        `UPDATE core.staff_document SET ${set} WHERE id = $1 AND status = $2`,
        params,
      );
      if (!affected)
        throw new ConflictException(
          'This document was changed by someone else. Refresh and try again.',
        );
      const action =
        to === StaffDocumentStatus.VERIFIED
          ? AuditAction.STAFF_DOCUMENT_VERIFIED
          : to === StaffDocumentStatus.REJECTED
            ? AuditAction.STAFF_DOCUMENT_REJECTED
            : AuditAction.STAFF_DOCUMENT_REVOKED;
      await this.audit.record(m, ctx, action, {
        targetUserId: staffUserId,
        entityType: 'staff_document',
        entityId: documentId,
        metadata: {
          documentType: doc.document_type,
          from: doc.status,
          to,
          reason,
        },
      });
      return this.toView(
        await this.loadDocument(m, ctx, documentId, staffUserId),
      );
    });
  }

  private assertDocumentInput(input: {
    documentType: string;
    issuedOn?: string;
    expiresOn?: string;
  }): StaffDocumentTypeType {
    if (
      !(STAFF_DOCUMENT_TYPES as readonly string[]).includes(input.documentType)
    )
      throw new BadRequestException('Unknown document type.');
    for (const [name, value] of [
      ['issuedOn', input.issuedOn],
      ['expiresOn', input.expiresOn],
    ] as const) {
      if (value !== undefined && !isCalendarDate(value))
        throw new BadRequestException(
          `${name} must be a real date (YYYY-MM-DD).`,
        );
    }
    const today = londonDate(new Date());
    if (input.issuedOn && input.issuedOn > today)
      throw new BadRequestException('issuedOn cannot be in the future.');
    if (input.issuedOn && input.expiresOn && input.expiresOn < input.issuedOn)
      throw new BadRequestException('expiresOn cannot be before issuedOn.');
    if (
      input.expiresOn &&
      input.expiresOn > `${Number(today.slice(0, 4)) + 50}${today.slice(4)}`
    )
      throw new BadRequestException('expiresOn is too far in the future.');
    return input.documentType as StaffDocumentTypeType;
  }

  /** Another person's documents: a non-venue manager of the caller's own workspace, and the staff profile must be in it. 404 otherwise. */
  private async resolveManagedStaff(
    m: EntityManager,
    ctx: AuthContext,
    staffProfileId: string,
  ): Promise<string> {
    if (!(await this.isWorkspaceManager(m, ctx)))
      throw new NotFoundException('Staff member not found.');
    const t = businessTables(m);
    const [profile] = await m.query(
      `SELECT user_id FROM ${t.staff_profile} WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3`,
      [staffProfileId, ctx.organisationId, ctx.workspaceId],
    );
    if (!profile) throw new NotFoundException('Staff member not found.');
    return profile.user_id as string;
  }

  /** One's own documents: the caller must hold a staff profile in the bound workspace. */
  private async resolveOwnStaff(
    m: EntityManager,
    ctx: AuthContext,
  ): Promise<void> {
    const t = businessTables(m);
    const [profile] = await m.query(
      `SELECT id FROM ${t.staff_profile} WHERE user_id = $1 AND organisation_id = $2 AND workspace_id = $3`,
      [ctx.userId, ctx.organisationId, ctx.workspaceId],
    );
    if (!profile) throw new NotFoundException('Staff profile not found.');
  }

  private async isWorkspaceManager(
    m: EntityManager,
    ctx: AuthContext,
  ): Promise<boolean> {
    const [row] = await m.query(
      `SELECT 1 FROM core.manager_profile WHERE user_id = $1 AND organisation_id = $2 AND workspace_id = $3 AND type <> 'venue' AND archived_at IS NULL LIMIT 1`,
      [ctx.userId, ctx.organisationId, ctx.workspaceId],
    );
    return !!row;
  }

  private async listFor(
    m: EntityManager,
    ctx: AuthContext,
    staffUserId: string,
  ): Promise<StaffDocumentView[]> {
    const rows: DocumentRow[] = await m.query(
      // sql-injection-reviewed: DOCUMENT_COLUMNS is a module-level code constant (column list); every value is a bound $n parameter.
      `SELECT ${DOCUMENT_COLUMNS} FROM core.staff_document
        WHERE organisation_id = $1 AND workspace_id = $2 AND staff_user_id = $3
        ORDER BY created_at DESC, id`,
      [ctx.organisationId, ctx.workspaceId, staffUserId],
    );
    return rows.map((r) => this.toView(r));
  }

  private async requiredTypes(
    m: EntityManager,
    ctx: AuthContext,
  ): Promise<string[]> {
    return (await effectiveRequiredTypes(m, ctx.organisationId!))
      .filter((r) => r.required)
      .map((r) => r.documentType);
  }

  private async loadDocument(
    m: EntityManager,
    ctx: AuthContext,
    documentId: string,
    staffUserId: string,
    forUpdate = false,
  ): Promise<DocumentRow> {
    const [row] = await m.query(
      // sql-injection-reviewed: DOCUMENT_COLUMNS is a module-level code constant (column list); every value is a bound $n parameter.
      `SELECT ${DOCUMENT_COLUMNS} FROM core.staff_document
        WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND staff_user_id = $4${forUpdate ? ' FOR UPDATE' : ''}`,
      [documentId, ctx.organisationId, ctx.workspaceId, staffUserId],
    );
    if (!row) throw new NotFoundException('Document not found.');
    return row as DocumentRow;
  }

  private toView(r: DocumentRow): StaffDocumentView {
    const today = londonDate(new Date());
    return {
      id: r.id,
      documentType: r.document_type,
      documentTypeLabel:
        STAFF_DOCUMENT_TYPE_LABELS[r.document_type as StaffDocumentTypeType] ??
        r.document_type,
      issuedOn: r.issued_on,
      expiresOn: r.expires_on,
      status: r.status,
      scanStatus: r.scan_status,
      fileId: isFileVisible(r.status, r.scan_status) ? r.file_id : null,
      uploadedAt: new Date(r.created_at).toISOString(),
      uploadedBySelf: r.uploaded_by === r.staff_user_id,
      verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
      rejectionReason: r.rejection_reason,
      revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
      revocationReason: r.revocation_reason,
      expired: isExpiredOn(r.expires_on, today),
      daysUntilExpiry: r.expires_on ? daysBetween(today, r.expires_on) : null,
    };
  }
}

function scanColumns(verdict: VirusScanVerdict): {
  status: string;
  engine: string | null;
  at: Date | null;
} {
  // Only a real scanner's `clean` is recorded as clean; `unavailable` (no scanner, daemon down, timeout) stays not_scanned.
  if (verdict.status === 'clean')
    return {
      status: StaffDocumentScanStatus.CLEAN,
      engine: verdict.engine,
      at: new Date(),
    };
  return {
    status: StaffDocumentScanStatus.NOT_SCANNED,
    engine: null,
    at: null,
  };
}

import { EntityManager } from 'typeorm';

import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { FileKindPolicy } from '../../../engine/core-modules/storage/file-access.registry';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { StaffDocumentService } from '../services/staff-document.service';

/**
 * Who may download a STAFF_DOCUMENT (layer 2; the files controller answers 404 and records `file.access_denied`
 * otherwise). Layer 4 first: `stored_file_tenant` (organisation AND workspace), then core.staff_document's own RLS. The rule
 * itself is StaffDocumentService.canReadFile, one place for the console, the staff app and any future caller. A revoked
 * or not-yet-clean document is never served, so a download link stops working the moment a document is revoked (each
 * request re-checks; a presigned S3 URL already minted lives at most 60 s, FILE_KIND_RULES.STAFF_DOCUMENT).
 */
export class StaffDocumentFilePolicy implements FileKindPolicy {
  constructor(private readonly documents: StaffDocumentService) {}

  canRead(
    manager: EntityManager,
    ctx: AuthContext,
    file: StoredFile,
  ): Promise<boolean> {
    return this.documents.canReadFile(manager, ctx, file);
  }
}

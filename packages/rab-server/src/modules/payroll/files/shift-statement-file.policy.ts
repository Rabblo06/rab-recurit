import { PermissionFlag } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { FileKindPolicy } from '../../../engine/core-modules/storage/file-access.registry';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PayrollService } from '../services/payroll.service';

/**
 * Who may download an APPROVED_SHIFT_STATEMENT_PDF (layer 2; `files.controller` answers 404 + audits `file.access_denied` otherwise).
 * Layer 4 first: `stored_file_tenant` RLS only lets the row through inside its own organisation AND workspace.
 * Then: the file must be the CURRENT statement of a payroll record the caller can see under payroll_record RLS, and the
 * caller is either the staff member it belongs to (with `payslip.view_own`) or a non-venue manager of that workspace with
 * `payroll.view`. Everyone else — other staff, Venue Managers, other workspaces — gets exactly "not found".
 */
export class ShiftStatementFilePolicy implements FileKindPolicy {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly payroll: PayrollService,
  ) {}

  async canRead(manager: EntityManager, ctx: AuthContext, file: StoredFile): Promise<boolean> {
    if (file.resourceType !== 'payroll_record' || !ctx.organisationId || !ctx.workspaceId) return false;
    const [record] = await manager.query(
      `SELECT pr.statement_file_id, sp.user_id AS staff_user_id
         FROM payroll_record pr JOIN staff_profile sp ON sp.id = pr.staff_profile_id
        WHERE pr.id = $1 AND pr.organisation_id = $2 AND pr.workspace_id = $3`,
      [file.resourceId, ctx.organisationId, ctx.workspaceId],
    );
    if (!record || record.statement_file_id !== file.id) return false;
    if (record.staff_user_id === ctx.userId) return this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.PAYSLIP_VIEW_OWN);
    return this.payroll.canAccessPayroll(manager, ctx, PermissionFlag.PAYROLL_VIEW);
  }
}

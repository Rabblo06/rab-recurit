import { PermissionFlag } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { FileKindPolicy } from '../../../engine/core-modules/storage/file-access.registry';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PayrollService } from '../services/payroll.service';

/**
 * Who may download a PAYSLIP_PDF (layer 2; 404 + `file.access_denied` otherwise). Layer 4 first: `stored_file_tenant`
 * (organisation AND workspace). The file must be a `payslip_document` visible under RLS. The staff member it belongs to
 * (with `payslip.view_own`) gets only the CURRENT version; a non-venue `payroll.view` manager of the workspace may open
 * any version (history). Other staff, Venue Managers and other workspaces: not found.
 */
export class PayslipFilePolicy implements FileKindPolicy {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly payroll: PayrollService,
  ) {}

  async canRead(manager: EntityManager, ctx: AuthContext, file: StoredFile): Promise<boolean> {
    if (file.resourceType !== 'payslip' || !ctx.organisationId || !ctx.workspaceId) return false;
    const [doc] = await manager.query(
      `SELECT d.version, ps.version AS current_version, sp.user_id AS staff_user_id
         FROM payslip_document d JOIN payslip ps ON ps.id = d.payslip_id JOIN staff_profile sp ON sp.id = ps.staff_profile_id
        WHERE d.file_id = $1 AND d.payslip_id = $2 AND d.organisation_id = $3 AND d.workspace_id = $4`,
      [file.id, file.resourceId, ctx.organisationId, ctx.workspaceId]);
    if (!doc) return false;
    if (doc.staff_user_id === ctx.userId) {
      return Number(doc.version) === Number(doc.current_version) && this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.PAYSLIP_VIEW_OWN);
    }
    return this.payroll.canAccessPayroll(manager, ctx, PermissionFlag.PAYROLL_VIEW);
  }
}

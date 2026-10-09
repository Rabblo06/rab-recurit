import { DataSource } from 'typeorm';

import { organisationIds } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';

/**
 * Test hygiene, not production behaviour. The email dispatcher claims every due outbox row across all organisations, so a row a
 * previous suite left PENDING/QUEUED/PROCESSING/RETRY is claimable by the next suite's cycle and makes its assertions fail. This
 * cancels those leftovers before a suite that runs the dispatcher, one organisation at a time under its own tenant context
 * (email_outbox is FORCE RLS, so a global UPDATE would see nothing). Terminal rows (SENT, FAILED, CANCELLED) are left alone.
 */
export async function cancelLeftoverClaimableEmails(dataSource: DataSource, tenantContext: TenantContextService): Promise<number> {
  let cancelled = 0;
  for await (const organisationId of organisationIds(dataSource)) {
    const affected = await tenantContext.runInTenantContext(
      { organisationId, workspaceId: null, userId: '', role: '' },
      async (manager) => {
        const [, count] = await manager.query(
          `UPDATE core.email_outbox SET status = 'CANCELLED', cancelled_at = now(), last_error_message_sanitized = 'Cancelled by test isolation'
            WHERE status IN ('PENDING', 'QUEUED', 'PROCESSING', 'RETRY')`,
        );
        return Number(count ?? 0);
      },
    );
    cancelled += affected;
  }
  return cancelled;
}

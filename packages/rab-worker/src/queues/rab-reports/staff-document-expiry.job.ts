import {
  calendarDaysBetween,
  londonCalendarDate,
  NotificationType,
  NotificationTypeType,
  STAFF_DOCUMENT_EXPIRY_ALERT_DAYS,
  STAFF_DOCUMENT_TYPE_LABELS,
  StaffDocumentTypeType,
} from '@rab/shared';
import { DataSource, EntityManager } from 'typeorm';

import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import {
  claimWorkerEvent,
  completeWorkerEvent,
} from '../../core/database/worker-event';
import { isNotYetRoutableWorkspace } from '../../core/database/workspace-routing';

const MAX_DAYS = Math.max(...STAFF_DOCUMENT_EXPIRY_ALERT_DAYS);

/**
 * Collaborators typed structurally (the processor passes the real TenantContextService / NotificationService), so this job
 * adds no deep import into rab-server (tools/check-import-boundaries.cjs, worker-deep-import ratchet).
 */
type TenantContext = Parameters<typeof discoverInWorkspaces>[1];
export interface StaffDocumentNotifier {
  notify(
    manager: EntityManager,
    params: {
      organisationId: string;
      userId: string;
      type: NotificationTypeType;
      title: string;
      message: string;
      relatedEntityType?: string;
      relatedEntityId?: string;
      forceEmail?: boolean;
    },
  ): Promise<void>;
}

interface Candidate {
  organisation_id: string;
  workspace_id: string;
  document_id: string;
  staff_user_id: string;
  document_type: StaffDocumentTypeType;
  expires_on: string;
  owner: string | null;
}

export interface StaffDocumentExpiryResult {
  notified: number;
  candidates: number;
}

/** The alert threshold a document is due for today: the tightest of 30 / 7 / 0 days it has reached, or null. */
export function dueThreshold(daysLeft: number): number | null {
  if (daysLeft < 0) return null;
  const reached = STAFF_DOCUMENT_EXPIRY_ALERT_DAYS.filter((t) => daysLeft <= t);
  return reached.length ? Math.min(...reached) : null;
}

function whenText(daysLeft: number, expiresOn: string): string {
  if (daysLeft === 0) return `expires today (${expiresOn})`;
  return `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (on ${expiresOn})`;
}

/**
 * Lane D: staff documents expiring in 30 days, 7 days and today (London calendar dates). For each held document (pending or
 * verified) the staff member and the workspace owner are notified ONCE per threshold — worker event
 * `staff-document-expiry:<document>:<threshold>` (UNIQUE claim, same transaction as the notifications, so a failure retries
 * on the next tick and a success never repeats). When the Worker first sees a document already inside a window (e.g. 5
 * days left) it sends only the tightest threshold reached (7), never a stale 30-day notice.
 *
 * Per-tenant context: discovery runs read-only in each workspace's own context with the Worker marker (the
 * staff_document_select worker predicate); each notification runs in that same organisation + workspace. In-app + email
 * (forceEmail: the user's own preference can switch email off). Recipients: ASSUMPTION (flagged) — the staff member and the
 * workspace owner; other managers see the expiry in the console. Names are not read (no rab-server dependency): the
 * owner's notice links the document. A revoked / rejected document, an expired one (days < 0) and one without an expiry
 * date are skipped.
 */
export async function runStaffDocumentExpiryCycle(
  discoveryDataSource: DataSource,
  tenantContext: TenantContext,
  notifications: StaffDocumentNotifier,
  options: { organisationId?: string; today?: string } = {},
): Promise<StaffDocumentExpiryResult> {
  const today = options.today ?? londonCalendarDate(new Date());
  const candidates = await discoverInWorkspaces(
    discoveryDataSource,
    tenantContext,
    async (m) => {
      const [ws] = await m.query(
        `SELECT core.current_org() AS org, core.current_workspace() AS ws`,
      );
      if (!ws?.org || !ws?.ws) return [];
      return m.query(
        `SELECT d.organisation_id, d.workspace_id, d.id AS document_id, d.staff_user_id, d.document_type,
                to_char(d.expires_on, 'YYYY-MM-DD') AS expires_on,
                (SELECT w.owner_user_id FROM core.manager_workspace w WHERE w.id = d.workspace_id) AS owner
           FROM core.staff_document d
          WHERE d.organisation_id = $1 AND d.workspace_id = $2 AND d.status IN ('pending', 'verified')
            AND d.expires_on BETWEEN $3::date AND ($3::date + $4::int)
          ORDER BY d.expires_on, d.id`,
        [ws.org, ws.ws, today, MAX_DAYS],
      ) as Promise<Candidate[]>;
    },
    options.organisationId,
  );

  let notified = 0;
  for (const c of candidates) {
    const daysLeft = calendarDaysBetween(today, c.expires_on);
    const threshold = dueThreshold(daysLeft);
    if (threshold === null) continue;
    const label =
      STAFF_DOCUMENT_TYPE_LABELS[c.document_type] ?? c.document_type;
    let done: boolean;
    try {
      done = await tenantContext.runInTenantContext(
        {
          organisationId: c.organisation_id,
          workspaceId: c.workspace_id,
          userId: '',
          role: '',
          actorType: 'worker',
        },
        async (m) => {
          const eventId = await claimWorkerEvent(m, {
            organisationId: c.organisation_id,
            workspaceId: c.workspace_id,
            eventKey: `staff-document-expiry:${c.document_id}:${threshold}`,
            eventType: 'staff-document-expiry',
            entityType: 'staff_document',
            entityId: c.document_id,
          });
          if (!eventId) return false;
          // Re-read under the same transaction: a document revoked since discovery gets no notice.
          const [still] = await m.query(
            `SELECT 1 FROM core.staff_document WHERE id = $1 AND status IN ('pending', 'verified') AND expires_on = $2::date`,
            [c.document_id, c.expires_on],
          );
          if (still) {
            await notifications.notify(m, {
              organisationId: c.organisation_id,
              userId: c.staff_user_id,
              type: NotificationType.STAFF_DOCUMENT_EXPIRING,
              title:
                daysLeft === 0
                  ? `Your ${label} expires today`
                  : `Your ${label} expires soon`,
              message: `Your ${label} ${whenText(daysLeft, c.expires_on)}. Upload a renewed document in the Crewflow app so you can keep receiving shifts.`,
              relatedEntityType: 'staff_document',
              relatedEntityId: c.document_id,
              forceEmail: true,
            });
            if (c.owner && c.owner !== c.staff_user_id) {
              await notifications.notify(m, {
                organisationId: c.organisation_id,
                userId: c.owner,
                type: NotificationType.STAFF_DOCUMENT_EXPIRING,
                title: `Staff ${label} ${daysLeft === 0 ? 'expires today' : 'expiring soon'}`,
                message: `A staff member's ${label} ${whenText(daysLeft, c.expires_on)}. Open the staff member's documents in Users to review.`,
                relatedEntityType: 'staff_document',
                relatedEntityId: c.document_id,
                forceEmail: true,
              });
            }
          }
          await completeWorkerEvent(m, eventId);
          return Boolean(still);
        },
      );
    } catch (error) {
      if (isNotYetRoutableWorkspace(error)) continue;
      throw error;
    }
    if (done) notified += 1;
  }
  return { notified, candidates: candidates.length };
}

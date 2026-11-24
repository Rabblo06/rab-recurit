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

  // Review L1: one notice per staff member and threshold (20 documents expiring together = 1 owner email, not 20). Each
  // document still has its own worker_event claim, so idempotency stays per document and threshold.
  const groups = new Map<
    string,
    { c: Candidate; threshold: number; daysLeft: number; docs: Candidate[] }
  >();
  for (const c of candidates) {
    const daysLeft = calendarDaysBetween(today, c.expires_on);
    const threshold = dueThreshold(daysLeft);
    if (threshold === null) continue;
    const key = `${c.workspace_id}:${c.staff_user_id}:${threshold}`;
    const g = groups.get(key);
    if (g) {
      g.docs.push(c);
      g.daysLeft = Math.min(g.daysLeft, daysLeft);
    } else groups.set(key, { c, threshold, daysLeft, docs: [c] });
  }

  let notified = 0;
  for (const g of groups.values()) {
    let sent: number;
    try {
      sent = await tenantContext.runInTenantContext(
        {
          organisationId: g.c.organisation_id,
          workspaceId: g.c.workspace_id,
          userId: '',
          role: '',
          actorType: 'worker',
        },
        async (m) => {
          const fresh: Candidate[] = [];
          const claims: string[] = [];
          for (const d of g.docs) {
            const eventId = await claimWorkerEvent(m, {
              organisationId: d.organisation_id,
              workspaceId: d.workspace_id,
              eventKey: `staff-document-expiry:${d.document_id}:${g.threshold}`,
              eventType: 'staff-document-expiry',
              entityType: 'staff_document',
              entityId: d.document_id,
            });
            if (!eventId) continue;
            claims.push(eventId);
            // Re-read under the same transaction: a document revoked since discovery gets no notice.
            const [still] = await m.query(
              `SELECT 1 FROM core.staff_document WHERE id = $1 AND status IN ('pending', 'verified') AND expires_on = $2::date`,
              [d.document_id, d.expires_on],
            );
            if (still) fresh.push(d);
          }
          if (fresh.length) {
            const labels = [
              ...new Set(
                fresh.map(
                  (d) =>
                    STAFF_DOCUMENT_TYPE_LABELS[d.document_type] ??
                    d.document_type,
                ),
              ),
            ];
            const earliest = fresh.reduce((x, d) =>
              d.expires_on < x.expires_on ? d : x,
            );
            const daysLeft = calendarDaysBetween(today, earliest.expires_on);
            const what =
              labels.length === 1
                ? labels[0]!
                : `${labels.length} documents (${labels.join(', ')})`;
            const verb = labels.length === 1 ? 'expires' : 'expire';
            const when =
              daysLeft === 0
                ? `${verb} today (${earliest.expires_on})`
                : `${verb} in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (from ${earliest.expires_on})`;
            const related =
              fresh.length === 1
                ? {
                    relatedEntityType: 'staff_document',
                    relatedEntityId: earliest.document_id,
                  }
                : {};
            await notifications.notify(m, {
              organisationId: g.c.organisation_id,
              userId: g.c.staff_user_id,
              type: NotificationType.STAFF_DOCUMENT_EXPIRING,
              title:
                daysLeft === 0
                  ? `Your ${what} ${verb} today`
                  : `Your ${what} ${verb} soon`,
              message: `Your ${what} ${when}. Upload a renewed document in the Crewflow app so you can keep receiving shifts.`,
              ...related,
              forceEmail: true,
            });
            if (g.c.owner && g.c.owner !== g.c.staff_user_id) {
              await notifications.notify(m, {
                organisationId: g.c.organisation_id,
                userId: g.c.owner,
                type: NotificationType.STAFF_DOCUMENT_EXPIRING,
                title: `Staff ${what} ${daysLeft === 0 ? `${verb} today` : 'expiring soon'}`,
                message: `A staff member's ${what} ${when}. Open the staff member's documents in Users to review.`,
                ...related,
                forceEmail: true,
              });
            }
          }
          for (const id of claims) await completeWorkerEvent(m, id);
          return fresh.length;
        },
      );
    } catch (error) {
      if (isNotYetRoutableWorkspace(error)) continue;
      throw error;
    }
    notified += sent;
  }
  return { notified, candidates: candidates.length };
}

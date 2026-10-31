import { EmailOutboxJobType, NotificationTypeType } from '@rab/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { PushDeliveryService } from '../../../engine/core-modules/push/push-delivery.service';
import { RealtimeEventService, RealtimeEventType } from '../../../engine/core-modules/realtime/realtime-event.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { escapeHtml } from '../../../engine/utils/escape-html';
import { NotificationPreference } from '../../identity/entities';
import { Notification } from '../entities/notification.entity';

export interface NotifyParams {
  organisationId: string;
  userId: string;
  type: NotificationTypeType;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  /**
   * Bypasses the preference lookup's email default (off, for any type with
   * no explicit `notification_preference` row — see this file's own class
   * doc comment) and always enqueues the email. Reserved for the small set
   * of notifications that are the ONLY delivery channel for information the
   * recipient never sees any other way — e.g. a Venue Manager whose staff
   * selection changed underneath them, on a request they may not be
   * actively watching in-app. Never used to override a REAL, previously
   * saved user preference — `emailEnabled` here only ever fills the gap
   * where no preference row exists at all.
   */
  forceEmail?: boolean;
}

/**
 * In-app + (preference-gated) email — no push provider, no WebSocket yet.
 * `notify()` takes an already-open, tenant-bound `EntityManager` (mirrors
 * `AuditService.record`) so both the in-app row and the durable outbox row
 * land in the same transaction as the state change they're about: either
 * all three commit or none does.
 *
 * The email side previously called `EmailService.send()` inline,
 * synchronously, inside this same request — a direct SMTP/API call sitting
 * inside a critical HTTP path (offer sent/accepted/etc.), best-effort
 * try/catch swallowed on failure. Now it durably enqueues instead (same
 * `EmailOutboxService`/dispatcher/worker path every other email type in
 * this app already uses) and relies on the dispatcher's ~2s poll loop
 * rather than a request-time fast-publish — `notify()` is called from deep
 * inside other services' own transactions (`OfferService`), which don't
 * hand back a commit hook this method could use to fire a fast-publish
 * itself, and a couple of seconds' added latency for an in-app-first
 * notification email is an acceptable trade for not re-plumbing 6 call
 * sites. The actual SMTP/API call now always happens in the worker
 * process, never in this request.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly entityCache: CoreEntityCacheService,
    private readonly pushDelivery: PushDeliveryService,
  ) {}

  /** C1b realtime outbox — property-injected so the constructor signature (and every existing construction) is unchanged. */
  @Inject(RealtimeEventService)
  private readonly realtimeEvents!: RealtimeEventService;

  /**
   * Consults `notification_preference` before doing anything — both
   * in-app and email delivery are real, preference-gated behaviour, not a
   * dead settings toggle. Defaults (in-app on, email off) match no row
   * existing yet, mirroring ProfileService.listNotificationPreferences.
   */
  async notify(manager: EntityManager, params: NotifyParams): Promise<void> {
    // P2.8 — a suspended organisation's background jobs (shift/clock-in reminders, offer expiry,
    // no-show flags, etc.) never reach this far via an ordinary interactive request — every HTTP
    // route is already blocked by `OrganisationSuspendedGuard`. A WORKER job calls services
    // directly, with no guard chain at all, which is exactly the gap the owner's P2.8 spec's
    // requirement 6 names ("inappropriate background offers, reminders and push notifications").
    // Silently no-ops rather than throwing: `notify()` runs deep inside the CALLER's own
    // transaction (an offer/shift-request state change), and a suspended org's underlying
    // business-state writes are a separate question from whether anyone should be pinged about
    // them — throwing here would also roll back whatever state change the caller was already
    // committing. See docs/HANDOFF.md's P2.8 worker-job audit for which jobs this actually silences
    // (reminders, offer notifications) vs. which keep running untouched (retention/cleanup jobs,
    // which never call this method at all).
    const [org] = await manager.query<Array<{ suspended_at: string | null }>>(
      `SELECT suspended_at FROM core.organisation WHERE id = $1`,
      [params.organisationId],
    );
    if (org?.suspended_at) return;

    const preference = await manager.findOne(NotificationPreference, {
      where: { userId: params.userId, notificationType: params.type },
    });
    const inAppEnabled = preference?.inAppEnabled ?? true;
    const emailEnabled = preference?.emailEnabled ?? (params.forceEmail ?? false);

    if (inAppEnabled) {
      const entry = manager.create(Notification, {
        organisationId: params.organisationId,
        userId: params.userId,
        type: params.type,
        title: params.title,
        message: params.message,
        relatedEntityType: params.relatedEntityType,
        relatedEntityId: params.relatedEntityId,
      });
      await manager.save(entry);
      // Stage 6 — same transaction as the Notification row above, same atomic-outbox pattern
      // every other durable row in this method already uses. A no-op (0 rows) when PUSH_ENABLED
      // is false or the user has no active registered device — never a second notification path.
      await this.pushDelivery.createForNotification(manager, {
        organisationId: params.organisationId,
        userId: params.userId,
        notificationId: entry.id,
      });
      // C1b realtime (same transaction as the in-app row): notification.created → exactly this notification's
      // recipient, nobody else. Ids only — never the title/message. The bell/list refetch it over REST.
      await this.realtimeEvents.recordForRecipients(manager, {
        organisationId: params.organisationId, eventKey: `notification.created:${entry.id}`, eventType: RealtimeEventType.NOTIFICATION_CREATED, entityType: 'notification', entityId: entry.id,
      }, async () => [{ userId: params.userId, workspaceId: null }]);
    }

    if (emailEnabled) {
      // Redis checkpoint — Core Entity Cache: only `user.email` is read here, never anything
      // security-relevant, so the read-through display cache is a safe fit for this hot path
      // (fired on nearly every offer/shift-request lifecycle event — see CoreEntityCacheService's
      // own doc comment for why a stale-by-at-most-5-minutes email address is an acceptable trade
      // here specifically, unlike e.g. a live status check).
      const user = await this.entityCache.getUserDisplay(manager, params.userId);
      if (user) {
        // MAIL-01 — `params.message` (and `.title`) reach this point already
        // assembled from dozens of call sites across services and worker
        // jobs, many of which interpolate manager-controlled free text
        // (venue names, job role names, decline reasons, staff display
        // names) with no escaping of their own. This is the one place every
        // one of those call sites funnels through before becoming HTML, so
        // it is the one place that needs to escape — not each caller
        // individually. `<p>...</p>` is trusted TEMPLATE markup; only the
        // interpolated VALUE is escaped. The plain-text alternative
        // (`text:`) is left exactly as `params.message` was written —
        // escaping is an HTML-only concern (§33: plain text must never
        // contain HTML entities as user-visible text).
        await this.emailOutbox.enqueue(manager, {
          organisationId: params.organisationId,
          jobType: EmailOutboxJobType.NOTIFICATION,
          recipientEmail: user.email,
          targetUserId: params.userId,
          rendered: { subject: params.title, html: `<p>${escapeHtml(params.message)}</p>`, text: params.message },
        });
      }
    }
  }

  list(ctx: AuthContext): Promise<Notification[]> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.find(Notification, {
        where: { userId: ctx.userId },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
    );
  }

  unreadCount(ctx: AuthContext): Promise<{ count: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const count = await manager
        .createQueryBuilder(Notification, 'n')
        .where('n.user_id = :userId', { userId: ctx.userId })
        .andWhere('n.read_at IS NULL')
        .getCount();
      return { count };
    });
  }

  async markRead(ctx: AuthContext, id: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const result = await manager.update(Notification, { id, userId: ctx.userId }, { readAt: new Date() });
      if (!result.affected) throw new NotFoundException('Notification not found.');
    });
  }

  async markAllRead(ctx: AuthContext): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager
        .createQueryBuilder()
        .update(Notification)
        .set({ readAt: new Date() })
        .where('user_id = :userId', { userId: ctx.userId })
        .andWhere('read_at IS NULL')
        .execute(),
    );
  }
}

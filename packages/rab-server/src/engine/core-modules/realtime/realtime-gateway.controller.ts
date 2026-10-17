import { Controller, HttpException, HttpStatus, Logger, Req, Sse, UseGuards, MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WEB_SESSION_COOKIE_NAME } from '../auth/constants/web-session-cookie.constants';
import { AccessTokenService } from '../auth/token/services/access-token.service';
import { SecurityVersionService, SecurityVersionVector } from '../auth/services/security-version.service';
import { SessionValidityService } from '../auth/services/session-validity.service';
import { EnvironmentService } from '../environment/environment.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { RealtimeConnectionRegistryService } from './realtime-connection-registry.service';
import { RealtimeGatewaySubscriberProvider } from './realtime-gateway-subscriber.provider';
import { RealtimeEventEnvelope, realtimeUserChannel } from './realtime-envelope';
import { MobileApplication } from '../auth/guards/mobile-application.decorator';

const DEDUP_WINDOW_SIZE = 200;

/**
 * Stage 3 — the authenticated real-time gateway. One HTTP GET, kept open (Server-Sent Events),
 * guarded by the EXACT SAME `JwtAuthGuard` every other route uses — zero new authentication code.
 * See `docs/architecture/REALTIME-PUBSUB-DESIGN.md` and the Stage 3 exit report for the full
 * transport-selection reasoning; short version: SSE needs no new dependency (`@Sse()` is already
 * part of `@nestjs/common`), flows through the EXISTING Express/cookie-parser/CORS/CSRF/fencing
 * pipeline with zero gaps (confirmed: `cookieParser()` is mounted in `AppModule.configure()` for
 * `forRoutes('*')`, so an SSE request — an ordinary HTTP GET kept open, not a protocol upgrade —
 * gets `request.cookies` exactly like any other route), and a WebSocket upgrade's cookie handling
 * is NOT guaranteed the same way without new, bespoke code. Browsers' native `EventSource` can't
 * send custom headers, but that's irrelevant here: web auth is the `crewflow_session` COOKIE,
 * sent automatically by any `fetch`/`EventSource` call with credentials included; mobile (Bearer)
 * doesn't use the browser `EventSource` API at all, so it can attach `Authorization` freely.
 *
 * CONNECTION LIFECYCLE (requirement 3.5):
 *  1. Connect  — client opens `GET /rest/v1/realtime/stream`.
 *  2. Authenticate — `JwtAuthGuard` (cookie or Bearer, unmodified) populates `request.authContext`,
 *     including a full `AuthSecuritySnapshot` (roles, permissions, account status) built from a
 *     REPEATABLE READ Postgres snapshot — the SAME one every other authenticated route gets.
 *  3. Authorise — `REALTIME_MAX_CONNECTIONS_PER_USER` enforced from the connection registry; a
 *     connection beyond the bound is refused outright, never queued.
 *  4. Subscribe — this connection's own handler attaches to `crewflow:{env}:rt:user:{userId}` on
 *     the ONE shared `RealtimeGatewaySubscriberProvider` instance (never a connection per client).
 *  5. Receive/Validate — every message off Redis is independently re-verified against THIS
 *     connection's bound identity (target user, organisation, workspace) before being forwarded —
 *     the channel name is never trusted as authorization by itself (requirement 3.7/3.6).
 *  6. Deliver — a minimal `MessageEvent` (the envelope, already minimal — no raw payload) is
 *     pushed to the client.
 *  7. Heartbeat/Revalidate — every `REALTIME_HEARTBEAT_INTERVAL_MS`, THREE independent checks run,
 *     and a failure of ANY of them closes the connection:
 *       a. `SecurityVersionService.readVector()` (cheap, one indexed SELECT, no full snapshot
 *          rebuild) compared against the vector captured at connect time (or the last successful
 *          heartbeat) — catches an EXPLICIT change: session revoked, role/permission edited,
 *          workspace membership changed, platform-admin grant/revoke, organisation-level security
 *          change.
 *       b. `SessionValidityService.assertActiveReadOnly()` — catches SILENT, time-based expiry
 *          (idle timeout, the session's absolute deadline) that a version check alone CANNOT see,
 *          since nothing bumps `security_version` merely because time passed. Deliberately the
 *          READ-ONLY sibling of the method every ordinary HTTP request uses — it shares that
 *          method's exact liveness/revocation/idle-expiry SQL but omits its `last_seen_at`/
 *          `idle_expires_at` bump, so an open SSE stream's own heartbeat can never be what grants
 *          an otherwise-idle session a rolling extension.
 *       c. For a Bearer (mobile JWT)-authenticated connection ONLY: the access token's own signed
 *          `exp` (captured once at connect time, re-verified via `AccessTokenService.verify()`,
 *          never trusted from an unverified decode) is compared against the real clock. Nothing
 *          server-side otherwise notifies a long-lived connection that its specific 15-minute
 *          token has expired — the session row itself can easily stay alive far longer via
 *          refresh rotation, so this is a SEPARATE condition from (b), not implied by it.
 *     A session revoked, idle-expired, or (for mobile) JWT-expired while this stream is open
 *     therefore stops receiving events within one heartbeat interval, never indefinitely.
 *  8. Disconnect/Reconnect — client close, heartbeat failure, or an upstream error all run the SAME
 *     teardown (unsubscribe from Redis, clear the heartbeat timer, remove the registry entry).
 *     Reconnection is just a brand-new request — steps 1-4 run again from scratch, so a stale
 *     identity (e.g. a browser tab logged into a different account since the last connection) can
 *     never carry over; this is the SSE analogue of this codebase's existing `X-Crewflow-Expected-
 *     Session-Id` tab-fencing idea, applied to a persistent connection instead of one request.
 *
 * DEDUPLICATION (requirement 3.10): Redis publication is at-least-once (Stage 2's own documented
 * contract) — a bounded, per-connection FIFO set of the last `DEDUP_WINDOW_SIZE` event ids silently
 * drops an exact repeat rather than forwarding it twice. This is NOT exactly-once delivery, only
 * "don't re-show the identical event to the same already-open connection" — a reconnect still gets
 * a fresh dedup window (correctly: see requirement 3.12, a reconnect reconciles state from the API,
 * never from a client-remembered event log).
 */
@Controller('rest/v1/realtime')
export class RealtimeGatewayController {
  private readonly logger = new Logger('RealtimeGateway');

  constructor(
    private readonly env: EnvironmentService,
    private readonly tenantContext: TenantContextService,
    private readonly securityVersion: SecurityVersionService,
    private readonly sessionValidity: SessionValidityService,
    private readonly accessTokenService: AccessTokenService,
    private readonly registry: RealtimeConnectionRegistryService,
    private readonly gatewaySubscriber: RealtimeGatewaySubscriberProvider,
  ) {}

  @MobileApplication()

  @Sse('stream')
  @UseGuards(JwtAuthGuard)
  stream(@Req() request: AuthenticatedRequest): Observable<MessageEvent> {
    // An explicit 204 "no stream here", never a 200 that completes immediately: clients treat a
    // 200 as a live connection and reconnect when it ends, so a disabled gateway answering 200
    // produced a reconnect (and a full cache-reconciliation refetch) roughly every second.
    if (!this.env.get('REALTIME_ENABLED')) {
      throw new HttpException('Real-time updates are not enabled.', HttpStatus.NO_CONTENT);
    }

    const ctx = request.authContext;
    const connectionId = randomUUID();

    // Captured once, at connect time, from the SAME request the guard already authenticated —
    // never a second trust decision, purely extracting the already-verified token's own `exp` so
    // the heartbeat can enforce it independently of the session row's liveness. `undefined` for a
    // cookie-authenticated connection (the cookie has no comparable fixed-lifetime token at all;
    // its own expiry is entirely the idle/absolute-deadline check in (b) above).
    let jwtExpiresAtMs: number | undefined;
    const cookiePresent = Boolean((request.cookies as Record<string, string> | undefined)?.[WEB_SESSION_COOKIE_NAME]);
    if (!cookiePresent) {
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice('Bearer '.length) : undefined;
      if (bearer) {
        try {
          const payload = this.accessTokenService.verify(bearer) as { exp?: number };
          if (typeof payload.exp === 'number') jwtExpiresAtMs = payload.exp * 1000;
        } catch {
          // The guard already verified this exact token successfully for this same request — a
          // failure here would be a genuine anomaly, not a real race. Fail closed: no expiry
          // tracked means the next heartbeat's OTHER checks (vector, session liveness) are all
          // that protect this connection, so treat it as already expired instead of unbounded.
          jwtExpiresAtMs = 0;
        }
      }
    }

    return new Observable<MessageEvent>((subscriber) => {
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let channelHandler: ((envelope: RealtimeEventEnvelope) => void) | undefined;
      let closed = false;
      const seenEventIds: string[] = [];
      const seenEventIdSet = new Set<string>();

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (channelHandler) {
          const channel = realtimeUserChannel(this.env.get('NODE_ENV'), ctx.userId);
          this.gatewaySubscriber.subscriber.unsubscribe(channel, channelHandler).catch((error) => {
            this.logger.warn(`failed to unsubscribe connection ${connectionId} from ${channel}: ${(error as Error).message}`);
          });
        }
        this.registry.unregister(connectionId);
      };

      const maxPerUser = this.env.get('REALTIME_MAX_CONNECTIONS_PER_USER');
      if (this.registry.countForUser(ctx.userId) >= maxPerUser) {
        this.logger.warn(`connection refused for user ${ctx.userId}: already at REALTIME_MAX_CONNECTIONS_PER_USER (${maxPerUser})`);
        subscriber.complete();
        return teardown;
      }

      void (async () => {
        const initialVector = await this.readSecurityVector(ctx);
        if (closed) return; // the client disconnected while this async setup was still in flight

        this.registry.register({
          connectionId,
          userId: ctx.userId,
          organisationId: ctx.organisationId!,
          workspaceId: ctx.workspaceId,
          sessionId: ctx.sessionId!,
          transport: 'sse',
          connectedAt: new Date(),
          lastHeartbeatAt: new Date(),
          securityVector: initialVector,
        });

        const channel = realtimeUserChannel(this.env.get('NODE_ENV'), ctx.userId);
        channelHandler = (envelope: RealtimeEventEnvelope) => {
          if (!this.envelopeMatchesConnection(envelope, ctx)) {
            this.logger.warn(`dropped event ${envelope.eventId} on connection ${connectionId}: scope mismatch (never trust the channel name alone)`);
            return;
          }
          if (seenEventIdSet.has(envelope.eventId)) return; // at-least-once duplicate — already delivered to this connection
          seenEventIdSet.add(envelope.eventId);
          seenEventIds.push(envelope.eventId);
          if (seenEventIds.length > DEDUP_WINDOW_SIZE) seenEventIdSet.delete(seenEventIds.shift()!);
          subscriber.next({ data: envelope, id: envelope.eventId, type: envelope.type });
        };
        await this.gatewaySubscriber.subscriber.subscribe(channel, channelHandler);

        const heartbeatMs = this.env.get('REALTIME_HEARTBEAT_INTERVAL_MS');
        heartbeatTimer = setInterval(() => {
          void (async () => {
            if (jwtExpiresAtMs !== undefined && Date.now() >= jwtExpiresAtMs) {
              this.logger.log(`closing connection ${connectionId} for user ${ctx.userId}: mobile access token has expired`);
              subscriber.complete();
              return;
            }

            // Read-only — never bumps idle_expires_at/last_seen_at (see assertActiveReadOnly's own
            // doc comment). Catches silent idle/absolute-deadline expiry a version check can't see.
            try {
              await this.tenantContext.runInTenantContext({ organisationId: ctx.organisationId, workspaceId: ctx.workspaceId, userId: ctx.userId, role: '' }, (manager) =>
                this.sessionValidity.assertActiveReadOnly(manager, { sid: ctx.sessionId!, userId: ctx.userId, organisationId: ctx.organisationId }),
              );
            } catch {
              if (closed) return;
              this.logger.log(`closing connection ${connectionId} for user ${ctx.userId}: session is no longer active (idle/absolute expiry or revocation)`);
              subscriber.complete();
              return;
            }

            const current = await this.readSecurityVector(ctx);
            if (closed) return;
            if (!vectorsEqual(initialVector, current)) {
              this.logger.log(`closing connection ${connectionId} for user ${ctx.userId}: security vector changed since connect/last heartbeat`);
              subscriber.complete();
              return;
            }
            this.registry.touchHeartbeat(connectionId, current);
          })().catch((error) => {
            this.logger.error(`heartbeat failed for connection ${connectionId}, closing fail-closed: ${(error as Error).message}`, error as Error);
            if (!closed) subscriber.complete();
          });
        }, heartbeatMs);
      })().catch((error) => {
        this.logger.error(`connection setup failed for ${connectionId}, closing: ${(error as Error).message}`, error as Error);
        if (!closed) subscriber.complete();
      });

      return teardown;
    });
  }

  private async readSecurityVector(ctx: AuthenticatedRequest['authContext']): Promise<SecurityVersionVector> {
    return this.tenantContext.runInTenantContext({ organisationId: ctx.organisationId, workspaceId: ctx.workspaceId, userId: ctx.userId, role: '' }, (manager) =>
      this.securityVersion.readVector(manager, { sessionId: ctx.sessionId!, userId: ctx.userId, organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId }),
    );
  }

  /** Defense in depth — the channel is already user-specific, but an event's own scope is re-checked against the bound connection identity anyway, never assumed from the channel name alone (requirement 3.6/3.7). */
  private envelopeMatchesConnection(envelope: RealtimeEventEnvelope, ctx: AuthenticatedRequest['authContext']): boolean {
    if (envelope.organisationId !== ctx.organisationId) return false;
    if (envelope.targetUserId && envelope.targetUserId !== ctx.userId) return false;
    if (envelope.workspaceId && envelope.workspaceId !== ctx.workspaceId) return false;
    return true;
  }
}

function vectorsEqual(a: SecurityVersionVector, b: SecurityVersionVector): boolean {
  return (
    a.sessionVersion === b.sessionVersion &&
    a.userVersion === b.userVersion &&
    a.rolePermissionVersion === b.rolePermissionVersion &&
    a.workspaceMembershipVersion === b.workspaceMembershipVersion &&
    a.platformAdminVersion === b.platformAdminVersion &&
    a.organisationVersion === b.organisationVersion
  );
}

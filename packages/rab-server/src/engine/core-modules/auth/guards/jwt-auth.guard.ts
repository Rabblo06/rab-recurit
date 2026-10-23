import { Reflector } from '@nestjs/core';
import { MANAGER_APPLICATION } from './manager-application.decorator';
import { MOBILE_APPLICATION, MobileApplicationTarget } from './mobile-application.decorator';
import { ApplicationTarget, applicationAllowed, applicationDenied, APPLICATION_TARGETS, memberWithoutWorkspace } from '../application-access';
import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Request } from 'express';

import { AdminInspectService } from '../../platform-admin/admin-inspect.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { EnvironmentService } from '../../environment/environment.service';
import { WorkspaceResolverService } from '../../tenant/workspace-resolver.service';
import { AccessTokenService } from '../token/services/access-token.service';
import { AuthSecuritySnapshotService } from '../services/auth-security-snapshot.service';
import { isWellFormedWebSessionToken } from '../constants/web-session-cookie.constants';
import { authCookieModeFromEnv, authCookieName, countCookieOccurrences } from '../constants/auth-cookie-policy';
import { assertTrustedOriginForCookieRequest, isUnsafeMethod } from './cookie-csrf.util';
import { ActiveAccountGuard } from './active-account.guard';
import { MaintenanceModeGuard } from './maintenance-mode.guard';
import { MustResetPasswordGuard } from './must-reset-password.guard';
import { OrganisationSuspendedGuard } from './organisation-suspended.guard';
import { UserSessionCacheService } from '../services/user-session-cache.service';
import { timeStage } from '../../../observability/request-context';

const INSPECT_SESSION_HEADER = 'x-inspect-session-id';
/** CF-20: set by clients on automatic background requests (polling); such requests never extend the idle window. */
export const BACKGROUND_REQUEST_HEADER = 'x-crewflow-background';
// Ending inspection using the inspected identity would be nonsensical —
// this path prefix always runs as the admin's own real identity, header or not.
const INSPECT_ROUTE_PREFIX = '/rest/v1/admin/inspect';

/**
 * P1C.1C — a non-secret, client-asserted consistency fence, never a credential (never trusted
 * on its own, never capable of granting or substituting for authorization). Cookies are
 * browser-ambient: unlike a Bearer header (snapshotted into the request object before it's sent,
 * immune to a LATER cross-tab identity change), the `crewflow_session` cookie a browser actually
 * transmits is whichever value is current in the cookie jar AT TRANSMISSION TIME — which can
 * differ from what the UI believed was active when the user clicked "Save", if another tab's
 * login/logout changed the ambient identity in between. The frontend attaches the session id it
 * captured in the SAME identity snapshot `shouldAcceptResponse`/`shouldReplayAfterRefresh`
 * already use; this guard rejects outright (never silently proceeds under whichever identity the
 * cookie happens to resolve to) when a caller-asserted expectation disagrees with what the cookie
 * ACTUALLY resolved to. Absent header = no assertion made = nothing to fence (the very first
 * bootstrap call on a fresh tab has no prior session id to assert).
 */
const EXPECTED_SESSION_HEADER = 'x-crewflow-expected-session-id';

export interface AuthenticatedRequest extends Request {
  authContext: AuthContext;
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
}

function hashWebSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface ResolvedCredential {
  sid: string;
  sub: string;
  org: string;
  applicationTarget: ApplicationTarget | undefined;
  /** Cookie requests only: sha256 of the presented web-session credential, bound to the session row by assertActive (F-06). */
  webSessionTokenHash?: string;
}

/**
 * Layer 1 of the guard chain (rab-workforce-architecture.md §5.2). Attaches
 * `request.authContext`, consumed by `PermissionGuard` and every controller/service downstream —
 * never re-derived from anywhere else.
 *
 * P1C.1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9): TWO credential transports now converge here,
 * never two authorization pipelines — both resolve to the same `{sid, sub, org}` triple and feed
 * the SAME, unmodified `AuthSecuritySnapshotService.build()`:
 *   - `crewflow_session` HttpOnly cookie (manager_web's PRIMARY credential as of this checkpoint):
 *     SHA-256(cookie) looked up against `core.user_session.web_session_token_hash` via the new
 *     pre-auth `core.auth_find_session_by_web_token_hash` function.
 *   - `Authorization: Bearer <JWT>` (unchanged, mobile's ONLY credential, and web's fallback for
 *     any request that genuinely carries no cookie — e.g. a still-open tab from before this
 *     checkpoint shipped, until its next login).
 *
 * Credential precedence (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9's own explicit policy, audited
 * against every combination named in the P1C.1C brief §5): a PRESENT cookie is authoritative —
 * any `Authorization` header on that same request is ignored entirely, never consulted, never a
 * fallback if the cookie turns out invalid (a present-but-invalid cookie is a hard 401; it never
 * silently degrades to whatever Bearer credential happens to also be attached). No cookie at all
 * falls back to the existing Bearer path, byte-for-byte unchanged. A raw `crewflow_sess_`-prefixed
 * token is NEVER accepted as a Bearer value, independent of cookie presence — checked first,
 * before either branch runs.
 *
 * Also runs `MustResetPasswordGuard` and `MaintenanceModeGuard` right after
 * attaching the context, rather than registering either as a separate
 * global (`APP_GUARD`) guard — Nest always runs global guards before any
 * controller-level `@UseGuards` ones, so a standalone global guard would
 * run before this one ever sets `request.authContext` and would have
 * nothing to check. Delegating from here is what makes them actually run
 * in the right place, on every route this guard already protects.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly activeAccountGuard: ActiveAccountGuard,
    private readonly mustResetPasswordGuard: MustResetPasswordGuard,
    private readonly maintenanceModeGuard: MaintenanceModeGuard,
    private readonly organisationSuspendedGuard: OrganisationSuspendedGuard,
    private readonly adminInspectService: AdminInspectService,
    private readonly workspaceResolver: WorkspaceResolverService,
    private readonly securitySnapshot: AuthSecuritySnapshotService,
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
    private readonly env: EnvironmentService,
    private readonly userSessionCache: UserSessionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    let resolved: Awaited<ReturnType<JwtAuthGuard['resolveCredential']>>;
    try {
      resolved = await timeStage('credential_resolve', () => this.resolveCredential(request));
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw authUnavailable(error);
    }

    // P1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program): ONE consolidated, request-local
    // PostgreSQL security snapshot — see `AuthSecuritySnapshotService`'s own doc comment for the
    // full design, the authorization linearization point, and exactly what's reused unchanged
    // (`core.resolve_membership_for_session`, `SessionValidityService.assertActive`). `sub`/`org`
    // are LOOKUP INPUTS only (P1C §7) — compared against the resolved row inside the snapshot
    // service, never substituted for it; a mismatch (or an unresolvable session) returns `null`,
    // fail-closed, exactly as before. This is identical for both credential transports: the
    // cookie path's `sub`/`org` come from `core.user_session`'s own columns (immutable since
    // creation, P1C.1B), the JWT path's from the signed claims — either way, PostgreSQL remains
    // the sole authority for everything past this point.
    let security: Awaited<ReturnType<AuthSecuritySnapshotService['build']>>;
    try {
      security = await timeStage('security_snapshot', () =>
        this.securitySnapshot.build({ sid: resolved.sid, sub: resolved.sub, org: resolved.org, webSessionTokenHash: resolved.webSessionTokenHash ?? null, background: request.headers[BACKGROUND_REQUEST_HEADER] === '1' }),
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      // Still fail-closed (the request is refused), but as 503, not 401: an infrastructure failure (database blip,
      // deploy) must not be indistinguishable from "your session ended" — clients log out only on 401 (audit F5).
      throw authUnavailable(error);
    }
    if (!security) {
      throw new UnauthorizedException('Please sign in again.');
    }
    request.authContext = {
      userId: security.userId,
      organisationId: security.organisationId,
      workspaceId: security.workspaceId,
      role: security.roles.join(','),
      sessionId: resolved.sid,
      applicationTarget: resolved.applicationTarget,
      security,
    };

    const target = request.authContext.applicationTarget;
    if (!target || !APPLICATION_TARGETS.includes(target)) throw new UnauthorizedException('Please sign in again.');
    if (this.reflector.getAllAndOverride<boolean>(MANAGER_APPLICATION, [context.getHandler(), context.getClass()]) && target !== 'manager_web') throw applicationDenied('manager_web');
    // CF-08 (owner decision, option C): mobile-target credentials are default-denied. Only routes that explicitly allow
    // this mobile target (@MobileApplication) accept them, whatever other roles the identity holds.
    if (target !== 'manager_web') {
      const allowed = this.reflector.getAllAndOverride<MobileApplicationTarget[] | undefined>(MOBILE_APPLICATION, [context.getHandler(), context.getClass()]);
      if (!allowed?.includes(target)) throw mobileRouteDenied();
    }
    const expected = request.headers['x-application-target'];
    if (expected && expected !== target) throw applicationDenied(APPLICATION_TARGETS.includes(expected as ApplicationTarget) ? expected as ApplicationTarget : target);
    if (!applicationAllowed(security.roles, target, security.isPlatformAdmin) || memberWithoutWorkspace(security.roles, request.authContext.workspaceId, security.isPlatformAdmin)) {
      // A deleted/suspended/deactivated account has no (or revoked) roles, so its still-valid token would otherwise read
      // as "not allowed in this app" (403). Let the account-status check speak first: the session has ENDED (401), which
      // is what every client must handle by signing out. An active account outside its app still gets the 403.
      await this.activeAccountGuard.canActivate(context);
      throw applicationDenied(target);
    }
    await this.applyInspectHeader(request);

    await timeStage('active_account', () => this.activeAccountGuard.canActivate(context));
    await timeStage('organisation_suspended', () => this.organisationSuspendedGuard.canActivate(context));
    await timeStage('must_reset_password', () => this.mustResetPasswordGuard.canActivate(context));
    return timeStage('maintenance_mode', () => this.maintenanceModeGuard.canActivate(context));
  }

  /**
   * Resolves to the `{sid, sub, org, applicationTarget}` lookup inputs the security snapshot
   * needs, from whichever credential transport the request actually carries — see this class's
   * own doc comment for the full precedence policy. Throws `UnauthorizedException` for every
   * failure mode; never distinguishes "no credential" from "invalid credential" from "credential
   * confusion" in the response (the body/status is identical either way — only internal control
   * flow differs).
   */
  private async resolveCredential(request: AuthenticatedRequest): Promise<ResolvedCredential> {
    // Wave 2 lane A2: `crewflow_session` (legacy mode) or `__Host-crewflow_session` (AUTH_COOKIE_HOST_PREFIX_ENABLED).
    // In host mode the legacy name is never read here — it is not a credential; only `/auth/refresh` may migrate it.
    const sessionCookieName = authCookieName('session', authCookieModeFromEnv(this.env));
    const cookieToken = request.cookies?.[sessionCookieName] as string | undefined;
    const bearerToken = extractBearerToken(request);

    // CF-14 (cookie tossing): two session cookies of the same name means a second one was planted (for example by a
    // sibling subdomain with a Domain attribute). The cookie parser silently keeps the first; refuse the request instead.
    if (countCookieOccurrences(request.headers.cookie, sessionCookieName) > 1) {
      throw new UnauthorizedException({ code: 'DUPLICATE_SESSION_COOKIE', message: 'Please sign in again.' });
    }

    // Never accept a web session credential presented as a Bearer token — checked before either
    // branch, independent of cookie presence (P1C.1C brief §5: "A raw crewflow_session token must
    // never be accepted as Authorization: Bearer").
    if (bearerToken && isWellFormedWebSessionToken(bearerToken)) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (cookieToken !== undefined) {
      // A PRESENT cookie is authoritative — any Authorization header on this same request is
      // ignored entirely from here on, never consulted as a fallback, even if this cookie turns
      // out to be invalid below (P1C.1C brief §5: "Do not silently fall back from a rejected
      // browser cookie to a different user's Bearer credential").
      if (!isWellFormedWebSessionToken(cookieToken)) {
        throw new UnauthorizedException('Invalid session.');
      }
      const hash = hashWebSessionToken(cookieToken);

      // Redis checkpoint — Twenty-style UserSession cache. A HIT here only shortcuts THIS identity
      // lookup; it can never substitute for `SessionValidityService.assertActive()`, which still
      // runs unconditionally below regardless of hit or miss — see `UserSessionCacheService`'s own
      // doc comment for why a hit can never let a revoked/idle-expired session through.
      let row = await timeStage('user_session_cache_get', () => this.userSessionCache.get(hash));
      if (!row) {
        const [dbRow] = await this.dataSource.query<
          Array<{ sessionId: string; userId: string; organisationId: string; applicationTarget: string; absoluteExpiresAt: string }>
        >('SELECT * FROM core.auth_find_session_by_web_token_hash($1)', [hash]);
        if (!dbRow) {
          throw new UnauthorizedException('Invalid session.');
        }
        row = dbRow;
        await timeStage('user_session_cache_set', () => this.userSessionCache.set(hash, dbRow));
      }

      // CSRF (P1C.1C brief §10): every unsafe (state-changing) cookie-authenticated request —
      // not only `/auth/refresh` any more, since the cookie is now the PRIMARY credential for
      // every ordinary route. Safe (GET/HEAD/OPTIONS) requests need no Origin check; a forged
      // cross-site GET can still only ever read data as the victim, never mutate it, and every
      // genuinely sensitive GET already has its own response-level protections unrelated to CSRF.
      if (isUnsafeMethod(request.method)) {
        assertTrustedOriginForCookieRequest(request, (origin) => this.env.isTrustedOrigin(origin));
      }

      // Fencing (P1C.1C brief §7) — a non-secret, client-asserted consistency check only, never
      // authority. See EXPECTED_SESSION_HEADER's own doc comment.
      const expectedSessionId = request.headers[EXPECTED_SESSION_HEADER];
      if (typeof expectedSessionId === 'string' && expectedSessionId.length > 0 && expectedSessionId !== row.sessionId) {
        throw new UnauthorizedException('Session identity mismatch.');
      }

      // F-06: the presented credential's hash travels with the lookup result, so the authoritative session check can bind it.
      return { sid: row.sessionId, sub: row.userId, org: row.organisationId, applicationTarget: row.applicationTarget as ApplicationTarget, webSessionTokenHash: hash };
    }

    if (!bearerToken) {
      throw new UnauthorizedException('Missing credentials');
    }

    let payload: ReturnType<AccessTokenService['verify']>;
    try {
      payload = await timeStage('jwt_verify', async () => this.accessTokenService.verify(bearerToken));
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    return { sid: payload.sid, sub: payload.sub, org: payload.org, applicationTarget: payload.applicationTarget };
  }

  /**
   * Rebuilds `request.authContext` to the inspected target's identity when
   * a live session is proven to belong to the CALLING admin's own
   * already-verified token — the header is only ever a lookup key, never
   * trusted on its own. Any invalid/foreign/ended/expired session id is silently
   * ignored (fail-closed to the admin's real identity), never an error, so
   * a stale or forged header can't even be used to distinguish "session
   * exists" from "session doesn't" via response codes.
   *
   * CF-02 (October 15 audit), enforced here for EVERY route, not only PermissionGuard routes:
   *   - read-only: any state-changing request carrying the header is refused (403) before any handler runs, whether or
   *     not the header resolves (one uniform answer, no oracle). Only the inspect start/end routes are exempt; they act
   *     as the admin. Tenant transactions under an inspected identity are additionally READ ONLY in PostgreSQL
   *     (TenantContextService), so a write that slipped past any guard still fails in the database;
   *   - current authority: the header is honoured only while the caller IS a platform admin right now, according to
   *     the per-request security snapshot (re-derived from PostgreSQL, integrity-protected when cached). A demoted
   *     admin's open inspect row stops working on their next request;
   *   - expiry: `resolveActiveTarget` honours a row for ADMIN_INSPECT_TTL_MINUTES after it started (owner decision:
   *     30 minutes). A new inspect must be started (and is audited) after that.
   */
  private async applyInspectHeader(request: AuthenticatedRequest): Promise<void> {
    if (request.path.startsWith(INSPECT_ROUTE_PREFIX)) return;

    const sessionId = request.headers[INSPECT_SESSION_HEADER];
    if (sessionId === undefined) return;

    const adminCtx = request.authContext;
    if (isUnsafeMethod(request.method)) {
      await this.adminInspectService.recordRefusedMutation(adminCtx, request.method, request.path).catch(() => undefined);
      throw new ForbiddenException({ code: 'INSPECT_READ_ONLY', message: 'Admin Inspect is read-only. End the inspect session to make changes.' });
    }
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (adminCtx.security?.isPlatformAdmin !== true) return;

    const target = await this.adminInspectService.resolveActiveTarget(adminCtx, sessionId);
    if (!target) return;

    request.authContext = {
      ...adminCtx,
      userId: target.targetUserId,
      // Re-resolved for the TARGET, not inherited from the admin — reads
      // must scope to the inspected user's own workspace, never the
      // admin's (which may not even exist, per §7's platform-admin
      // redesign — Admin is no longer a Workspace owner by construction).
      workspaceId: await this.workspaceResolver.resolveForUser(target.targetUserId),
      role: '',
      inspectedBy: adminCtx.userId,
    };
  }
}

/** Moved to auth-cookie-policy.ts (wave 2 lane A2); re-exported for existing importers. */
export { countCookieOccurrences };

/** CF-08: a mobile-target credential on a route that is not explicitly available to that mobile app. */
function mobileRouteDenied(): ForbiddenException {
  return new ForbiddenException({ code: 'APPLICATION_ROUTE_DENIED', message: 'This action is not available in this app.' });
}

/** 503 for an authentication check that could not be completed (never an allow; never a 401 "session ended"). */
function authUnavailable(error: unknown): ServiceUnavailableException {
  // eslint-disable-next-line no-console
  console.error('Authentication check failed unexpectedly (request refused with 503, fail-closed):', error);
  return new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: 'Sign-in could not be checked right now. Try again in a moment.' });
}

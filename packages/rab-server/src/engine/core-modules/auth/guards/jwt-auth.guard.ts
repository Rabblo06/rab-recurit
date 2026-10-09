import { Reflector } from '@nestjs/core';
import { MANAGER_APPLICATION } from './manager-application.decorator';
import { ApplicationTarget, applicationAllowed, applicationDenied, APPLICATION_TARGETS } from '../application-access';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Request } from 'express';

import { AdminInspectService } from '../../platform-admin/admin-inspect.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { EnvironmentService } from '../../environment/environment.service';
import { WorkspaceResolverService } from '../../tenant/workspace-resolver.service';
import { AccessTokenService } from '../token/services/access-token.service';
import { AuthSecuritySnapshotService } from '../services/auth-security-snapshot.service';
import { isWellFormedWebSessionToken, WEB_SESSION_COOKIE_NAME } from '../constants/web-session-cookie.constants';
import { assertTrustedOriginForCookieRequest, isUnsafeMethod } from './cookie-csrf.util';
import { ActiveAccountGuard } from './active-account.guard';
import { MaintenanceModeGuard } from './maintenance-mode.guard';
import { MustResetPasswordGuard } from './must-reset-password.guard';
import { timeStage } from '../../../observability/request-context';

const INSPECT_SESSION_HEADER = 'x-inspect-session-id';
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
    private readonly adminInspectService: AdminInspectService,
    private readonly workspaceResolver: WorkspaceResolverService,
    private readonly securitySnapshot: AuthSecuritySnapshotService,
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
    private readonly env: EnvironmentService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const resolved = await timeStage('credential_resolve', () => this.resolveCredential(request));

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
        this.securitySnapshot.build({ sid: resolved.sid, sub: resolved.sub, org: resolved.org }),
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      // eslint-disable-next-line no-console
      console.error('Security snapshot failed unexpectedly (treated as not-active, fail-closed):', error);
      throw new UnauthorizedException('Please sign in again.');
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
    const expected = request.headers['x-application-target'];
    if (expected && expected !== target) throw applicationDenied(APPLICATION_TARGETS.includes(expected as ApplicationTarget) ? expected as ApplicationTarget : target);
    if (!applicationAllowed(security.roles, target, security.isPlatformAdmin)) {
      // A deleted/suspended/deactivated account has no (or revoked) roles, so its still-valid token would otherwise read
      // as "not allowed in this app" (403). Let the account-status check speak first: the session has ENDED (401), which
      // is what every client must handle by signing out. An active account outside its app still gets the 403.
      await this.activeAccountGuard.canActivate(context);
      throw applicationDenied(target);
    }
    await this.applyInspectHeader(request);

    await timeStage('active_account', () => this.activeAccountGuard.canActivate(context));
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
    const cookieToken = request.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined;
    const bearerToken = extractBearerToken(request);

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
      const [row] = await this.dataSource.query<Array<{ sessionId: string; userId: string; organisationId: string; applicationTarget: string }>>(
        'SELECT * FROM core.auth_find_session_by_web_token_hash($1)',
        [hash],
      );
      if (!row) {
        throw new UnauthorizedException('Invalid session.');
      }

      // CSRF (P1C.1C brief §10): every unsafe (state-changing) cookie-authenticated request —
      // not only `/auth/refresh` any more, since the cookie is now the PRIMARY credential for
      // every ordinary route. Safe (GET/HEAD/OPTIONS) requests need no Origin check; a forged
      // cross-site GET can still only ever read data as the victim, never mutate it, and every
      // genuinely sensitive GET already has its own response-level protections unrelated to CSRF.
      if (isUnsafeMethod(request.method)) {
        assertTrustedOriginForCookieRequest(request, this.env.corsOrigins);
      }

      // Fencing (P1C.1C brief §7) — a non-secret, client-asserted consistency check only, never
      // authority. See EXPECTED_SESSION_HEADER's own doc comment.
      const expectedSessionId = request.headers[EXPECTED_SESSION_HEADER];
      if (typeof expectedSessionId === 'string' && expectedSessionId.length > 0 && expectedSessionId !== row.sessionId) {
        throw new UnauthorizedException('Session identity mismatch.');
      }

      return { sid: row.sessionId, sub: row.userId, org: row.organisationId, applicationTarget: row.applicationTarget as ApplicationTarget };
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
   * trusted on its own. Any invalid/foreign/ended session id is silently
   * ignored (fail-closed to the admin's real identity), never an error, so
   * a stale or forged header can't even be used to distinguish "session
   * exists" from "session doesn't" via response codes.
   */
  private async applyInspectHeader(request: AuthenticatedRequest): Promise<void> {
    if (request.path.startsWith(INSPECT_ROUTE_PREFIX)) return;

    const sessionId = request.headers[INSPECT_SESSION_HEADER];
    if (typeof sessionId !== 'string' || !sessionId) return;

    const adminCtx = request.authContext;
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

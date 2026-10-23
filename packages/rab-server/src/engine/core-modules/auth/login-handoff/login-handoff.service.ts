import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { WorkspaceHostResolverService } from '../../workspace-host/workspace-host-resolver.service';
import { WorkspaceHostContext } from '../../workspace-host/workspace-host.types';
import { AuthService, LoginResult, RequestMeta } from '../services/auth.service';
import { RefreshTokenService } from '../token/services/refresh-token.service';

const TOKEN_PREFIX = 'lho_';
/** Uniform refusal for every exchange failure (unknown, used, expired, wrong host, revoked source, changed account). */
const HANDOFF_INVALID = { code: 'LOGIN_HANDOFF_INVALID', message: 'This sign-in link has expired. Please sign in again.' } as const;

interface ConsumedHandoff {
  organisation_id: string;
  user_id: string;
  workspace_id: string;
  application_target: string;
  auth_provider: 'password' | 'google' | 'microsoft';
  source_session_id: string;
}

/**
 * Wave 4 lane MFA × wave 3 lane H — cross-host LOGIN HANDOFF.
 *
 *   default host (APP_URL, e.g. 127.0.0.1:5173)            the user's workspace host (<label>.<base>)
 *   ────────────────────────────────────────────            ───────────────────────────────────────────
 *   sign-in (password / OAuth, MFA already passed)
 *   → host-only session S on the default host
 *   POST /auth/login-handoff  (session S, trusted Origin)
 *     • target = S's OWN workspace (no workspace parameter, no picker)
 *     • canonical origin from the registry-confirmed DB label + env (lane H resolver), never from the request
 *     • 256-bit token, only its SHA-256 stored (core.login_handoff_create, TTL ≤ 60 s, ≤ 5 live per user)
 *   ← { redirectUrl: <canonical origin>/auth/handoff#t=<token> }    (token in the FRAGMENT: never sent to a server,
 *                                                                   never in a Referer, never in an access log)
 *                                                            landing page strips the fragment at once (replaceState)
 *                                                            POST /auth/login-handoff/exchange {token} (JSON, trusted Origin)
 *                                                              • audience = THIS request's registry-resolved host label
 *                                                                (Host / trusted X-Forwarded-Host / Origin — never the body)
 *                                                              • core.login_handoff_consume burns it (single use, even on
 *                                                                failure), checks label, workspace READY/routable, org not
 *                                                                suspended, user active + unchanged security version, S live
 *                                                              • NEW session (fresh id + credential: no fixation); any
 *                                                                session cookie this host presented is superseded; S revoked
 *                                                            ← host-only __Host-/legacy cookies per A2's policy
 *
 * Users without a routable workspace (platform administrators, members mid-onboarding) simply stay on the default host.
 * Only `manager_web` sessions are ever handed off; the mobile apps never are.
 */
@Injectable()
export class LoginHandoffService {
  private readonly logger = new Logger(LoginHandoffService.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly hosts: WorkspaceHostResolverService,
    private readonly authService: AuthService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly audit: AuditService,
  ) {}

  get enabled(): boolean {
    return this.env.get('AUTH_LOGIN_HANDOFF_ENABLED') === true && this.hosts.isRoutingEnabled();
  }

  static isWellFormedToken(token: unknown): token is string {
    return typeof token === 'string' && token.length === TOKEN_PREFIX.length + 43 && token.startsWith(TOKEN_PREFIX) && /^[A-Za-z0-9_-]+$/.test(token.slice(TOKEN_PREFIX.length));
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Source side. Returns `{ redirectUrl: null }` whenever the user should simply stay where they are (feature off, no
   * routable workspace, already on their own workspace host, Admin Inspect, not a web session) — never an error, so the
   * front can call it after every sign-in.
   */
  async create(ctx: AuthContext, requestHost: WorkspaceHostContext | undefined): Promise<{ redirectUrl: string | null; expiresAt: string | null }> {
    const stay = { redirectUrl: null, expiresAt: null };
    if (!this.enabled || ctx.inspectedBy || !ctx.sessionId || !ctx.workspaceId || ctx.applicationTarget !== 'manager_web') return stay;
    if (requestHost?.kind === 'workspace' && requestHost.workspaceId === ctx.workspaceId) return stay;
    const canonicalOrigin = await this.hosts.canonicalOriginForWorkspace(ctx);
    if (!canonicalOrigin) return stay;

    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const ttl = this.env.get('AUTH_LOGIN_HANDOFF_TTL_SECONDS');
    let created: { audience_label: string; expires_at: Date } | undefined;
    try {
      created = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const rows = await manager.query<Array<{ handoff_id: string; audience_label: string; expires_at: Date }>>(
          'SELECT * FROM core.login_handoff_create($1::uuid, $2::text, $3::integer)',
          [ctx.sessionId, this.hash(token), ttl],
        );
        const row = rows[0];
        if (!row) return undefined;
        // The DB's audience must be exactly the workspace the registry-confirmed canonical origin names.
        if (this.hosts.canonicalOriginFor(row.audience_label) !== canonicalOrigin) throw new Error('login handoff audience does not match the canonical workspace origin');
        await this.audit.record(manager, ctx, AuditAction.LOGIN_HANDOFF_CREATED, { targetUserId: ctx.userId, metadata: { expiresInSeconds: ttl } });
        return row;
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'CWH01') {
        throw new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'LOGIN_HANDOFF_RATE_LIMITED', message: 'Please wait a moment and try again.', retryAfter: 60 }, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw error;
    }
    if (!created) return stay;
    return { redirectUrl: `${canonicalOrigin}/auth/handoff#t=${token}`, expiresAt: new Date(created.expires_at).toISOString() };
  }

  /** Target side. Burns the handoff and issues a brand-new host-only session for THIS workspace host. */
  async exchange(token: unknown, requestHost: WorkspaceHostContext | undefined, meta: RequestMeta): Promise<LoginResult> {
    if (!this.enabled) throw new UnauthorizedException(HANDOFF_INVALID);
    // Audience comes ONLY from the request's own, registry-resolved workspace host — never from the body.
    if (requestHost?.kind !== 'workspace' || !LoginHandoffService.isWellFormedToken(token)) throw new UnauthorizedException(HANDOFF_INVALID);
    const [row] = await this.dataSource.query<ConsumedHandoff[]>('SELECT * FROM core.login_handoff_consume($1::text, $2::text)', [this.hash(token), requestHost.canonicalLabel]);
    if (!row || row.workspace_id !== requestHost.workspaceId || row.application_target !== 'manager_web') {
      this.logger.warn(`login_handoff_exchange_refused host_kind=${requestHost.kind}`);
      throw new UnauthorizedException(HANDOFF_INVALID);
    }
    const result = await this.authService.issueHandedOffSession(
      { organisationId: row.organisation_id, userId: row.user_id, workspaceId: row.workspace_id, authProvider: row.auth_provider },
      meta,
    );
    // The source-host session has done its job: end it so only the workspace-host session remains.
    const ctx: AuthContext = { organisationId: row.organisation_id, workspaceId: row.workspace_id, userId: row.user_id, role: '' };
    await this.tenantContext.runInTenantContext(ctx, (manager) => this.refreshTokens.revokeFamily(manager, row.source_session_id, 'login_handoff'));
    return result;
  }
}

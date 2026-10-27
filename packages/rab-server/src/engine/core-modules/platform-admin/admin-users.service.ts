import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { SecurityVersionService } from '../auth/services/security-version.service';
import { StepUpReauthService } from '../auth/services/step-up-reauth.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { assertActivePlatformAdmin, isUuid, mapAdminFunctionError, refuseInspection, requireReason } from './admin-actor';
import { ADMIN_PANEL_AUDIT_ACTION, recordAdminPanelAudit } from './admin-panel-audit-actions';
import {
  AdminOrganisationListItem,
  AdminOrganisationSummary,
  AdminPlatformAdminItem,
  AdminUserListItem,
  AdminUserSummary,
  toOrganisationListItem,
  toPlatformAdminItem,
  toUserListItem,
  toWorkspaceListItem,
  RawOrganisationRow,
  RawPlatformAdminRow,
  RawUserSearchRow,
  RawWorkspaceRow,
} from './admin-panel.mappers';
import { PlatformAdminService } from './platform-admin.service';

type Actor = Pick<AuthContext, 'userId' | 'organisationId' | 'workspaceId' | 'sessionId' | 'inspectedBy'>;

const APPLICATION_TARGETS = ['manager_web', 'venue_manager_app', 'staff_app'] as const;

/**
 * Crewflow Platform Admin Panel — users, platform admins and organisation lookup (General tab).
 *
 * Layers: `JwtAuthGuard + PlatformAdminGuard + @ManagerApplication()` on the controller (1); `assertActivePlatformAdmin`
 * at the top of EVERY method here (2); cross-organisation reads only through the admin-gated SECURITY DEFINER functions
 * (`core.admin_search_users`, `core.admin_list_platform_admins`, `core.list_organisations_for_admin`,
 * `core.admin_list_workspace_schemas`) or a READ ONLY transaction bound to the TARGET organisation (3/4, the
 * OrganisationSuspensionService pattern); the functions raise 42501 themselves for a non-admin (5). Every response is an
 * explicit allowlist mapping (`admin-panel.mappers.ts`).
 *
 * D10 (owner, 2026-10-24): searches are audited (`admin.user_searched` / `admin.organisation_searched`, in the ACTOR's
 * organisation) with the match kind, the result count and the result ids — never the raw query text.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpReauthService,
    private readonly securityVersion: SecurityVersionService,
  ) {}

  private actorTx<T>(actor: Actor, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return this.tenantContext.runInTenantContext({ organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' }, fn);
  }

  /** A READ ONLY transaction bound to the TARGET organisation, acting as the admin (never the target user). */
  private targetReadTx<T>(actor: Actor, organisationId: string, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return this.tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: actor.userId, role: '' }, async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      return fn(manager);
    });
  }

  private async searchRows(manager: EntityManager, q: string, limit: number, role: string | null = null): Promise<RawUserSearchRow[]> {
    try {
      return await manager.query<RawUserSearchRow[]>('SELECT * FROM core.admin_search_users($1, $2, $3)', [q, role, limit]);
    } catch (error) {
      return mapAdminFunctionError(error);
    }
  }

  // ------------------------------------------------------------------------------------------------ users

  /**
   * Empty query → the most recent users (Recent users / User security tables, not audited unless a role filter or text
   * is given). Otherwise ≤25 matches, audited. `role` = a system role key or `platform_admin` (validated by the DTO and
   * again by the SQL function).
   */
  async searchUsers(actor: Actor, query: string | undefined, role?: string, limit?: number): Promise<AdminUserListItem[]> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const q = (query ?? '').trim();
    if (q !== '' && (q.length < 3 || q.length > 200)) {
      throw new BadRequestException({ code: 'SEARCH_TOO_SHORT', message: 'Type at least 3 characters to search.' });
    }
    return this.actorTx(actor, async (manager) => {
      const rows = await this.searchRows(manager, q, Math.min(Math.max(limit ?? (q === '' ? 10 : 20), 1), 25), role ?? null);
      if (q !== '') {
        await recordAdminPanelAudit(this.audit, manager, actor, ADMIN_PANEL_AUDIT_ACTION.USER_SEARCHED, {
          targetUserId: rows.length === 1 ? rows[0]!.userId : undefined,
          metadata: { kind: matchKindOf(q), roleFilter: role ?? null, resultCount: rows.length, resultUserIds: rows.map((r) => r.userId) },
        });
      }
      return rows.map(toUserListItem);
    });
  }

  /**
   * One user's admin summary. Identity + 2FA state come from `admin_search_users` (by id); roles, live sessions and the
   * latest sign-in provider from a READ ONLY transaction bound to the user's own organisation; failed sign-ins (24 h)
   * from the existing `core.auth_count_recent_login_failures`. Audited as `admin.user_viewed`.
   */
  async userSummary(actor: Actor, userId: string): Promise<AdminUserSummary> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    if (!isUuid(userId)) throw new NotFoundException();
    const row = await this.actorTx(actor, async (manager) => {
      const [found] = await this.searchRows(manager, userId, 1);
      if (found) {
        await recordAdminPanelAudit(this.audit, manager, actor, ADMIN_PANEL_AUDIT_ACTION.USER_VIEWED, { targetUserId: found.userId });
      }
      return found ?? null;
    });
    if (!row) throw new NotFoundException();
    const detail = await this.targetReadTx(actor, row.organisationId, async (manager) => {
      const sessions = await manager.query<Array<{ application_target: string; n: string }>>(
        `SELECT application_target, count(*)::text AS n FROM core.user_session
          WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now() AND (idle_expires_at IS NULL OR idle_expires_at > now())
          GROUP BY application_target`,
        [row.userId],
      );
      const [latest] = await manager.query<Array<{ auth_provider: string | null; created_at: Date }>>(
        `SELECT auth_provider, created_at FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [row.userId],
      );
      const [failed] = await manager.query<Array<{ n: string }>>(
        `SELECT core.auth_count_recent_login_failures($1, now() - interval '24 hours')::text AS n`,
        [row.email],
      );
      return { sessions, latest, failed };
    });
    const sessionsByApp: Record<string, number> = {};
    for (const s of detail.sessions) {
      if ((APPLICATION_TARGETS as readonly string[]).includes(s.application_target)) sessionsByApp[s.application_target] = Number(s.n);
    }
    return {
      ...toUserListItem(row),
      sessions: {
        total: Object.values(sessionsByApp).reduce((a, b) => a + b, 0),
        managerWeb: sessionsByApp.manager_web ?? 0,
        venueManagerApp: sessionsByApp.venue_manager_app ?? 0,
        staffApp: sessionsByApp.staff_app ?? 0,
      },
      lastSignInProvider: providerLabel(detail.latest?.auth_provider ?? null),
      failedSignIns24h: Number(detail.failed?.n ?? 0),
    };
  }

  /**
   * "Sign out everywhere" — ends every session and refresh token the target holds, bumps their security version (cached
   * auth contexts miss on the next request) and records the action, with the reason, in BOTH the admin's organisation
   * and the target's. Requires a recent step-up of THIS session (`assertRecentStepUp`; the panel's dialog calls
   * `POST /auth/step-up` with the admin's password and, if enrolled, their code first). Never on oneself (use Settings →
   * Profile → Devices). One transaction: if any step fails nothing is revoked (fail closed).
   */
  async revokeSessions(actor: Actor, targetUserId: string, reasonInput: unknown): Promise<{ revokedSessions: number; revokedRefreshTokens: number }> {
    refuseInspection(actor);
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const reason = requireReason(reasonInput);
    if (!isUuid(targetUserId)) throw new NotFoundException();
    if (targetUserId === actor.userId) {
      throw new ConflictException({ code: 'SESSIONS_REVOKE_SELF', message: 'To sign yourself out of other devices, use Settings → Profile → Devices.' });
    }
    // Admin panel follow-up (P7): its own STEP_UP_ACTIONS name, recorded on the refusal audit row.
    await this.stepUp.assertRecentStepUp(actor, 'user.sessions.revoke');

    const outcome = await this.actorTx(actor, async (manager) => {
      const [membership] = await manager.query<Array<{ organisation_id: string }>>('SELECT organisation_id FROM core.resolve_membership_for_user($1)', [targetUserId]);
      await bind(manager, actor.organisationId, actor.userId); // the function may rebind; restore the actor's binding
      if (!membership) return null;
      const targetOrg = membership.organisation_id;
      let revokedSessions = 0;
      let revokedRefreshTokens = 0;
      await bind(manager, targetOrg, actor.userId);
      try {
        const [exists] = await manager.query<Array<{ id: string }>>('SELECT id FROM core."user" WHERE id = $1 AND deleted_at IS NULL', [targetUserId]);
        if (!exists) return null;
        const [, sessions] = await manager.query<[unknown[], number]>(
          `UPDATE core.user_session SET revoked_at = now(), revoked_reason = 'admin_signed_out_everywhere', security_version = security_version + 1
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [targetUserId],
        );
        const [, tokens] = await manager.query<[unknown[], number]>('UPDATE core.refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetUserId]);
        revokedSessions = sessions ?? 0;
        revokedRefreshTokens = tokens ?? 0;
        await this.securityVersion.bumpUser(manager, targetUserId);
        // The target organisation's own trail shows who did it and why (platform-admin actor: allowed cross-organisation).
        await recordAdminPanelAudit(this.audit, manager, { organisationId: targetOrg, userId: actor.userId }, ADMIN_PANEL_AUDIT_ACTION.SESSIONS_REVOKED, {
          targetUserId,
          metadata: { reason, revokedSessions, count: revokedSessions },
        });
      } finally {
        await bind(manager, actor.organisationId, actor.userId);
      }
      await recordAdminPanelAudit(this.audit, manager, actor, ADMIN_PANEL_AUDIT_ACTION.SESSIONS_REVOKED, {
        targetUserId,
        metadata: { reason, revokedSessions, count: revokedSessions, targetOrganisationId: targetOrg },
      });
      return { revokedSessions, revokedRefreshTokens };
    });
    if (!outcome) throw new NotFoundException();
    return outcome;
  }

  // ------------------------------------------------------------------------------------------------ platform admins

  async listPlatformAdmins(actor: Actor): Promise<AdminPlatformAdminItem[]> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const rows = await this.actorTx(actor, async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      try {
        return await manager.query<RawPlatformAdminRow[]>('SELECT * FROM core.admin_list_platform_admins()');
      } catch (error) {
        return mapAdminFunctionError(error);
      }
    });
    return rows.map((r) => toPlatformAdminItem(r, actor.userId));
  }

  // ------------------------------------------------------------------------------------------------ organisations

  async searchOrganisations(actor: Actor, query: string | undefined): Promise<AdminOrganisationListItem[]> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const q = (query ?? '').trim().toLowerCase();
    if (q !== '' && (q.length < 2 || q.length > 200)) {
      throw new BadRequestException({ code: 'SEARCH_TOO_SHORT', message: 'Type at least 2 characters to search.' });
    }
    return this.actorTx(actor, async (manager) => {
      const all = await manager.query<RawOrganisationRow[]>('SELECT * FROM core.list_organisations_for_admin()');
      const matched = q === ''
        ? all.slice(0, 10)
        : all
            .filter((o) => (isUuid(q) ? o.id === q : String(o.name).toLowerCase().includes(q) || String(o.slug).toLowerCase().includes(q)))
            .sort((a, b) => rank(a, q) - rank(b, q))
            .slice(0, 20);
      if (q !== '') {
        await recordAdminPanelAudit(this.audit, manager, actor, ADMIN_PANEL_AUDIT_ACTION.ORGANISATION_SEARCHED, {
          metadata: { kind: isUuid(q) ? 'id' : 'text', resultCount: matched.length, resultOrganisationIds: matched.map((o) => o.id) },
        });
      }
      return matched.map(toOrganisationListItem);
    });
  }

  /**
   * One organisation's admin summary: status + CEO (from `list_organisations_for_admin`), the CEO's 2FA state (from
   * `admin_search_users`), membership count (READ ONLY, bound to that organisation) and its workspaces' schema states
   * (`admin_list_workspace_schemas`). Counts only — never another organisation's member list or Initial Manager (owner
   * policy 2026-10-15).
   */
  async organisationSummary(actor: Actor, organisationId: string): Promise<AdminOrganisationSummary> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    if (!isUuid(organisationId)) throw new NotFoundException();
    const base = await this.actorTx(actor, async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      const orgs = await manager.query<RawOrganisationRow[]>('SELECT * FROM core.list_organisations_for_admin()');
      const org = orgs.find((o) => o.id === organisationId);
      if (!org) return null;
      let workspaces: RawWorkspaceRow[];
      let ceo: RawUserSearchRow | undefined;
      try {
        workspaces = await manager.query<RawWorkspaceRow[]>('SELECT * FROM core.admin_list_workspace_schemas(NULL, $1, NULL, NULL, 50)', [organisationId]);
        ceo = org.ceoUserId ? (await manager.query<RawUserSearchRow[]>('SELECT * FROM core.admin_search_users($1, NULL, 1)', [org.ceoUserId]))[0] : undefined;
      } catch (error) {
        return mapAdminFunctionError(error);
      }
      return { org, workspaces, ceo };
    });
    if (!base) throw new NotFoundException();
    const members = await this.targetReadTx(actor, organisationId, async (manager) => {
      const [row] = await manager.query<Array<{ n: string }>>(
        `SELECT count(*)::text AS n FROM core.organisation_member WHERE organisation_id = $1 AND status = 'active'`,
        [organisationId],
      );
      return Number(row?.n ?? 0);
    });
    const list = toOrganisationListItem(base.org);
    const ws = base.workspaces.map(toWorkspaceListItem);
    return {
      ...list,
      ceo: list.ceo ? { ...list.ceo, twoFactorEnabled: base.ceo ? base.ceo.totpEnabled === true : null } : null,
      members: { active: members },
      workspaces: {
        total: ws.length,
        ready: ws.filter((w) => w.schemaStatus === 'READY').length,
        creating: ws.filter((w) => w.schemaStatus === 'CREATING' || w.schemaStatus === 'MIGRATING').length,
        failed: ws.filter((w) => w.schemaStatus === 'FAILED').length,
      },
    };
  }
}

async function bind(manager: EntityManager, organisationId: string | null, userId: string): Promise<void> {
  await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [organisationId ?? '', userId]);
}

function matchKindOf(q: string): 'id' | 'email' | 'name' {
  if (isUuid(q)) return 'id';
  return String(q).includes('@') ? 'email' : 'name';
}

function rank(o: RawOrganisationRow, q: string): number {
  const slug = String(o.slug).toLowerCase();
  const name = String(o.name).toLowerCase();
  if (o.id === q || slug === q) return 0;
  if (slug.startsWith(q) || name.startsWith(q)) return 1;
  return 2;
}

function providerLabel(provider: string | null): 'password' | 'google' | 'microsoft' | null {
  return provider === 'password' || provider === 'google' || provider === 'microsoft' ? provider : null;
}

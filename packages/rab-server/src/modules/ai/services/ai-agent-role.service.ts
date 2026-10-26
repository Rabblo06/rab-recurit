import { randomBytes } from 'node:crypto';

import {
  AI_AGENT_ROLE_ALLOWLIST,
  AI_AGENT_ROLE_FLAGS_6A,
  AiAgentRoleFlag,
  AiAgentRoleFlagView,
  AiAgentRoleView,
  AiAgentWriteReason,
  CUSTOM_ROLE_KEY_PREFIX,
  PermissionFlagType,
} from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { SecurityVersionService } from '../../../engine/core-modules/auth/services/security-version.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { MemberRolePolicyService } from '../../identity/services/member-role-policy.service';
import { AiAgentInvalidException, AiAgentRoleFlagNotAllowedException } from '../exceptions/ai-agent.exceptions';
import { AiAgentAuthority } from './ai-agent-authority.service';
import { findAgent, lockCustomAgent, mapAgentWriteError, Scope, scopeOf } from './ai-agent-store';

export interface AiAgentRoleUpdateInput extends AiAgentWriteReason {
  flags: AiAgentRoleFlag[];
}

/** AiAgentRoleView with a nullable role id (an agent may have no role yet = no tools). Contract item for Agent 9. */
export type AiAgentRoleStorageView = Omit<AiAgentRoleView, 'roleId'> & { roleId: string | null };

/** Fixed server labels of the agent role editor (CD-11 `AiAgentRoleFlagView`). */
const FLAG_FACTS: Record<AiAgentRoleFlag, Pick<AiAgentRoleFlagView, 'label' | 'area' | 'verb'>> = {
  'schedule.view': { label: 'See shifts', area: 'schedule', verb: 'see' },
  'venue.view': { label: 'See venues', area: 'venues', verb: 'see' },
  'staff.view': { label: 'See staff', area: 'staff', verb: 'see' },
  'attendance.view': { label: 'See attendance', area: 'attendance', verb: 'see' },
  'payroll.view': { label: 'See payroll', area: 'payroll', verb: 'see' },
  'schedule.create': { label: 'Suggest shifts (needs approval)', area: 'schedule', verb: 'suggest' },
  'staff.edit': { label: 'Suggest staff changes (needs approval)', area: 'staff', verb: 'suggest' },
};
const ALLOWLIST = new Set<string>(AI_AGENT_ROLE_ALLOWLIST);
const GRANTABLE_6A = new Set<string>(AI_AGENT_ROLE_FLAGS_6A);

/**
 * AI Phase 6a — the agent's ROLE: a flag CEILING for the agent (docs/ai/PHASE6_TWENTY_PLAN.md §2 item 7, C5). At run time
 * (6b, after EX-3) the effective flags are agent role ∩ the run-as user's flags ∩ the consent snapshot, so a role can
 * only narrow what a person already holds; no role = no tools. Nothing here runs or reads data for an agent.
 *
 * An agent role is a `core.role` row with `assignable_to_agents` (RoleAssignableToAgents1786721040000): a custom
 * (`custom_agent_…`) role of the caller's CURRENT workspace, never a system role, never assignable to members, never
 * "read all objects", never held by a human (FK), never given object / field rules (FK), immutable kind. The first PUT
 * creates a dedicated role for the agent; later PUTs replace its flags (and bump its `permission_version`, which 6b's
 * principal compares with the trigger snapshot — so a flag change pauses an enabled trigger).
 *
 * Flags (layer 2, MemberRolePolicyService.assertAgentGrantableTx — the single place that decides grants): each on the C1
 * agent allowlist, grantable IN 6a (blocker B10: only the three member view flags, because the database backstop
 * `core.enforce_member_role_permission_allowlist()` is deliberately NOT widened in 6a), and held by the caller (no
 * escalation). The backstop trigger refuses anything else on its own (layer 4).
 */
@Injectable()
export class AiAgentRoleService {
  constructor(
    private readonly authority: AiAgentAuthority,
    private readonly memberRoles: MemberRolePolicyService,
    private readonly permissions: PermissionsService,
    private readonly securityVersion: SecurityVersionService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async get(ctx: AuthContext, agentId: string): Promise<AiAgentRoleStorageView> {
    return this.tenantContext.runInTenantContext(this.authority.bound(ctx), async (m) => {
      await this.authority.assertManagerTx(m, ctx);
      await m.query('SET TRANSACTION READ ONLY');
      const agent = await findAgent(m, scopeOf(ctx), agentId, false);
      return this.view(m, ctx, agent.role_id);
    });
  }

  async setFlags(ctx: AuthContext, agentId: string, input: AiAgentRoleUpdateInput): Promise<AiAgentRoleStorageView> {
    const reason = await this.authority.authorizeWrite(ctx, input?.reason);
    const flags = input?.flags;
    if (!Array.isArray(flags) || flags.length > ALLOWLIST.size || new Set(flags).size !== flags.length || !flags.every((f) => typeof f === 'string' && ALLOWLIST.has(f))) {
      throw new AiAgentInvalidException('flags');
    }
    const notYet = flags.filter((f) => !GRANTABLE_6A.has(f));
    if (notYet.length > 0) throw new AiAgentRoleFlagNotAllowedException(notYet);
    const sorted = [...flags].sort() as PermissionFlagType[];
    try {
      return await this.tenantContext.runInTenantContext(this.authority.bound(ctx), async (m) => {
        await this.authority.assertManagerTx(m, ctx);
        const scope = scopeOf(ctx);
        const agent = await lockCustomAgent(m, scope, agentId);
        // No escalation (and the 6a allowlist again) — the single policy place shared with member roles.
        await this.memberRoles.assertAgentGrantableTx(m, ctx, sorted);
        let roleId = agent.role_id;
        let created = false;
        if (!roleId) {
          roleId = await this.createAgentRole(m, scope, agent.label);
          created = true;
          await m.query(`UPDATE core.ai_agent SET role_id = $3, updated_by = $4, updated_at = now() WHERE id = $1 AND workspace_id = $2 AND kind = 'custom' AND deleted_at IS NULL`, [
            agent.id,
            scope.workspaceId,
            roleId,
            ctx.userId,
          ]);
        } else {
          // The agent's current role must still be an agent role of this workspace the caller may manage.
          await this.memberRoles.loadAgentAssignableTx(m, ctx, roleId);
        }
        const before = await this.memberRoles.permissionKeysTx(m, roleId);
        await m.query(`DELETE FROM core.role_permission WHERE role_id = $1`, [roleId]);
        if (sorted.length > 0) {
          await m.query(
            `INSERT INTO core.role_permission (organisation_id, role_id, permission_id)
             SELECT $1, $2, p.id FROM core.permission p WHERE p.key = ANY($3::text[])`,
            [scope.organisationId, roleId, sorted],
          );
        }
        await this.securityVersion.bumpRole(m, roleId);
        await this.audit.record(m, ctx, AuditAction.AI_AGENT_ROLE_UPDATED, {
          entityType: 'ai_agent',
          entityId: agent.id,
          metadata: { agentId: agent.id, roleId, roleCreated: created, flags: sorted, previousFlags: [...before].sort(), reason },
        });
        return this.view(m, ctx, roleId);
      });
    } catch (error) {
      throw mapAgentWriteError(error);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A dedicated agent role in the caller's workspace (crewflow_app under role RLS; the CHECKs fix its shape). */
  private async createAgentRole(m: EntityManager, scope: Scope, agentLabel: string): Promise<string> {
    const suffix = randomBytes(6).toString('hex');
    const key = `${CUSTOM_ROLE_KEY_PREFIX}agent_${suffix}`;
    // Role names are unique per workspace (case-insensitive): the random suffix keeps a dedicated name from ever clashing.
    const name = `Agent: ${agentLabel.slice(0, 60)} (${suffix.slice(0, 6)})`.slice(0, 80);
    const [row] = await m.query<Array<{ id: string }>>(
      `INSERT INTO core.role (organisation_id, workspace_id, key, name, is_system, assignable_to_members, can_read_all_objects, assignable_to_agents)
       VALUES ($1, $2, $3, $4, false, false, false, true) RETURNING id`,
      [scope.organisationId, scope.workspaceId, key, name],
    );
    if (!row) throw new AiAgentInvalidException('roleId');
    return row.id;
  }

  private async view(m: EntityManager, ctx: AuthContext, roleId: string | null): Promise<AiAgentRoleStorageView> {
    const held = new Set<string>(roleId ? await this.memberRoles.permissionKeysTx(m, roleId) : []);
    const grantable: AiAgentRoleFlag[] = [];
    for (const flag of AI_AGENT_ROLE_FLAGS_6A) if (await this.permissions.userHasPermissionTx(m, ctx, flag)) grantable.push(flag);
    return {
      roleId,
      flags: AI_AGENT_ROLE_ALLOWLIST.map((flag) => ({ flag, ...FLAG_FACTS[flag], held: held.has(flag) })),
      grantable,
    };
  }
}

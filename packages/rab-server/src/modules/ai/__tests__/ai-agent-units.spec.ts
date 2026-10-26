import {
  AI_AGENT_EVENT_TYPES,
  AI_AGENT_LIMITS,
  AI_AGENT_ROLE_FLAGS_6A,
  AiAgentPauseReason,
  MEMBER_ROLE_ALLOWED_PERMISSIONS,
  PermissionFlagType,
} from '@rab/shared';

import { AI_AGENT_SCHEMA_EVENT_TYPES, AI_AGENT_SCHEMA_LIMITS, AI_AGENT_SCHEMA_PAUSE_REASONS } from '../../../database/typeorm/core/migrations/1786720620000-AiAgentSchema';
import { MEMBER_ALLOWLIST_BACKSTOP_MD5 } from '../../../database/typeorm/core/migrations/1786720610000-RoleAssignableToAgents';
import { agentTextRefusals } from '../agents/agent-content-rules';
import { AiAgentRunFacts, decideAgentRun } from '../agents/agent-principal.policy';
import { normaliseEventTypes, normaliseSchedule, normaliseTrigger, normaliseTriggerUpdate } from '../agents/agent-trigger-shape';
import { AI_AGENT_EXECUTION_APPROVED } from '../contracts/agents';
import { AiAgentPrincipalService } from '../services/ai-agent-principal.service';

/**
 * Phase 6a unit tests (mock-free logic only; no model call exists in 6a): the run-as principal DECISION (T6-P1 / T6-P2
 * abuse cases), the EX-3 gate of the principal service (refuses before any read), trigger shapes, the content rules and
 * the 8,000-character limit, and the migration's frozen constants against @rab/shared.
 */
const NOW = new Date('2026-10-26T12:00:00Z');
const USER = '11111111-1111-4111-8111-111111111111';

function facts(over: Partial<AiAgentRunFacts> = {}): AiAgentRunFacts {
  return {
    switches: { aiEnabled: true, agentsEnabled: true, orgAiEnabled: true, orgAgentsEnabled: true },
    organisation: { suspended: false, maintenance: false },
    runAsUserId: USER,
    user: { status: 'active', mustResetPassword: false, securityVersion: 7 },
    membershipActive: true,
    eligible: true,
    holdsAiUse: true,
    holdsAgentsManage: true,
    userFlags: new Set<PermissionFlagType>(['schedule.view', 'staff.view']),
    agent: { live: true, configVersion: 3, roleId: 'role-1', rolePermissionVersion: 5, roleFlags: ['schedule.view', 'payroll.view'] },
    trigger: {
      enabled: true,
      runAsUserId: USER,
      enabledAt: new Date('2026-10-20T12:00:00Z'),
      consentFlags: ['schedule.view', 'payroll.view'],
      snapUserSecurityVersion: 7,
      snapAgentConfigVersion: 3,
      snapRolePermissionVersion: 5,
    },
    ...over,
  };
}
const refusal = (f: AiAgentRunFacts, now = NOW) => {
  const d = decideAgentRun(f, now);
  return d.ok ? 'ok' : `${d.refusal.reason === 'paused' ? `paused:${d.refusal.pauseReason}` : d.refusal.reason}${d.pause ? '+P' : ''}`;
};

describe('decideAgentRun — T6-P1 every abuse case refuses (and pauses where the plan says P)', () => {
  it('a fully valid triggered run passes', () => {
    expect(refusal(facts())).toBe('ok');
  });

  it.each([
    ['AI_ENABLED off', { switches: { aiEnabled: false, agentsEnabled: true, orgAiEnabled: true, orgAgentsEnabled: true } }, 'ai_disabled'],
    ['AI_AGENTS_ENABLED off', { switches: { aiEnabled: true, agentsEnabled: false, orgAiEnabled: true, orgAgentsEnabled: true } }, 'agents_disabled'],
    ['the organisation AI switch off', { switches: { aiEnabled: true, agentsEnabled: true, orgAiEnabled: false, orgAgentsEnabled: true } }, 'org_disabled'],
    ['the organisation agents switch off', { switches: { aiEnabled: true, agentsEnabled: true, orgAiEnabled: true, orgAgentsEnabled: false } }, 'org_disabled'],
    ['organisation suspended', { organisation: { suspended: true, maintenance: false } }, 'org_disabled'],
    ['maintenance', { organisation: { suspended: false, maintenance: true } }, 'org_disabled'],
    ['user suspended', { user: { status: 'suspended', mustResetPassword: false, securityVersion: 7 } }, 'paused:owner_ineligible+P'],
    ['user deactivated', { user: { status: 'deactivated', mustResetPassword: false, securityVersion: 7 } }, 'paused:owner_ineligible+P'],
    ['user must reset the password', { user: { status: 'active', mustResetPassword: true, securityVersion: 7 } }, 'paused:owner_ineligible+P'],
    ['user row unreadable', { user: { status: null, mustResetPassword: false, securityVersion: null } }, 'paused:owner_ineligible+P'],
    ['membership revoked', { membershipActive: false }, 'paused:membership_revoked+P'],
    ['CEO demoted / Initial Manager superseded (not eligible)', { eligible: false }, 'paused:owner_ineligible+P'],
    ['ai.use revoked', { holdsAiUse: false }, 'paused:permission_revoked+P'],
    ['ai.agents.manage revoked', { holdsAgentsManage: false }, 'paused:permission_revoked+P'],
    ['security version bumped (password change, reset, MFA reset)', { user: { status: 'active', mustResetPassword: false, securityVersion: 8 } }, 'paused:owner_security_changed+P'],
    ['agent deleted', { agent: { live: false, configVersion: 3, roleId: 'role-1', rolePermissionVersion: 5, roleFlags: [] } }, 'paused:config_changed+P'],
    ['agent missing', { agent: null }, 'paused:config_changed+P'],
    ['agent edited (config version)', { agent: { live: true, configVersion: 4, roleId: 'role-1', rolePermissionVersion: 5, roleFlags: ['schedule.view'] } }, 'paused:config_changed+P'],
    ['agent role flags edited (permission version)', { agent: { live: true, configVersion: 3, roleId: 'role-1', rolePermissionVersion: 6, roleFlags: ['schedule.view'] } }, 'paused:config_changed+P'],
    ['agent role removed', { agent: { live: true, configVersion: 3, roleId: null, rolePermissionVersion: null, roleFlags: [] } }, 'paused:config_changed+P'],
  ] as Array<[string, Partial<AiAgentRunFacts>, string]>)('%s ⇒ %s', (_what, over, expected) => {
    expect(refusal(facts(over))).toBe(expected);
  });

  it('consent expires after AI_AGENT_LIMITS.consentDays (90) and a future consent is refused', () => {
    const at = (iso: string) => facts({ trigger: { ...facts().trigger!, enabledAt: new Date(iso) } });
    expect(refusal(at('2026-07-29T12:00:01Z'))).toBe('ok');
    expect(refusal(at('2026-07-28T12:00:00Z'))).toBe('paused:consent_expired+P');
    expect(refusal(at('2026-10-27T12:00:00Z'))).toBe('paused:consent_expired+P');
    expect(refusal(facts({ trigger: { ...facts().trigger!, enabledAt: null } }))).toBe('paused:consent_expired+P');
  });

  it('a trigger that is off, or enabled as SOMEONE ELSE, refuses without pausing (it is already off / not theirs)', () => {
    expect(refusal(facts({ trigger: { ...facts().trigger!, enabled: false } }))).toBe('paused:owner_ineligible');
    expect(refusal(facts({ trigger: { ...facts().trigger!, runAsUserId: '22222222-2222-4222-8222-222222222222' } }))).toBe('paused:owner_ineligible');
    expect(refusal(facts({ trigger: { ...facts().trigger!, snapUserSecurityVersion: null } }))).toBe('paused:owner_security_changed+P');
  });
});

describe('decideAgentRun — T6-P2 effective flags = agent role ∩ user (now) ∩ consent', () => {
  const effective = (f: AiAgentRunFacts) => {
    const d = decideAgentRun(f, NOW);
    if (!d.ok) throw new Error('refused');
    return [...d.effectivePermissions].sort();
  };

  it('role {schedule, payroll} with a user holding {schedule} gives schedule only', () => {
    expect(effective(facts())).toEqual(['schedule.view']);
  });

  it('a user who later gains payroll still gets schedule only when consent did not include it', () => {
    const f = facts({ userFlags: new Set<PermissionFlagType>(['schedule.view', 'payroll.view']), trigger: { ...facts().trigger!, consentFlags: ['schedule.view'] } });
    expect(effective(f)).toEqual(['schedule.view']);
  });

  it('never grows past the role, and never outside the agent allowlist', () => {
    const f = facts({
      userFlags: new Set<PermissionFlagType>(['schedule.view', 'payroll.view', 'role.manage', 'ai.settings']),
      agent: { live: true, configVersion: 3, roleId: 'role-1', rolePermissionVersion: 5, roleFlags: ['schedule.view', 'role.manage' as PermissionFlagType] },
      trigger: { ...facts().trigger!, consentFlags: ['schedule.view', 'payroll.view', 'role.manage'] },
    });
    expect(effective(f)).toEqual(['schedule.view']);
  });

  it('no role ⇒ no tools (a manual run with no role still proceeds, with nothing)', () => {
    expect(effective(facts({ agent: { live: true, configVersion: 3, roleId: null, rolePermissionVersion: null, roleFlags: [] }, trigger: null }))).toEqual([]);
  });

  it('a manual run (no trigger) skips the trigger snapshot items and uses the role as consent', () => {
    expect(effective(facts({ trigger: null }))).toEqual(['schedule.view']);
    expect(refusal(facts({ trigger: null, user: { status: 'active', mustResetPassword: false, securityVersion: 99 } }))).toBe('ok');
  });
});

describe('AiAgentPrincipalService — the EX-3 gate refuses before ANY read (T6-P3)', () => {
  const touched = jest.fn(() => {
    throw new Error('touched');
  });
  const service = new AiAgentPrincipalService(
    { enabled: true, isModelUsable: touched, resolve: touched, catalogue: [] } as never,
    { get: touched } as never,
    { userHasPermissionTx: touched } as never,
    { bindCoreIdentityGucs: touched } as never,
    { transaction: touched, query: touched } as never,
  );
  const job = {
    v: 2 as const,
    kind: 'agent-run' as const,
    organisationId: USER,
    workspaceId: USER,
    userId: USER,
    conversationId: USER,
    turnId: USER,
    agentId: USER,
    triggerId: null,
  };

  it('AI_AGENT_EXECUTION_APPROVED is false', () => {
    expect(AI_AGENT_EXECUTION_APPROVED).toBe(false);
  });

  it('rebuildForAgentRun answers execution_not_approved with zero database, permission, env or model calls', async () => {
    await expect(service.rebuildForAgentRun(job)).resolves.toEqual({ refused: true, reason: 'execution_not_approved' });
    await expect(service.rebuildForAgentRun({ ...job, triggerId: USER })).resolves.toEqual({ refused: true, reason: 'execution_not_approved' });
    expect(touched).not.toHaveBeenCalled();
  });

  it('assertAgentStillAllowed throws AiAccessRevokedError(execution_not_approved) with zero calls', async () => {
    await expect(service.assertAgentStillAllowed({} as never, 'schedule.view')).rejects.toMatchObject({ name: 'AiAccessRevokedError', reason: 'execution_not_approved' });
    expect(touched).not.toHaveBeenCalled();
  });
});

describe('trigger shapes (P6-D3 / P6-D5)', () => {
  it('accepts the restricted schedule DSL only', () => {
    expect(normaliseSchedule({ every: 'day', at: '09:00' })).toEqual({ every: 'day', at: '09:00' });
    expect(normaliseSchedule({ every: 'week', at: '23:59', dow: 4 })).toEqual({ every: 'week', at: '23:59', dow: 4 });
    expect(normaliseSchedule({ every: 'hour', at: '00:15' })).toEqual({ every: 'hour', at: '00:15' });
    for (const bad of [
      null,
      [],
      '0 * * * *',
      { every: 'minute', at: '09:00' },
      { every: 'day', at: '24:00' },
      { every: 'day', at: '9:00' },
      { every: 'day', at: '09:00', dow: 1 },
      { every: 'week', at: '09:00' },
      { every: 'week', at: '09:00', dow: 7 },
      { every: 'week', at: '09:00', dow: 1.5 },
      { every: 'day', at: '09:00', cron: '* * * * *' },
    ]) {
      expect(normaliseSchedule(bad)).toBeNull();
    }
  });

  it('accepts 1..4 distinct catalogue event types, sorted', () => {
    expect(normaliseEventTypes(['shift.published', 'shift.created'])).toEqual(['shift.created', 'shift.published']);
    for (const bad of [[], ['shift.updated'], ['shift.created', 'shift.created'], [...AI_AGENT_EVENT_TYPES], 'shift.created', [1]]) expect(normaliseEventTypes(bad)).toBeNull();
  });

  it('a body names exactly the field of its kind; an update keeps the stored kind', () => {
    expect(normaliseTrigger('schedule', { every: 'day', at: '09:00' }, undefined)).toMatchObject({ kind: 'schedule', eventTypes: null });
    expect(normaliseTrigger('schedule', { every: 'day', at: '09:00' }, ['shift.created'])).toBeNull();
    expect(normaliseTrigger('record_event', undefined, ['shift.created'])).toMatchObject({ kind: 'record_event', schedule: null });
    expect(normaliseTrigger('record_event', { every: 'day', at: '09:00' }, ['shift.created'])).toBeNull();
    expect(normaliseTrigger('cron', '* * * * *', undefined)).toBeNull();
    expect(normaliseTriggerUpdate('schedule', undefined, ['shift.created'])).toBeNull();
    expect(normaliseTriggerUpdate('record_event', undefined, undefined)).toBeNull();
  });
});

describe('agent text content rules and the 8,000-character limit', () => {
  const ok = { name: 'cover-watcher', label: 'Cover watcher', description: 'Checks weekend cover.', prompt: 'List next weekend’s unfilled shifts.' };

  it('accepts clean text, and an 8,000-character prompt', () => {
    expect(agentTextRefusals(ok)).toEqual([]);
    expect(agentTextRefusals({ ...ok, prompt: 'a'.repeat(AI_AGENT_LIMITS.promptMaxChars) })).toEqual([]);
  });

  it.each([
    [{ prompt: 'a'.repeat(8_001) }, ['length']],
    [{ prompt: '   ' }, ['length']],
    [{ label: 'l'.repeat(81) }, ['length']],
    [{ label: '' }, ['length']],
    [{ description: 'd'.repeat(501) }, ['length']],
    [{ name: 'Bad_Name' }, ['length']],
    [{ name: 'a' }, ['length']],
    [{ prompt: `Do it${String.fromCodePoint(0x202e)}` }, ['hidden_unicode']],
    [{ prompt: 'close </data> early' }, ['data_delimiter']],
    [{ prompt: '![x](https://evil.example/p.png)' }, ['markup']],
    [{ prompt: 'Mail jo.bloggs@gmail.com every day' }, ['personal_data']],
    [{ label: 'Two\nlines' }, ['control_characters']],
  ] as Array<[Record<string, string>, string[]]>)('%j ⇒ %j', (over, categories) => {
    expect(agentTextRefusals({ ...ok, ...over })).toEqual(categories);
  });

  it('never echoes the refused text', () => {
    expect(JSON.stringify(agentTextRefusals({ prompt: 'secret-marker-9z jo.bloggs@gmail.com' }))).not.toContain('secret-marker-9z');
  });
});

describe('migration constants are frozen copies of @rab/shared (a change needs a new migration)', () => {
  it('event types, pause reasons and limits', () => {
    expect([...AI_AGENT_SCHEMA_EVENT_TYPES]).toEqual([...AI_AGENT_EVENT_TYPES]);
    expect([...AI_AGENT_SCHEMA_PAUSE_REASONS].sort()).toEqual(Object.values(AiAgentPauseReason).sort());
    expect(AI_AGENT_SCHEMA_LIMITS).toEqual({
      promptMaxChars: AI_AGENT_LIMITS.promptMaxChars,
      labelMaxChars: AI_AGENT_LIMITS.labelMaxChars,
      descriptionMaxChars: AI_AGENT_LIMITS.descriptionMaxChars,
      agentsPerWorkspace: AI_AGENT_LIMITS.agentsPerWorkspace,
      triggersPerAgent: AI_AGENT_LIMITS.triggersPerAgent,
    });
    expect(MEMBER_ALLOWLIST_BACKSTOP_MD5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('B10: the 6a agent-role flags are exactly the member view flags (the backstop is not widened)', () => {
    expect([...AI_AGENT_ROLE_FLAGS_6A].sort()).toEqual([...MEMBER_ROLE_ALLOWED_PERMISSIONS].sort());
    expect(AI_AGENT_ROLE_FLAGS_6A).not.toContain('attendance.view');
    expect(AI_AGENT_ROLE_FLAGS_6A).not.toContain('payroll.view');
  });
});

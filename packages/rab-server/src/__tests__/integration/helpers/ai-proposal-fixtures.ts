import { createHash, randomUUID } from 'node:crypto';

import { AuthCacheRedisClientProvider } from '../../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AiProposalService } from '../../../modules/ai/actions/ai-proposal.service';
import { AiTurnIds } from '../../../modules/ai/contracts/turn';
import { SchedulingService } from '../../../modules/scheduling/services/scheduling.service';
import { VenueService } from '../../../modules/venue/services/venue.service';
import { AiKit } from './ai-test-kit';
import { TestIdentity } from './test-identities';

/**
 * Phase 5a proposal fixtures (new helper file — the shared AI kit is not edited). Fixture rows are written as the
 * bootstrap/superuser identity (`kit.owner`), never through the code under test; every assertion about access goes
 * through the app's own runtime role (crewflow_app, RLS-bound).
 */
export const ctxOf = (id: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext => ({
  organisationId: id.organisationId,
  workspaceId: id.workspaceId,
  userId: id.userId,
  role: '',
});

/** A conversation with a user message and a RUNNING assistant turn (what 5b's propose_action runs inside). */
export async function runningTurn(kit: AiKit, id: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): Promise<AiTurnIds> {
  const [conv] = await kit.owner.query(`INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id, message_count) VALUES ($1, $2, $3, 2) RETURNING id`, [
    id.organisationId,
    id.workspaceId,
    id.userId,
  ]);
  const [msg] = await kit.owner.query(
    `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content, client_request_id) VALUES ($1, $2, $3, $4, 1, 'user', 'Please draft a shift.', $5) RETURNING id`,
    [id.organisationId, id.workspaceId, id.userId, conv.id, randomUUID()],
  );
  const [turn] = await kit.owner.query(
    `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, session_id, started_at)
     VALUES ($1, $2, $3, $4, 2, 'assistant', 'running', $5, $6, now()) RETURNING id`,
    [id.organisationId, id.workspaceId, id.userId, conv.id, msg.id, randomUUID()],
  );
  return { turnId: turn.id, conversationId: conv.id, organisationId: id.organisationId, workspaceId: id.workspaceId!, userId: id.userId };
}

/** A venue and a job role owned by `id` (through the real domain services, as the console creates them). */
export async function venueAndRole(kit: AiKit, id: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): Promise<{ venueId: string; jobRoleId: string }> {
  const label = randomUUID().slice(0, 8);
  const venue = await kit.moduleRef.get(VenueService).create(ctxOf(id), { name: `AI Venue ${label}`, type: 'hotel' } as never);
  const role = await kit.moduleRef.get(SchedulingService).createJobRole(ctxOf(id), { name: `AI Role ${label}`, defaultRatePence: 1250 } as never);
  return { venueId: venue.id, jobRoleId: role.id };
}

/** A shift window `daysAhead` days from now, `hours` long. */
export function windowFromNow(daysAhead = 3, hours = 6): { startsAt: string; endsAt: string } {
  const start = new Date(Date.now() + daysAhead * 86_400_000);
  start.setUTCMinutes(0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + hours * 3_600_000).toISOString() };
}

let callSeq = 0;
/** The server side of `propose_action`, exactly as 5b's tool will call it. */
export function propose(kit: AiKit, turn: AiTurnIds, tool: string, args: Record<string, unknown>, extra: { alternativeOf?: string; toolCallId?: string } = {}) {
  const input: Record<string, unknown> = { tool, arguments: args };
  if (extra.alternativeOf) input.alternativeOf = extra.alternativeOf;
  return kit.moduleRef.get(AiProposalService).createFromTool(turn, { toolCallId: extra.toolCallId ?? `call_${Date.now()}_${++callSeq}`, input });
}

/** Proposes and returns the new id (fails the test setup loudly otherwise). */
export async function proposeOk(kit: AiKit, turn: AiTurnIds, tool: string, args: Record<string, unknown>, extra: { alternativeOf?: string } = {}): Promise<string> {
  const result = await propose(kit, turn, tool, args, extra);
  if (!('status' in result)) throw new Error(`test setup: proposal refused ${JSON.stringify(result)}`);
  return result.proposalId;
}

/** Superuser-only fixture: moves a proposal's creation and expiry 20 minutes into the past (triggers skipped). */
export async function backdate(kit: AiKit, proposalId: string): Promise<void> {
  await kit.owner.transaction(async (m) => {
    await m.query(`SET LOCAL session_replication_role = replica`);
    await m.query(`UPDATE core.ai_action_proposal SET created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes' WHERE id = $1`, [proposalId]);
  });
}

export async function proposalRow(kit: AiKit, proposalId: string): Promise<Record<string, unknown>> {
  const [row] = await kit.owner.query(`SELECT * FROM core.ai_action_proposal WHERE id = $1`, [proposalId]);
  return row;
}

export async function auditFor(kit: AiKit, proposalId: string): Promise<Array<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>> {
  return kit.owner.query(`SELECT action, actor_user_id, metadata FROM core.audit_log WHERE entity_type = 'ai_action_proposal' AND entity_id = $1 ORDER BY created_at, id`, [proposalId]);
}

export const shiftCount = async (kit: AiKit, venueId: string): Promise<number> =>
  (await kit.owner.query(`SELECT count(*)::int AS n FROM core.shift WHERE venue_id = $1`, [venueId]))[0].n as number;

/** Simulates an expired step-up window for this access token's session (deletes the session's grant, as its TTL does). */
export async function expireStepUp(kit: AiKit, token: string): Promise<void> {
  const sid = (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
  await kit.moduleRef.get(AuthCacheRedisClientProvider).client.del(`crewflow:test:step-up:${createHash('sha256').update(sid).digest('hex')}`);
}

/** Runs `fn` while `flag` is revoked for `id` by a per-user override (the same mechanism as the layer-2 suite). */
export async function withRevoked<T>(kit: AiKit, id: Pick<TestIdentity, 'organisationId' | 'userId'>, flag: string, fn: () => Promise<T>): Promise<T> {
  const bump = () => kit.owner.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [id.userId]);
  const inserted = await kit.owner.query(
    `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3 RETURNING user_id`,
    [id.userId, id.organisationId, flag],
  );
  if (inserted.length !== 1) throw new Error(`test setup: permission ${flag} is not in the catalogue`);
  await bump();
  try {
    return await fn();
  } finally {
    await kit.owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`, [id.userId, flag]);
    await bump();
  }
}

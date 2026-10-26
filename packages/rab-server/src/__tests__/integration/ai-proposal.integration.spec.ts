import './helpers/ai-env';

import { AiProposalStatus, PermissionFlag, ShiftStatus } from '@rab/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AiProposalService } from '../../modules/ai/actions/ai-proposal.service';
import { AiWriteToolsService } from '../../modules/ai/actions/ai-write-tools';
import { AiTurnIds } from '../../modules/ai/contracts/turn';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import {
  auditFor,
  backdate,
  ctxOf,
  expireStepUp,
  propose,
  proposeOk,
  proposalRow,
  runningTurn,
  shiftCount,
  venueAndRole,
  windowFromNow,
  withRevoked,
} from './helpers/ai-proposal-fixtures';
import { AiKit, aiOrganisation, bearer, bootAiKit, manager, setOrgAi } from './helpers/ai-test-kit';

/**
 * AI Phase 5a — human approval of AI write proposals (PHASE5_TWENTY_PLAN §2.4, security rules 6.1–6.6, §15 "Proposals").
 * Real AppModule, real PostgreSQL on crewflow_app (RLS on), real Redis; no model is called (proposals are created through
 * the server side of `propose_action`, exactly as 5b's tool will call it). Abuse cases T5-A1 … T5-A12, T5-C3, T5-M1.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI write proposals: approve / reject / execute (integration)', () => {
  jest.setTimeout(300_000);
  let kit: AiKit;
  let org: Awaited<ReturnType<typeof aiOrganisation>>;
  let venueId: string;
  let jobRoleId: string;
  let service: AiProposalService;

  const approve = (token: string, id: string, body: Record<string, unknown> = {}) => kit.http().post(`/rest/v1/ai/proposals/${id}/approve`).set(bearer(token)).send(body);
  const reject = (token: string, id: string, body: Record<string, unknown>) => kit.http().post(`/rest/v1/ai/proposals/${id}/reject`).set(bearer(token)).send(body);
  const draftArgs = (over: Record<string, unknown> = {}) => ({ venueId, jobRoleId, ...windowFromNow(), requiredCount: 2, ...over });
  const freshTurn = () => runningTurn(kit, org.ceo);
  const freshToken = () => kit.factory.login(org.ceo);

  beforeAll(async () => {
    kit = await bootAiKit();
    service = kit.moduleRef.get(AiProposalService);
    org = await aiOrganisation(kit, 'ai-proposal');
    ({ venueId, jobRoleId } = await venueAndRole(kit, org.ceo));
  });
  afterAll(async () => {
    await kit?.close();
  });

  // ─────────────────────────────────────────────────────────── creation (T5-C3, strict input, limits)

  it('T5-C3: propose_action writes exactly one PENDING row and the shift count does not change until approval', async () => {
    const turn = await freshTurn();
    const before = await shiftCount(kit, venueId);
    const result = await propose(kit, turn, 'create_draft_shift', draftArgs({ notes: 'Bring a black apron' }));
    expect(result).toMatchObject({ status: 'awaiting_user' });
    const id = (result as { proposalId: string }).proposalId;
    const row = await proposalRow(kit, id);
    expect(row).toMatchObject({ status: 'PENDING', tool: 'create_draft_shift', user_id: org.ceo.userId, impact: 'normal', affected_count: 2, target_type: 'venue', target_id: venueId, decided_by: null });
    expect(row.editable_fields).toEqual(['startsAt', 'endsAt', 'requiredCount', 'notes']);
    expect(String(row.summary)).toContain('DRAFT shift');
    expect(String(row.summary)).not.toContain('apron');
    expect((new Date(row.expires_at as string).getTime() - new Date(row.created_at as string).getTime()) / 60_000).toBeCloseTo(15, 5);
    expect(await shiftCount(kit, venueId)).toBe(before);
    const created = await auditFor(kit, id);
    expect(created.map((a) => a.action)).toEqual(['ai.proposal_created']);
    expect(JSON.stringify(created)).not.toContain('apron');
  });

  it('strict input: unknown keys, tenant / status / pay keys, a 4th tool and an unpermitted tool are refused with paths only', async () => {
    const turn = await freshTurn();
    for (const bad of [{ organisationId: org.orgId }, { status: 'open' }, { payRatePence: 1 }, { chargeRatePence: 0 }, { requiredCount: 26 }, { requiredCount: 0 }]) {
      const result = await propose(kit, turn, 'create_draft_shift', draftArgs(bad));
      expect(result).toMatchObject({ error: 'invalid_input' });
      expect(JSON.stringify(result)).not.toContain(org.orgId);
    }
    expect(await propose(kit, turn, 'send_offers', { shiftId: randomUUID() })).toMatchObject({ error: 'invalid_input' });
    expect(await propose(kit, turn, 'create_draft_shift', draftArgs({ ...windowFromNow(120) }))).toMatchObject({ error: 'invalid_input' });
    expect(await propose(kit, turn, 'create_draft_shift', draftArgs({ venueId: randomUUID() }))).toEqual({ error: 'invalid_input', issues: ['arguments'] });
    await withRevoked(kit, org.ceo, PermissionFlag.SCHEDULE_CREATE, async () => {
      expect(await propose(kit, turn, 'create_draft_shift', draftArgs())).toEqual({ error: 'invalid_input', issues: ['tool'] });
    });
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_action_proposal WHERE turn_id = $1`, [turn.turnId]))[0].n).toBe(0);
  });

  it('limits: at most 5 proposals per turn and 3 per alternatives group; a repeated tool call id returns the same proposal', async () => {
    const turn = await freshTurn();
    const first = await propose(kit, turn, 'create_draft_shift', draftArgs(), { toolCallId: 'call_same' });
    expect(await propose(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 9 }), { toolCallId: 'call_same' })).toEqual(first);
    const anchor = (first as { proposalId: string }).proposalId;
    await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 3 }), { alternativeOf: anchor });
    await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 4 }), { alternativeOf: anchor });
    expect(await propose(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 5 }), { alternativeOf: anchor })).toEqual({ error: 'proposal_limit' });
    await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 6 }));
    await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 7 }));
    expect(await propose(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 8 }))).toEqual({ error: 'proposal_limit' });
  });

  // ─────────────────────────────────────────────────────────── approval (executes once, as the approver, audited)

  it('approve: executes ONCE as the approver (shift.created_by = approver, a DRAFT, standard pay, charge 0); a second approve is 409', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ notes: 'Secret note text 1' }));
    const token = await freshToken();
    const before = await shiftCount(kit, venueId);
    const res = await approve(token, id);
    expect(res.status).toBe(200);
    expect(res.body.continuationTurnId).toBeNull();
    expect(res.body.proposal).toMatchObject({ id, status: 'EXECUTED', result: { entityType: 'shift' }, requiresStepUp: false });
    const shiftId = res.body.proposal.result.entityId as string;
    const [shift] = await kit.owner.query(`SELECT status, created_by, pay_rate_pence, charge_rate_pence, notes FROM core.shift WHERE id = $1`, [shiftId]);
    expect(shift).toEqual({ status: ShiftStatus.DRAFT, created_by: org.ceo.userId, pay_rate_pence: '1250', charge_rate_pence: '0', notes: 'Secret note text 1' });
    expect(await shiftCount(kit, venueId)).toBe(before + 1);
    const again = await approve(token, id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('AI_PROPOSAL_NOT_PENDING');
    expect(await shiftCount(kit, venueId)).toBe(before + 1);
    // T5-A10: created → approved → executed; metadata never holds argument text.
    const trail = await auditFor(kit, id);
    expect(trail.map((a) => a.action)).toEqual(['ai.proposal_created', 'ai.proposal_approved', 'ai.proposal_executed']);
    expect(trail.every((a) => a.actor_user_id === org.ceo.userId)).toBe(true);
    expect(trail[2]!.metadata).toMatchObject({ resultEntityType: 'shift', resultEntityId: shiftId, tool: 'create_draft_shift' });
    expect(JSON.stringify(trail)).not.toContain('Secret note text');
  });

  it('T5-A4: two approvals at the same time → exactly one EXECUTED and one shift; the other caller gets 409', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const token = await freshToken();
    const before = await shiftCount(kit, venueId);
    const results = await Promise.all([approve(token, id), approve(token, id), approve(token, id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await shiftCount(kit, venueId)).toBe(before + 1);
    expect((await auditFor(kit, id)).filter((a) => a.action === 'ai.proposal_executed')).toHaveLength(1);
  });

  it('T5-A1: the wrong user — the same organisation’s Initial Manager, or another organisation’s CEO — gets 404 and nothing changes', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const im = await manager(kit, org.orgId, { initial: true });
    const other = await aiOrganisation(kit, 'ai-proposal-other');
    for (const token of [im.token, other.token]) {
      const a = await approve(token, id);
      const r = await reject(token, id, { reason: 'not mine' });
      expect([a.status, r.status]).toEqual([404, 404]);
      expect(JSON.stringify(a.body)).not.toContain(id);
      expect((await kit.http().get(`/rest/v1/ai/conversations/${turn.conversationId}/proposals`).set(bearer(token))).status).toBe(404);
    }
    expect((await proposalRow(kit, id)).status).toBe('PENDING');
  });

  it('T5-A2: an expired proposal → 409 AI_PROPOSAL_EXPIRED and it becomes EXPIRED (audited); reject is refused the same way', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    await backdate(kit, id);
    const token = await freshToken();
    const res = await approve(token, id);
    expect([res.status, res.body.code]).toEqual([409, 'AI_PROPOSAL_EXPIRED']);
    expect((await proposalRow(kit, id)).status).toBe('EXPIRED');
    expect((await reject(token, id, { reason: 'too late' })).body.code).toBe('AI_PROPOSAL_EXPIRED');
    expect((await auditFor(kit, id)).map((a) => a.action)).toEqual(['ai.proposal_created', 'ai.proposal_expired']);
    // Lazy expiry on read: the list marks a due PENDING row EXPIRED.
    const id2 = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    await backdate(kit, id2);
    const list = await kit.http().get(`/rest/v1/ai/conversations/${turn.conversationId}/proposals`).set(bearer(token));
    expect(list.status).toBe(200);
    expect(list.body.find((p: { id: string }) => p.id === id2)).toMatchObject({ status: 'EXPIRED', fields: expect.any(Array) });
    expect((await proposalRow(kit, id2)).status).toBe('EXPIRED');
  });

  it('T5-A3: an already rejected proposal cannot be approved (409); reject needs a reason and changes nothing else', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const token = await freshToken();
    const before = await shiftCount(kit, venueId);
    expect((await reject(token, id, {})).status).toBe(400);
    expect((await reject(token, id, { reason: 'no' })).status).toBe(400);
    const r = await reject(token, id, { reason: 'Not needed this week' });
    expect(r.status).toBe(200);
    expect(r.body.proposal).toMatchObject({ status: 'REJECTED' });
    const a = await approve(token, id);
    expect([a.status, a.body.code]).toEqual([409, 'AI_PROPOSAL_NOT_PENDING']);
    expect(await shiftCount(kit, venueId)).toBe(before);
    expect((await auditFor(kit, id)).map((x) => [x.action, x.metadata.reason ?? null])).toEqual([
      ['ai.proposal_created', null],
      ['ai.proposal_rejected', 'Not needed this week'],
    ]);
  });

  it('T5-A5: high impact (> 10 people) needs a reason (400) and a recent step-up (403 STEP_UP_REQUIRED), nothing changes until both', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 12 }));
    expect(await proposalRow(kit, id)).toMatchObject({ impact: 'high', affected_count: 12 });
    const token = await freshToken();
    const before = await shiftCount(kit, venueId);
    const list = await kit.http().get(`/rest/v1/ai/conversations/${turn.conversationId}/proposals`).set(bearer(token));
    expect(list.body[0]).toMatchObject({ id, requiresStepUp: true, requiresReason: true, impact: 'high' });
    expect((await approve(token, id)).status).toBe(400);
    await expireStepUp(kit, token);
    const refused = await approve(token, id, { reason: 'Big event on Saturday' });
    expect([refused.status, refused.body.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect((await proposalRow(kit, id)).status).toBe('PENDING');
    expect(await shiftCount(kit, venueId)).toBe(before);
    const ok = await approve(await freshToken(), id, { reason: 'Big event on Saturday' });
    expect(ok.status).toBe(200);
    expect(await proposalRow(kit, id)).toMatchObject({ status: 'EXECUTED', decision_reason: 'Big event on Saturday' });
    expect(await shiftCount(kit, venueId)).toBe(before + 1);
  });

  it('p5 merge (Q4): without ai.use the proposal routes answer the uniform 404 (never a 403 that discloses the feature); nothing changes', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const token = await freshToken();
    await withRevoked(kit, org.ceo, PermissionFlag.AI_USE, async () => {
      for (const res of [
        await kit.http().get(`/rest/v1/ai/conversations/${turn.conversationId}/proposals`).set(bearer(token)),
        await approve(token, id),
        await reject(token, id, { reason: 'not allowed to decide' }),
      ]) {
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'AI_NOT_AVAILABLE' });
      }
    });
    expect(await proposalRow(kit, id)).toMatchObject({ status: 'PENDING' });
  });

  it('p5 merge (Q3): an invalid edit carries the stable code AI_PROPOSAL_EDIT_INVALID; nothing changes', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const res = await approve(await freshToken(), id, { edits: { venueId: randomUUID() } });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: 'AI_PROPOSAL_EDIT_INVALID' });
    expect(await proposalRow(kit, id)).toMatchObject({ status: 'PENDING' });
  });

  it('T5-A6: permission revoked between proposal and approval → 403, FAILED not_permitted, nothing written, never retried', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const token = await freshToken();
    const before = await shiftCount(kit, venueId);
    await withRevoked(kit, org.ceo, PermissionFlag.SCHEDULE_CREATE, async () => {
      expect((await approve(token, id)).status).toBe(403);
    });
    expect(await proposalRow(kit, id)).toMatchObject({ status: 'FAILED', error_code: 'not_permitted', final_arguments: null });
    expect(await shiftCount(kit, venueId)).toBe(before);
    expect((await approve(token, id)).body.code).toBe('AI_PROPOSAL_NOT_PENDING');
    expect((await auditFor(kit, id)).map((a) => a.action)).toEqual(['ai.proposal_created', 'ai.proposal_failed']);
  });

  it('T5-A7: stale snapshot — the venue was archived / the draft was edited — → 409 AI_PROPOSAL_STALE, FAILED stale, nothing written', async () => {
    const turn = await freshTurn();
    const own = await venueAndRole(kit, org.ceo);
    const id = await proposeOk(kit, turn, 'create_draft_shift', { ...draftArgs(), venueId: own.venueId, jobRoleId: own.jobRoleId });
    await kit.owner.query(`UPDATE core.venue SET archived_at = now(), archived_by = $2, status = 'archived', updated_at = now() WHERE id = $1`, [own.venueId, org.ceo.userId]);
    const token = await freshToken();
    const res = await approve(token, id);
    expect([res.status, res.body.code]).toEqual([409, 'AI_PROPOSAL_STALE']);
    expect(await proposalRow(kit, id)).toMatchObject({ status: 'FAILED', error_code: 'stale' });
    expect(await shiftCount(kit, own.venueId)).toBe(0);

    const draft = await kit.moduleRef.get(SchedulingService).create(ctxOf(org.ceo), { venueId, jobRoleId, ...windowFromNow(4), requiredCount: 1 } as never);
    const upd = await proposeOk(kit, turn, 'update_draft_shift', { shiftId: draft.id, requiredCount: 3 });
    await kit.moduleRef.get(SchedulingService).updateDraft(ctxOf(org.ceo), draft.id, { notes: 'edited by a person meanwhile' });
    const res2 = await approve(token, upd);
    expect(res2.body.code).toBe('AI_PROPOSAL_STALE');
    expect((await kit.owner.query(`SELECT required_count FROM core.shift WHERE id = $1`, [draft.id]))[0].required_count).toBe(1);
  });

  it('T5-A8: edits only the proposed fields; a non-proposed field, an unknown key or organisationId in the body is a 400; an edit that raises impact needs step-up', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const token = await freshToken();
    for (const body of [
      { edits: { venueId: randomUUID() } },
      { edits: { breakMinutes: 30 } }, // not proposed ⇒ not editable
      { edits: { payRatePence: 1 } },
      { edits: { requiredCount: 'two' } },
      { edits: { requiredCount: { nested: 1 } } },
      { organisationId: randomUUID() },
      { status: 'APPROVED' },
    ]) {
      const res = await approve(token, id, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect((await proposalRow(kit, id)).status).toBe('PENDING');
    const raised = await approve(token, id, { edits: { requiredCount: 15 } });
    expect(raised.status).toBe(400); // high impact now: a reason is required first
    await expireStepUp(kit, token);
    expect((await approve(token, id, { edits: { requiredCount: 15 }, reason: 'Conference' })).body.code).toBe('STEP_UP_REQUIRED');
    const ok = await approve(token, id, { edits: { requiredCount: 3 } });
    expect(ok.status).toBe(200);
    const row = await proposalRow(kit, id);
    expect(row).toMatchObject({ status: 'EXECUTED', affected_count: 3, impact: 'normal' });
    expect((row.final_arguments as Record<string, unknown>).requiredCount).toBe(3);
    expect((row.arguments as Record<string, unknown>).requiredCount).toBe(2);
    const [shift] = await kit.owner.query(`SELECT required_count FROM core.shift WHERE id = $1`, [ok.body.proposal.result.entityId]);
    expect(shift.required_count).toBe(3);
    expect((await auditFor(kit, id)).find((a) => a.action === 'ai.proposal_approved')!.metadata.editedFields).toEqual(['requiredCount']);
  });

  it('T5-A9: a domain failure inside apply() rolls EVERYTHING back (no shift, no APPROVED) and leaves FAILED, with no retry', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const tool = kit.moduleRef.get(AiWriteToolsService).get('create_draft_shift')!;
    const real = tool.apply;
    const spy = jest.spyOn(tool, 'apply').mockImplementation(async (m, ctx, input) => {
      await real.call(tool, m, ctx, input); // the shift row IS written in the transaction …
      throw new ConflictException('simulated domain refusal'); // … and must vanish with the rollback
    });
    const before = await shiftCount(kit, venueId);
    try {
      const res = await approve(await freshToken(), id);
      expect(res.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(await shiftCount(kit, venueId)).toBe(before);
    expect(await proposalRow(kit, id)).toMatchObject({ status: 'FAILED', error_code: 'conflict', final_arguments: null, decision_reason: null, executed_at: null });
    expect((await approve(await freshToken(), id)).body.code).toBe('AI_PROPOSAL_NOT_PENDING');
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'shift.created' AND organisation_id = $1 AND created_at > now() - interval '1 minute' AND entity_id NOT IN (SELECT id FROM core.shift)`, [org.orgId]))[0].n).toBe(0);
  });

  it('T5-A11: an Admin Inspect context is refused (404) before anything is read or written', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const inspect = { ...(await kit.factory.signedInContext(org.ceo)), inspectedBy: randomUUID(), security: undefined };
    await expect(service.approve(inspect, id, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reject(inspect, id, { reason: 'inspect' })).rejects.toBeInstanceOf(NotFoundException);
    expect((await proposalRow(kit, id)).status).toBe('PENDING');
  });

  it('T5-A12: approving one alternative rejects its pending siblings in the same transaction (audited alternative_chosen)', async () => {
    const turn = await freshTurn();
    const a = await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 2 }));
    const b = await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 3 }), { alternativeOf: a });
    const c = await proposeOk(kit, turn, 'create_draft_shift', draftArgs({ requiredCount: 4 }), { alternativeOf: a });
    const before = await shiftCount(kit, venueId);
    expect((await approve(await freshToken(), b)).status).toBe(200);
    expect((await proposalRow(kit, a)).status).toBe('REJECTED');
    expect((await proposalRow(kit, c)).status).toBe('REJECTED');
    expect((await proposalRow(kit, b)).status).toBe('EXECUTED');
    expect(await shiftCount(kit, venueId)).toBe(before + 1);
    expect((await auditFor(kit, c)).map((x) => [x.action, x.metadata.reason ?? null])).toEqual([
      ['ai.proposal_created', null],
      ['ai.proposal_rejected', 'alternative_chosen'],
    ]);
  });

  // ─────────────────────────────────────────────────────────── the other two tools

  it('update_draft_shift: changes only the proposed fields of the DRAFT, never status or pay; add_staff_note writes the exact note, audited without text', async () => {
    const turn = await freshTurn();
    const draft = await kit.moduleRef.get(SchedulingService).create(ctxOf(org.ceo), { venueId, jobRoleId, ...windowFromNow(5), requiredCount: 2, payRatePence: 1999 } as never);
    const id = await proposeOk(kit, turn, 'update_draft_shift', { shiftId: draft.id, requiredCount: 4, notes: 'Updated by AI' });
    expect((await proposalRow(kit, id)).editable_fields).toEqual(['requiredCount', 'notes']);
    const token = await freshToken();
    expect((await approve(token, id)).status).toBe(200);
    const [shift] = await kit.owner.query(`SELECT status, required_count, notes, pay_rate_pence FROM core.shift WHERE id = $1`, [draft.id]);
    expect(shift).toEqual({ status: 'draft', required_count: 4, notes: 'Updated by AI', pay_rate_pence: '1999' });

    const staff = await kit.factory.createStaff({ id: org.orgId }, { owner: org.ceo, label: 'ai-note' });
    const body = `Private observation ${randomUUID()}`;
    const noteId = await proposeOk(kit, turn, 'add_staff_note', { staffProfileId: staff.profileId, body });
    const list = await kit.http().get(`/rest/v1/ai/conversations/${turn.conversationId}/proposals`).set(bearer(token));
    const card = list.body.find((p: { id: string }) => p.id === noteId);
    expect(card.summary).not.toContain(body);
    expect(card.fields).toEqual([expect.objectContaining({ key: 'body', value: body, editable: true, type: 'multiline' })]);
    expect(card.target).toMatchObject({ type: 'staff_profile', id: staff.profileId, label: 'Staff Member' });
    const res = await approve(token, noteId);
    expect(res.status).toBe(200);
    const [note] = await kit.owner.query(`SELECT body, author_user_id FROM core.user_note WHERE id = $1`, [res.body.proposal.result.entityId]);
    expect(note).toEqual({ body, author_user_id: org.ceo.userId });
    const trail = await kit.owner.query(`SELECT action, metadata FROM core.audit_log WHERE organisation_id = $1 AND (entity_id = $2 OR entity_id = $3)`, [org.orgId, noteId, staff.profileId]);
    expect(trail.map((t: { action: string }) => t.action).sort()).toEqual(['ai.proposal_approved', 'ai.proposal_created', 'ai.proposal_executed', 'staff.note_added']);
    expect(JSON.stringify(trail)).not.toContain(body);
  });

  it('D9: approval works while no model is ready; AI off for the organisation → the uniform 404', async () => {
    const turn = await freshTurn();
    const id = await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const token = await freshToken();
    await setOrgAi(kit, org.orgId, false);
    try {
      expect((await approve(token, id)).status).toBe(404);
      expect((await kit.http().get(`/rest/v1/ai/conversations/${turn.conversationId}/proposals`).set(bearer(token))).status).toBe(404);
    } finally {
      await setOrgAi(kit, org.orgId, true);
    }
    expect((await proposalRow(kit, id)).status).toBe(AiProposalStatus.PENDING);
  });

  it('serverNow / expiresAt come from the database clock; malformed ids are 404/400 before any query', async () => {
    const turn: AiTurnIds = await freshTurn();
    await proposeOk(kit, turn, 'create_draft_shift', draftArgs());
    const token = await freshToken();
    const list = await kit.http().get(`/rest/v1/ai/conversations/${turn.conversationId}/proposals`).set(bearer(token));
    const [card] = list.body;
    expect(new Date(card.expiresAt).getTime() - new Date(card.serverNow).getTime()).toBeLessThanOrEqual(15 * 60_000);
    expect(new Date(card.expiresAt).getTime()).toBeGreaterThan(new Date(card.serverNow).getTime());
    expect([400, 404]).toContain((await approve(token, 'not-a-uuid')).status);
    expect((await approve(token, randomUUID())).status).toBe(404);
  });
});

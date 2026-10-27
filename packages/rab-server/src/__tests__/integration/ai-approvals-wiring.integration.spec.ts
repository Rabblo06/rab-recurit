import './helpers/ai-env';

import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';

import { AiProposalExecutorService } from '../../modules/ai/actions/ai-proposal-executor.service';
import { ctxOf, proposalRow, shiftCount, venueAndRole, windowFromNow } from './helpers/ai-proposal-fixtures';
import { scriptedModel, textParts, toolCallParts } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, newConversation, turnRow } from './helpers/ai-test-kit';

/**
 * AI 5b — approvals in the live turn (p5 DOC-DRAFTS §5), on the real AppModule, PostgreSQL (crewflow_app, FORCE RLS) and
 * Redis, scripted models only. The claim under test: NO tool path can write without an APPROVED proposal.
 *   - the model can only PROPOSE (`propose_action` → a PENDING row); the turn pauses there and nothing else changes;
 *   - write tool names called directly, or through execute_tool, are refused; nothing is proposed or written;
 *   - a user without the write flag is not offered propose_action for it;
 *   - the executor IS the approval transaction and only approve calls it (static); it refuses another organisation's
 *     user and an already-decided proposal;
 *   - after approve / reject a CONTINUATION turn runs and sees only the server-written result (no note text, no argument).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI 5b: approvals in the live turn (integration)', () => {
  jest.setTimeout(300_000);
  let kit: AiKit;
  let org: Awaited<ReturnType<typeof aiOrganisation>>;
  let venueId: string;
  let jobRoleId: string;

  beforeAll(async () => {
    kit = await bootAiKit();
    org = await aiOrganisation(kit, 'w5-approvals');
    ({ venueId, jobRoleId } = await venueAndRole(kit, org.ceo));
  });
  afterEach(() => kit.setModel(null));
  afterAll(async () => {
    await kit?.close();
  });

  const draft = (over: Record<string, unknown> = {}) => ({ venueId, jobRoleId, ...windowFromNow(), requiredCount: 2, notes: 'SECRET-NOTE-TEXT', ...over });
  const proposalsOf = async (conversationId: string) =>
    (await kit.owner.query(`SELECT id, status, tool FROM core.ai_action_proposal WHERE conversation_id = $1 ORDER BY created_at`, [conversationId])) as Array<{ id: string; status: string; tool: string }>;
  const toolNames = (o: LanguageModelV3CallOptions) => (o.tools ?? []).map((t) => t.name);
  /** A paused turn: the model proposes a draft shift; returns the conversation, the turn and the proposal. */
  const pausedTurn = async () => {
    const scripted = scriptedModel([toolCallParts('propose_action', { tool: 'create_draft_shift', arguments: draft() }, undefined, 'call_propose_1'), textParts('This text must never be produced.')]);
    kit.setModel(scripted.model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Please draft a shift for Saturday.');
    expect(await kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId))).toBe('completed');
    const [proposal] = await proposalsOf(conversationId);
    return { conversationId, turnId: turn.turnId, proposalId: proposal!.id, scripted };
  };

  it('propose_action creates ONE PENDING proposal and pauses the turn: no shift, no further model step', async () => {
    const before = await shiftCount(kit, venueId);
    const { conversationId, turnId, proposalId, scripted } = await pausedTurn();
    expect(scripted.seen).toHaveLength(1); // the loop stopped after the proposing step
    expect(toolNames(scripted.seen[0]!)).toContain('propose_action');
    for (const write of ['create_draft_shift', 'update_draft_shift', 'add_staff_note']) expect(toolNames(scripted.seen[0]!)).not.toContain(write);
    expect(await proposalRow(kit, proposalId)).toMatchObject({ status: 'PENDING', tool: 'create_draft_shift', turn_id: turnId, tool_call_id: 'call_propose_1' });
    expect(await shiftCount(kit, venueId)).toBe(before);
    const row = await turnRow(kit, turnId);
    expect(row.status).toBe('completed');
    expect(row.tool_calls).toEqual([expect.objectContaining({ name: 'propose_action', outcome: 'ok', kind: 'pause' })]);
    expect((await proposalsOf(conversationId)).map((p) => p.status)).toEqual(['PENDING']);
  });

  it('write tool names called directly or through execute_tool are refused: nothing proposed, nothing written', async () => {
    const before = await shiftCount(kit, venueId);
    kit.setModel(
      scriptedModel([
        toolCallParts('create_draft_shift', draft(), undefined, 'w1'),
        toolCallParts('execute_tool', { name: 'create_draft_shift', args: draft() }, undefined, 'w2'),
        toolCallParts('execute_tool', { name: 'add_staff_note', args: { staffProfileId: venueId, body: 'x' } }, undefined, 'w3'),
        toolCallParts('propose_action', { tool: 'send_offers', arguments: {} }, undefined, 'w4'),
        textParts('Done.'),
      ]).model,
    );
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Create the shift now.');
    await kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId));
    const calls = (await turnRow(kit, turn.turnId)).tool_calls as Array<{ name: string; outcome: string }>;
    expect(calls).toContainEqual(expect.objectContaining({ name: 'create_draft_shift', outcome: 'denied' }));
    expect(calls.filter((c) => c.name === 'unavailable_tool' && c.outcome === 'unknown_tool')).toHaveLength(2);
    expect(calls).toContainEqual(expect.objectContaining({ name: 'propose_action', outcome: 'invalid_input' }));
    expect(await proposalsOf(conversationId)).toEqual([]);
    expect(await shiftCount(kit, venueId)).toBe(before);
  });

  it('a user without schedule.create / staff.edit is never offered propose_action', async () => {
    const narrowOrg = await kit.factory.createOrganisation('w5-narrow');
    await kit.owner.query(`INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true)`, [narrowOrg.id]);
    const ceo = await kit.factory.createCeo(narrowOrg, { permissions: ['ai.use', 'schedule.view'] });
    const token = await kit.factory.login(ceo);
    const scripted = scriptedModel([toolCallParts('propose_action', { tool: 'create_draft_shift', arguments: {} }), textParts('ok')]);
    kit.setModel(scripted.model);
    const conversationId = await newConversation(kit, token);
    const turn = await ask(kit, token, conversationId, 'Draft a shift.');
    await kit.runner.run(jobFor(ceo, conversationId, turn.turnId));
    expect(toolNames(scripted.seen[0]!)).not.toContain('propose_action');
    expect((await turnRow(kit, turn.turnId)).tool_calls).toEqual([expect.objectContaining({ name: 'propose_action', outcome: 'denied' })]);
    expect(await proposalsOf(conversationId)).toEqual([]);
  });

  it("the executor (the approval transaction itself) cannot apply another organisation user's proposal, nor a decided one", async () => {
    // The executor IS the approve transaction (PENDING → APPROVED → apply → EXECUTED, as the owner) and only the
    // proposal service's approve path calls it (static test). Here: another organisation's CEO is refused by RLS, and a
    // proposal that was already decided can never be applied again.
    const { proposalId } = await pausedTurn();
    const before = await shiftCount(kit, venueId);
    const executor = kit.moduleRef.get(AiProposalExecutorService);
    const { TenantContextService } = await import('../../engine/core-modules/tenant/tenant-context.service');
    const tenant = kit.moduleRef.get(TenantContextService);
    const other = await aiOrganisation(kit, 'w5-other');
    const run = (who: Parameters<typeof ctxOf>[0]) =>
      tenant.runInWorkspaceContext(ctxOf(who), (m) => executor.executeApproved(m, ctxOf(who), proposalId, draft(), { impact: 'normal', affectedCount: 2, reason: null, editedFields: [] }));
    await expect(run(other.ceo)).rejects.toThrow();
    expect(await shiftCount(kit, venueId)).toBe(before);
    expect((await proposalRow(kit, proposalId)).status).toBe('PENDING');
    expect((await kit.http().post(`/rest/v1/ai/proposals/${proposalId}/reject`).set(bearer(org.token)).send({ reason: 'No thanks' })).status).toBe(200);
    await expect(run(org.ceo)).rejects.toThrow();
    expect(await shiftCount(kit, venueId)).toBe(before);
    expect((await proposalRow(kit, proposalId)).status).toBe('REJECTED');
  });

  it('approve → the shift is created once; a continuation turn sees ONLY the server-written result and answers', async () => {
    const { conversationId, turnId, proposalId } = await pausedTurn();
    const before = await shiftCount(kit, venueId);
    const res = await kit.http().post(`/rest/v1/ai/proposals/${proposalId}/approve`).set(bearer(await kit.factory.login(org.ceo))).send({});
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ id: proposalId, status: 'EXECUTED' });
    expect(await shiftCount(kit, venueId)).toBe(before + 1);
    const continuationTurnId = res.body.continuationTurnId as string;
    expect(continuationTurnId).toEqual(expect.any(String));
    const [cont] = await kit.owner.query(`SELECT status, request_message_id, continues_turn_id, continuation_ref FROM core.ai_message WHERE id = $1`, [continuationTurnId]);
    expect(cont).toEqual({ status: 'queued', request_message_id: null, continues_turn_id: turnId, continuation_ref: proposalId });

    const scripted = scriptedModel([textParts('The draft shift is ready for you to review.')]);
    kit.setModel(scripted.model);
    expect(await kit.runner.run(jobFor(org.ceo, conversationId, continuationTurnId))).toBe('completed');
    const prompt = scripted.seen[0]!.prompt;
    const last = prompt[prompt.length - 1]!;
    expect(last.role).toBe('tool');
    const result = JSON.stringify(last);
    expect(result).toContain(proposalId);
    expect(result).toContain('EXECUTED');
    const [{ result_entity_id }] = await kit.owner.query(`SELECT result_entity_id FROM core.ai_action_proposal WHERE id = $1`, [proposalId]);
    expect(result).toContain(result_entity_id);
    expect(JSON.stringify(prompt)).not.toContain('SECRET-NOTE-TEXT'); // never an argument value
    expect(await turnRow(kit, continuationTurnId)).toMatchObject({ status: 'completed', content: 'The draft shift is ready for you to review.' });
    // One continuation per proposal: a second decision is refused and starts nothing.
    expect((await kit.http().post(`/rest/v1/ai/proposals/${proposalId}/approve`).set(bearer(org.token)).send({})).status).toBe(409);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE continuation_ref = $1`, [proposalId]))[0].n).toBe(1);
  });

  it('reject → nothing is written; the continuation sees REJECTED', async () => {
    const { conversationId, proposalId } = await pausedTurn();
    const before = await shiftCount(kit, venueId);
    const res = await kit.http().post(`/rest/v1/ai/proposals/${proposalId}/reject`).set(bearer(org.token)).send({ reason: 'Not this week' });
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ status: 'REJECTED' });
    expect(await shiftCount(kit, venueId)).toBe(before);
    const scripted = scriptedModel([textParts('Understood, nothing was changed.')]);
    kit.setModel(scripted.model);
    expect(await kit.runner.run(jobFor(org.ceo, conversationId, res.body.continuationTurnId))).toBe('completed');
    const last = JSON.stringify(scripted.seen[0]!.prompt.at(-1));
    expect(last).toContain('REJECTED');
    expect(last).not.toContain('Not this week'); // the decider's reason is not sent to the model
  });

  it('no continuation when the paused turn is no longer the latest message (the user moved on)', async () => {
    const { conversationId, proposalId } = await pausedTurn();
    kit.setModel(scriptedModel([textParts('Another answer.')]).model);
    const next = await ask(kit, org.token, conversationId, 'Something else instead.');
    await kit.runner.run(jobFor(org.ceo, conversationId, next.turnId));
    const res = await kit.http().post(`/rest/v1/ai/proposals/${proposalId}/reject`).set(bearer(org.token)).send({ reason: 'Moved on' });
    expect(res.status).toBe(200);
    expect(res.body.continuationTurnId).toBeNull();
  });
});

import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { venueAndRole } from './helpers/ai-proposal-fixtures';
import { execCall, scriptedModel, textParts } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, newConversation, readSse, turnRow } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * Batch 3 S2 — record references on the real AppModule + Worker step loop (crewflow_app, FORCE RLS, Redis), scripted
 * models only. A `[[record:<type>:<uuid>]]` survives in the STORED content (checkpoint, terminal row, `done`, detail) only
 * when a tool result of the same turn showed that uuid as that type, under the caller's own RLS and permissions:
 *   - the caller's own shift returned by find_shifts → kept;
 *   - another organisation's real shift, an invented uuid, the right uuid with the wrong type, a malformed token → removed
 *     (no existence leak: a foreign id and an invented one are treated identically);
 *   - an id seen only in an EARLIER turn → removed;
 *   - the label is never stored: the token is an id only.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI S2: validated record references (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;

  beforeAll(async () => {
    kit = await bootAiKit();
  });
  afterEach(() => kit.setModel(null));
  afterAll(async () => {
    await kit?.close();
  });

  const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  async function openShift(who: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): Promise<{ shiftId: string; venueId: string }> {
    const { venueId, jobRoleId } = await venueAndRole(kit, who);
    const [row] = await kit.owner.query(
      `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by, workspace_id)
       VALUES ($1, $2, $3, now() + interval '30 hours', now() + interval '38 hours', 0, 2, 1500, 'open', $4, $5) RETURNING id`,
      [who.organisationId, venueId, jobRoleId, who.userId, who.workspaceId],
    );
    return { shiftId: row.id as string, venueId };
  }

  it('keeps only references a tool of THIS turn returned as that type; strips foreign, invented, mistyped and malformed ones', async () => {
    const org = await aiOrganisation(kit, 's2-refs');
    const mine = await openShift(org.ceo);
    const foreignOrg = await aiOrganisation(kit, 's2-foreign');
    const foreign = await openShift(foreignOrg.ceo);
    const invented = randomUUID();
    const answer = [
      `Mine: [[record:shift:${mine.shiftId}]].`,
      `Foreign: [[record:shift:${foreign.shiftId}]].`,
      `Invented: [[record:shift:${invented}]].`,
      `Wrong type: [[record:venue:${mine.shiftId}]].`,
      `Venue never returned: [[record:venue:${mine.venueId}]].`,
      'Malformed: [[record:shift:Pier Hall]].',
    ].join(' ');
    kit.setModel(scriptedModel([execCall('find_shifts', { from: day(0), to: day(6), limit: 25 }), textParts(answer)]).model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Which shifts are open this week?');
    expect(await kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId))).toBe('completed');

    const expected = [
      `Mine: [[record:shift:${mine.shiftId}]].`,
      'Foreign: .',
      'Invented: .',
      'Wrong type: .',
      'Venue never returned: .',
      'Malformed: .',
    ].join(' ');
    const row = await turnRow(kit, turn.turnId);
    expect(row.content).toBe(expected);
    expect(JSON.stringify(row)).not.toContain(foreign.shiftId);
    expect(JSON.stringify(row)).not.toContain(invented);
    // The find_shifts call happened before any text: its offset (0) stays omitted.
    expect(row.tool_calls).toEqual([expect.objectContaining({ name: 'find_shifts', outcome: 'ok' })]);

    const detail = await kit.http().get(`/rest/v1/ai/conversations/${conversationId}`).set(bearer(org.token));
    const msg = (detail.body.messages as Array<{ id: string; content: string }>).find((x) => x.id === turn.turnId)!;
    expect(msg.content).toBe(expected);

    const sse = await readSse(kit, org.token, conversationId, turn.turnId);
    const done = sse.events.find((e) => e.event === 'done');
    expect(done?.data.content).toBe(expected);
  });

  it('an id seen only in an EARLIER turn is removed (same turn only)', async () => {
    const org = await aiOrganisation(kit, 's2-same-turn');
    const mine = await openShift(org.ceo);
    const conversationId = await newConversation(kit, org.token);
    kit.setModel(scriptedModel([execCall('find_shifts', { from: day(0), to: day(6) }), textParts(`Found [[record:shift:${mine.shiftId}]].`)]).model);
    const first = await ask(kit, org.token, conversationId, 'Open shifts?');
    await kit.runner.run(jobFor(org.ceo, conversationId, first.turnId));
    expect((await turnRow(kit, first.turnId)).content).toBe(`Found [[record:shift:${mine.shiftId}]].`);

    kit.setModel(scriptedModel([textParts(`Again: [[record:shift:${mine.shiftId}]]`)]).model);
    const second = await ask(kit, org.token, conversationId, 'Remind me.');
    await kit.runner.run(jobFor(org.ceo, conversationId, second.turnId));
    expect((await turnRow(kit, second.turnId)).content).toBe('Again: ');
  });
});

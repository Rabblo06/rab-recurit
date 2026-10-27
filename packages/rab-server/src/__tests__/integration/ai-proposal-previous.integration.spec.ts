import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { ctxOf, proposeOk, runningTurn, venueAndRole, windowFromNow, withRevoked } from './helpers/ai-proposal-fixtures';
import { AiKit, aiOrganisation, bearer, bootAiKit, manager } from './helpers/ai-test-kit';

/**
 * Batch 3 S6 — `previousValue` on `AiProposalFieldView` (the card's before → after diff), on the real AppModule
 * (crewflow_app, FORCE RLS). The value is the target's state when the proposal was made, read at view time under the
 * viewer's own permissions and shown only while the record still matches the proposal's snapshot hash:
 *   - update_draft_shift: every proposed field carries the draft's value at proposal time;
 *   - create_draft_shift / add_staff_note: nothing to compare → no previousValue anywhere;
 *   - the draft edited since (hash mismatch) → no previousValue (and approval would be 409 stale);
 *   - the viewer lost schedule.view (or the write flag) → no previousValue (never a value they cannot read);
 *   - another user of the organisation → the uniform 404 for the whole list.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI S6: previousValue on proposal fields (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let org: Awaited<ReturnType<typeof aiOrganisation>>;
  let venueId: string;
  let jobRoleId: string;

  beforeAll(async () => {
    kit = await bootAiKit();
    org = await aiOrganisation(kit, 's6-previous');
    ({ venueId, jobRoleId } = await venueAndRole(kit, org.ceo));
  });
  afterAll(async () => {
    await kit?.close();
  });

  type Field = { key: string; value: unknown; previousValue?: unknown };
  const cards = async (conversationId: string, token = org.token) => kit.http().get(`/rest/v1/ai/conversations/${conversationId}/proposals`).set(bearer(token));
  const fieldsOf = async (conversationId: string, proposalId: string, token = org.token) =>
    ((await cards(conversationId, token)).body as Array<{ id: string; fields: Field[] }>).find((p) => p.id === proposalId)!.fields;
  const newDraft = async (notes = 'Original notes') => {
    const window = windowFromNow(6);
    const shift = await kit.moduleRef.get(SchedulingService).create(ctxOf(org.ceo), { venueId, jobRoleId, ...window, breakMinutes: 15, requiredCount: 2, notes } as never);
    return { id: shift.id as string, window };
  };

  it('update_draft_shift: each proposed field shows the draft value at proposal time beside the proposed value', async () => {
    const turn = await runningTurn(kit, org.ceo);
    const draft = await newDraft();
    const proposed = windowFromNow(7);
    const id = await proposeOk(kit, turn, 'update_draft_shift', { shiftId: draft.id, requiredCount: 4, notes: 'New notes', breakMinutes: 30, ...proposed });
    const fields = await fieldsOf(turn.conversationId, id);
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.requiredCount).toMatchObject({ value: 4, previousValue: 2 });
    expect(byKey.notes).toMatchObject({ value: 'New notes', previousValue: 'Original notes' });
    expect(byKey.breakMinutes).toMatchObject({ value: 30, previousValue: 15 });
    expect(new Date(byKey.startsAt!.previousValue as string).toISOString()).toBe(new Date(draft.window.startsAt).toISOString());
    expect(new Date(byKey.endsAt!.previousValue as string).toISOString()).toBe(new Date(draft.window.endsAt).toISOString());
    expect(byKey.startsAt!.value).toBe(proposed.startsAt);
  });

  it('create_draft_shift and add_staff_note have nothing to compare: no previousValue on any field', async () => {
    const turn = await runningTurn(kit, org.ceo);
    const create = await proposeOk(kit, turn, 'create_draft_shift', { venueId, jobRoleId, ...windowFromNow(8), requiredCount: 2, notes: 'n' });
    const staff = await kit.factory.createStaff({ id: org.orgId }, { owner: org.ceo, label: 's6-note' });
    const note = await proposeOk(kit, turn, 'add_staff_note', { staffProfileId: staff.profileId, body: `Note ${randomUUID()}` });
    for (const id of [create, note]) for (const f of await fieldsOf(turn.conversationId, id)) expect(f).not.toHaveProperty('previousValue');
  });

  it('the draft changed since the proposal (snapshot hash differs): no previousValue (never a newer value shown as the old one)', async () => {
    const turn = await runningTurn(kit, org.ceo);
    const draft = await newDraft();
    const id = await proposeOk(kit, turn, 'update_draft_shift', { shiftId: draft.id, requiredCount: 5 });
    expect((await fieldsOf(turn.conversationId, id)).find((f) => f.key === 'requiredCount')).toMatchObject({ previousValue: 2 });
    await kit.moduleRef.get(SchedulingService).updateDraft(ctxOf(org.ceo), draft.id, { requiredCount: 3 });
    for (const f of await fieldsOf(turn.conversationId, id)) expect(f).not.toHaveProperty('previousValue');
  });

  it('abuse: a viewer without schedule.view (or without the write flag) gets the card but no previousValue', async () => {
    const turn = await runningTurn(kit, org.ceo);
    const draft = await newDraft('Secret original notes');
    const id = await proposeOk(kit, turn, 'update_draft_shift', { shiftId: draft.id, notes: 'Replacement' });
    for (const flag of ['schedule.view', 'schedule.create']) {
      const fields = await withRevoked(kit, org.ceo, flag, async () => {
        const token = await kit.factory.login(org.ceo);
        const res = await cards(turn.conversationId, token);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('Secret original notes');
        return (res.body as Array<{ id: string; fields: Field[] }>).find((p) => p.id === id)!.fields;
      });
      for (const f of fields) expect(f).not.toHaveProperty('previousValue');
    }
    // With both flags back (a fresh session: the override bumped the security version), the value is shown again.
    expect((await fieldsOf(turn.conversationId, id, await kit.factory.login(org.ceo))).find((f) => f.key === 'notes')).toMatchObject({ previousValue: 'Secret original notes' });
  });

  it('abuse: another user of the organisation and another organisation get the uniform 404 for the list (no value leaks)', async () => {
    const turn = await runningTurn(kit, org.ceo);
    const draft = await newDraft('Owner only notes');
    await proposeOk(kit, turn, 'update_draft_shift', { shiftId: draft.id, notes: 'x' });
    const im = await manager(kit, org.orgId, { initial: true });
    const foreign = await aiOrganisation(kit, 's6-foreign');
    for (const token of [im.token, foreign.token]) {
      const res = await cards(turn.conversationId, token);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Owner only notes');
    }
  });
});

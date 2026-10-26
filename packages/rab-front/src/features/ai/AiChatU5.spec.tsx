import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../shared/api';
import { AiChatProvider } from './AiChatProvider';
import AiChatPanel from './AiChatPanel';
import { validateFormValue } from './AiInputCard';
import { sanitiseCardEvent, type AiChatStreamEvent, type AiStreamOptions } from './aiStream';

/**
 * U5 (owner-approved 2026-10-26): approval cards (only proposed fields editable, only changed ones sent, ⌘/Ctrl+↵,
 * reject with a reason, high impact = reason + step-up, previousValue diff only when present, stale/expired handling) and
 * question/form cards (length-bounded free text, schema validation, only asked keys sent), attached by turn id; 404 on the
 * inputs route = no cards, any other failure = an error state; "Draft a rota" gated on writeTools + features.approvals.
 */
jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), delete: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const mockStreams: Array<{ opts: AiStreamOptions }> = [];
jest.mock('./aiStream', () => {
  const actual = jest.requireActual('./aiStream');
  return {
    ...actual,
    openAiStream: jest.fn((opts: AiStreamOptions) => {
      mockStreams.push({ opts });
      return { stop: jest.fn(), lastEventId: () => null };
    }),
  };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const CONV = '0b6f5d1a-1111-4222-8333-444455556666';
const TURN = '7c1e2a3b-1111-4222-8333-444455556666';
const PROP = '9d9d9d9d-1111-4222-8333-444455556666';
const REQ = '8e8e8e8e-1111-4222-8333-444455556666';
const SHIFT = '5a0e0c4e-3333-4222-8333-444455556666';
const AT = '2026-10-25T10:00:00.000Z';
const BASE = { available: true, reason: null, limits: { maxInputChars: 4000, userRatePerMinute: 10, orgDailyTokenBudget: 200000 }, usage: { day: '2026-10-25', tokensUsedOrReserved: 0 } };

const proposal = (over: Record<string, unknown> = {}) => ({
  id: PROP,
  conversationId: CONV,
  turnId: TURN,
  groupId: null,
  origin: 'chat',
  tool: 'update_draft_shift',
  summary: 'Move the Saturday draft shift to 19:00 and add one place.',
  status: 'PENDING',
  impact: 'normal',
  affectedCount: 0,
  target: { type: 'shift', id: SHIFT, label: null },
  fields: [
    { key: 'startsAt', label: 'Start', type: 'datetime', value: '2026-10-31T19:00:00.000Z', editable: true, previousValue: '2026-10-31T18:00:00.000Z' },
    { key: 'requiredCount', label: 'Places', type: 'integer', value: 3, editable: true, min: 1, max: 25, previousValue: 2 },
    { key: 'notes', label: 'Notes', type: 'text', value: 'Bring black shirts', editable: false },
  ],
  requiresStepUp: false,
  requiresReason: false,
  expiresAt: '2026-10-25T10:15:00.000Z',
  serverNow: '2026-10-25T10:01:00.000Z',
  createdAt: AT,
  decidedAt: null,
  failureCode: null,
  result: null,
  ...over,
});
const question = (over: Record<string, unknown> = {}) => ({
  requestId: REQ,
  turnId: TURN,
  inputKind: 'question',
  state: 'awaiting_input',
  question: { text: 'Only include staff who worked at this venue before?', options: ['Yes, past staff only', 'No, anyone with the role'], allowFreeText: true },
  form: null,
  expiresAt: '2026-10-25T10:15:00.000Z',
  serverNow: '2026-10-25T10:01:00.000Z',
  ...over,
});
const FORM = {
  title: 'Shift details',
  fields: [
    { key: 'role', label: 'Role', type: 'select', options: ['Bartender', 'Server'], required: true },
    { key: 'places', label: 'Places', type: 'number', options: null, required: true },
    { key: 'date', label: 'Date', type: 'date', options: null, required: false },
  ],
};

let proposals: unknown = [];
let inputs: unknown = [];
let inputsStatus = 200;
let proposalsStatus = 200;
let roles: string[] = ['manager'];
let features: Record<string, boolean> = { approvals: true };
let capabilities: unknown = null;
let availabilityExtra: Record<string, unknown> = {};
let decision: (url: string, body: unknown) => Promise<unknown> = () => Promise.resolve({ data: { proposal: proposal({ status: 'EXECUTED', result: { entityType: 'shift', entityId: SHIFT } }), continuationTurnId: null } });

function renderChat() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AiChatProvider workspaceId="ws-a">
          <AiChatPanel surface="page" />
        </AiChatProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const latest = () => mockStreams[mockStreams.length - 1]!;
const emit = (event: AiChatStreamEvent) => act(() => latest().opts.onEvent(event));
const reject404 = () => Promise.reject({ isAxiosError: true, response: { status: 404, data: { statusCode: 404 } } });
const httpError = (status: number, data: object) => Promise.reject({ isAxiosError: true, response: { status, data } });
let details: Record<string, { conversation: object; messages: Array<Record<string, unknown>> }> = {};

beforeEach(() => {
  mockStreams.length = 0;
  proposals = [];
  inputs = [];
  inputsStatus = 200;
  proposalsStatus = 200;
  roles = ['manager'];
  features = { approvals: true };
  capabilities = null;
  availabilityExtra = {};
  details = {};
  // Like the server: the decided state is what a re-read returns afterwards.
  decision = () => {
    const done = proposal({ status: 'EXECUTED', result: { entityType: 'shift', entityId: SHIFT } });
    proposals = [done];
    return Promise.resolve({ data: { proposal: done, continuationTurnId: null } });
  };
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/ai/availability') return Promise.resolve({ data: { ...BASE, ...availabilityExtra } });
    if (url === '/ai/conversations') return Promise.resolve({ data: { data: [], nextCursor: null } });
    if (url === '/ai/skills') return Promise.resolve({ data: [] });
    if (url === '/auth/me') return Promise.resolve({ data: { roles } });
    if (url === '/ai/settings') return Promise.resolve({ data: { features } });
    if (url === '/ai/capabilities') return capabilities ? Promise.resolve({ data: capabilities }) : reject404();
    if (url === `/ai/conversations/${CONV}/proposals`) return proposalsStatus === 200 ? Promise.resolve({ data: proposals }) : httpError(proposalsStatus, { statusCode: proposalsStatus });
    if (url === `/ai/conversations/${CONV}/inputs`) return inputsStatus === 200 ? Promise.resolve({ data: inputs }) : httpError(inputsStatus, { statusCode: inputsStatus });
    if (url === `/shifts/${SHIFT}`) return Promise.resolve({ data: { id: SHIFT, startsAt: '2026-10-31T18:00:00.000Z' } });
    const d = details[url.replace('/ai/conversations/', '')];
    if (d) return Promise.resolve({ data: JSON.parse(JSON.stringify(d)) });
    return reject404();
  });
  post.mockImplementation((url: string, body: { title?: string; content?: string }) => {
    if (url === '/ai/conversations') {
      details[CONV] = { conversation: { id: CONV, title: body.title, messageCount: 0, lastMessageAt: AT, createdAt: AT }, messages: [] };
      return Promise.resolve({ data: details[CONV]!.conversation });
    }
    if (url === `/ai/conversations/${CONV}/messages`) {
      details[CONV]!.messages = [
        { id: 'u1', role: 'user', status: 'sent', content: body.content, errorCode: null, toolCalls: [], createdAt: AT, completedAt: null },
        { id: TURN, role: 'assistant', status: 'queued', content: '', errorCode: null, toolCalls: [], createdAt: AT, completedAt: null },
      ];
      return Promise.resolve({ data: { conversationId: CONV, userMessageId: 'u1', turnId: TURN, status: 'queued', replayed: false } });
    }
    if (url.startsWith('/ai/proposals/') || url.includes('/inputs/')) return decision(url, body);
    return reject404();
  });
});

/** One question whose answer ends `completed` (5b: a proposal ends the turn) or pauses (5c: `waiting`). */
async function askAndEnd(how: 'done' | 'waiting' = 'done') {
  renderChat();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message Crewflow AI' }), { target: { value: 'Move Saturday to 19:00 and add a place.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(mockStreams).toHaveLength(1));
  if (how === 'done') {
    details[CONV]!.messages[1] = { ...details[CONV]!.messages[1], status: 'completed', completedAt: AT };
    emit({ type: 'proposal', turnId: TURN, proposalId: PROP });
    emit({ type: 'done', turnId: TURN, status: 'completed', errorCode: null, content: '' });
  } else {
    details[CONV]!.messages[1] = { ...details[CONV]!.messages[1], status: 'waiting_for_input' };
    emit({ type: 'input_request', turnId: TURN, requestId: REQ, inputKind: 'question' });
    emit({ type: 'waiting', turnId: TURN });
  }
}
const card = (name: RegExp | string) => screen.findByRole('region', { name });
const decisions = () => post.mock.calls.filter(([u]) => String(u).startsWith('/ai/proposals/'));

describe('approval cards', () => {
  it('attach to their answer; only proposed editable fields are inputs; the diff shows previousValue; only CHANGED fields are sent', async () => {
    proposals = [proposal()];
    await askAndEnd();
    const c = await card('Update a draft shift');
    expect(within(c).getByText('Move the Saturday draft shift to 19:00 and add one place.')).toBeInTheDocument();
    expect(within(c).getByText('Needs your approval')).toBeInTheDocument();
    expect(within(c).getByLabelText('Was 2')).toHaveTextContent('2');
    expect(within(c).getByLabelText('Places')).toHaveValue(3);
    expect(within(c).queryByLabelText('Notes')).not.toBeInTheDocument(); // not editable → plain text
    expect(within(c).getByText('Bring black shirts')).toBeInTheDocument();
    fireEvent.change(within(c).getByLabelText('Places'), { target: { value: '4' } });
    fireEvent.click(within(c).getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toEqual([`/ai/proposals/${PROP}/approve`, { edits: { requiredCount: 4 } }]);
    expect(await within(c).findByText('Done')).toBeInTheDocument();
  });

  it('S6: a datetime previousValue that is the same INSTANT in another string form is not a change (no diff)', async () => {
    proposals = [proposal({ fields: [{ key: 'startsAt', label: 'Start', type: 'datetime', value: '2026-10-31T19:00:00.000Z', editable: true, previousValue: '2026-10-31T19:00:00Z' }] })];
    await askAndEnd();
    const c = await card('Update a draft shift');
    expect(c.querySelector('del')).toBeNull();
  });

  it('without previousValue there is no diff; nothing changed = no edits key; Ctrl+Enter approves', async () => {
    proposals = [proposal({ fields: [{ key: 'requiredCount', label: 'Places', type: 'integer', value: 3, editable: true, min: 1, max: 25 }] })];
    await askAndEnd();
    const c = await card('Update a draft shift');
    expect(c.querySelector('del')).toBeNull();
    fireEvent.keyDown(within(c).getByLabelText('Places'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]![1]).toEqual({});
  });

  it('an out-of-range number blocks Approve and is marked invalid', async () => {
    proposals = [proposal()];
    await askAndEnd();
    const c = await card('Update a draft shift');
    fireEvent.change(within(c).getByLabelText('Places'), { target: { value: '99' } });
    expect(within(c).getByLabelText('Places')).toHaveAttribute('aria-invalid', 'true');
    expect(within(c).getByRole('button', { name: /^Approve/ })).toBeDisabled();
  });

  it('reject needs a reason (3+ characters) and sends only the reason', async () => {
    proposals = [proposal()];
    decision = () => {
      proposals = [proposal({ status: 'REJECTED' })];
      return Promise.resolve({ data: { proposal: proposal({ status: 'REJECTED' }), continuationTurnId: TURN } });
    };
    await askAndEnd();
    const c = await card('Update a draft shift');
    fireEvent.click(within(c).getByRole('button', { name: 'Reject' }));
    const why = within(c).getByLabelText('Tell Crewflow why');
    const send = within(c).getAllByRole('button', { name: 'Reject' }).at(-1)!;
    fireEvent.change(why, { target: { value: 'no' } });
    expect(send).toBeDisabled();
    fireEvent.change(why, { target: { value: 'Keep 18:00' } });
    fireEvent.click(send);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toEqual([`/ai/proposals/${PROP}/reject`, { reason: 'Keep 18:00' }]);
    expect(await within(c).findByText('Rejected')).toBeInTheDocument();
  });

  it('high impact: a reason is required and sent; a refused step-up is explained and nothing is applied', async () => {
    proposals = [proposal({ impact: 'high', affectedCount: 14, requiresStepUp: true, requiresReason: true })];
    decision = () => httpError(403, { statusCode: 403, code: 'STEP_UP_REQUIRED' });
    await askAndEnd();
    const c = await card('Update a draft shift');
    expect(within(c).getByText(/affects 14 people/)).toBeInTheDocument();
    const approve = within(c).getByRole('button', { name: /^Approve/ });
    expect(approve).toBeDisabled();
    fireEvent.change(within(c).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Weekend event' } });
    fireEvent.click(approve);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]![1]).toEqual({ reason: 'Weekend event' });
    expect(await within(c).findByRole('alert')).toHaveTextContent('Not approved: your identity was not confirmed.');
    expect(within(c).getByText('Needs your approval')).toBeInTheDocument();
  });

  it('a stale proposal shows the server’s AI_PROPOSAL_STALE text and the cards are re-read', async () => {
    proposals = [proposal()];
    decision = () => httpError(409, { statusCode: 409, code: 'AI_PROPOSAL_STALE', message: 'ignored' });
    await askAndEnd();
    const c = await card('Update a draft shift');
    const reads = () => get.mock.calls.filter(([u]) => u === `/ai/conversations/${CONV}/proposals`).length;
    const before = reads();
    fireEvent.click(within(c).getByRole('button', { name: /^Approve/ }));
    expect(await within(c).findByRole('alert')).toHaveTextContent('The record changed after this suggestion was made, so it was not applied.');
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('expired (by status or by the server clock) is read-only', async () => {
    proposals = [proposal({ id: PROP, status: 'EXPIRED' }), proposal({ id: '9d9d9d9d-2222-4222-8333-444455556666', serverNow: '2026-10-25T10:16:00.000Z' })];
    await askAndEnd();
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Update a draft shift' })).toHaveLength(2));
    for (const c of screen.getAllByRole('region', { name: 'Update a draft shift' })) {
      expect(within(c).getAllByText('Expired').length).toBeGreaterThan(0);
      expect(within(c).queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
      expect(within(c).queryByRole('textbox')).not.toBeInTheDocument();
    }
  });

  it('a FAILED proposal says why in fixed words', async () => {
    proposals = [proposal({ status: 'FAILED', failureCode: 'not_permitted' })];
    await askAndEnd();
    const c = await card('Update a draft shift');
    expect(within(c).getByText('You no longer have permission for this change, so it was not applied.')).toBeInTheDocument();
  });
});

describe('question and form cards', () => {
  it('a question: an option is sent as the answer; free text is length-bounded', async () => {
    inputs = [question()];
    decision = () => Promise.resolve({ data: {} });
    await askAndEnd('waiting');
    const c = await card('A question for you');
    expect(screen.getByText('Waiting for your answer below.')).toBeInTheDocument();
    expect(within(c).getByLabelText('Your own answer')).toHaveAttribute('maxLength', '4000');
    fireEvent.click(within(c).getByRole('button', { name: 'Yes, past staff only' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/inputs/${REQ}/answer`, { answer: 'Yes, past staff only' }));
    expect(await within(c).findAllByText('Answered')).not.toHaveLength(0);
  });

  it('a form validates against the asked schema and sends only the asked keys', async () => {
    inputs = [question({ inputKind: 'form', question: null, form: FORM })];
    decision = () => Promise.resolve({ data: {} });
    await askAndEnd('waiting');
    const c = await card('Shift details');
    fireEvent.click(within(c).getByRole('button', { name: 'Send answers' }));
    expect(within(c).getAllByText('Required.')).toHaveLength(2);
    expect(post.mock.calls.some(([u]) => String(u).includes('/inputs/'))).toBe(false);
    fireEvent.change(within(c).getByLabelText(/^Role/), { target: { value: 'Server' } });
    fireEvent.change(within(c).getByLabelText(/^Places/), { target: { value: '2' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/inputs/${REQ}/answer`, { answer: { role: 'Server', places: 2, date: null } }));
  });

  it('S7 refusals: AI_INPUT_INVALID marks the fields named in issues; AI_INPUT_EXPIRED is explained and the cards re-read', async () => {
    inputs = [question({ inputKind: 'form', question: null, form: FORM })];
    decision = () => httpError(400, { statusCode: 400, code: 'AI_INPUT_INVALID', issues: ['answer.places'] });
    await askAndEnd('waiting');
    const c = await card('Shift details');
    fireEvent.change(within(c).getByLabelText(/^Role/), { target: { value: 'Server' } });
    fireEvent.change(within(c).getByLabelText(/^Places/), { target: { value: '200' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Send answers' }));
    expect(await within(c).findByRole('alert')).toHaveTextContent('That answer does not fit what was asked.');
    expect(within(c).getByLabelText(/^Places/)).toHaveAttribute('aria-invalid', 'true');
    decision = () => httpError(409, { statusCode: 409, code: 'AI_INPUT_EXPIRED' });
    const reads = () => get.mock.calls.filter(([u]) => u === `/ai/conversations/${CONV}/inputs`).length;
    const before = reads();
    fireEvent.change(within(c).getByLabelText(/^Places/), { target: { value: '2' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Send answers' }));
    expect(await within(c).findByText('This question has expired. Ask again if you still need it.')).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('a paused turn (input_request → waiting, no done) shows no spinner and no reconnect', async () => {
    inputs = [question()];
    await askAndEnd('waiting');
    await card('A question for you');
    const answer = screen.getByRole('article', { name: 'Assistant answer' });
    expect(answer).toHaveAttribute('aria-busy', 'false');
    expect(answer.querySelector('.ai-spin')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop response' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });

  it('answered and expired cards are read-only', async () => {
    inputs = [question({ state: 'answered' }), question({ requestId: '8e8e8e8e-2222-4222-8333-444455556666', state: 'expired' })];
    await askAndEnd('waiting');
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'A question for you' })).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Yes, past staff only' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Your own answer')).not.toBeInTheDocument();
  });

  it('inputs route 404 = no cards and no error; a proposals 500 = an error state with Try again', async () => {
    inputsStatus = 404;
    proposalsStatus = 500;
    await askAndEnd();
    expect(await screen.findByText(/Approval and question cards could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'A question for you' })).not.toBeInTheDocument();
    proposalsStatus = 200;
    proposals = [proposal()];
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await card('Update a draft shift')).toBeInTheDocument();
  });

  it('form value validation (unit)', () => {
    const [role, places, date] = FORM.fields as Parameters<typeof validateFormValue>[0][];
    expect(validateFormValue(role!, 'Chef', 100)).toEqual({ error: 'Choose one of the options.' });
    expect(validateFormValue(places!, 'two', 100)).toEqual({ error: 'Enter a number.' });
    expect(validateFormValue(date!, '', 100)).toEqual({ value: null });
    expect(validateFormValue(date!, '2026-13-45', 100)).toEqual({ error: 'Enter a date.' });
    expect(validateFormValue({ key: 'n', label: 'Note', type: 'text', options: null, required: false }, 'x'.repeat(11), 10)).toEqual({ error: 'At most 10 characters.' });
  });
});

describe('stream signals (ids only)', () => {
  it('a proposal signal keeps ids only; bad ids and other turns are dropped; waiting is recognised', () => {
    expect(sanitiseCardEvent({ type: 'proposal', turnId: TURN, proposalId: PROP, summary: '<img src=x>' }, TURN)).toEqual({ type: 'proposal', turnId: TURN, proposalId: PROP });
    expect(sanitiseCardEvent({ type: 'proposal', turnId: TURN, proposalId: 'x' }, TURN)).toBeNull();
    expect(sanitiseCardEvent({ type: 'proposal', turnId: 'other', proposalId: PROP }, TURN)).toBeNull();
    expect(sanitiseCardEvent({ type: 'input_request', turnId: TURN, requestId: REQ, inputKind: 'form', form: {} }, TURN)).toEqual({ type: 'input_request', turnId: TURN, requestId: REQ, inputKind: 'form' });
    expect(sanitiseCardEvent({ type: 'waiting', turnId: TURN, partId: 'p' }, TURN)).toEqual({ type: 'waiting', turnId: TURN });
  });
});

describe('"Draft a rota" (writeTools + features.approvals)', () => {
  const WRITE = [{ name: 'create_draft_shift', label: 'Draft shift', summary: 'Creates a draft shift.' }];

  it('U8: with `approvals` in /ai/availability an eligible Initial Manager gets it too (no CEO-only read)', async () => {
    availabilityExtra = { approvals: true };
    capabilities = { tools: [], skills: [], writeTools: WRITE };
    renderChat();
    expect(await screen.findByRole('button', { name: 'Draft a rota' })).toBeInTheDocument();
    expect(get.mock.calls.some(([u]) => u === '/ai/settings')).toBe(false);
  });

  it('U8: `approvals: false` in /ai/availability hides it even for the CEO, without reading /ai/settings', async () => {
    roles = ['ceo'];
    availabilityExtra = { approvals: false };
    capabilities = { tools: [], skills: [], writeTools: WRITE };
    renderChat();
    await screen.findByRole('button', { name: 'See what I can do' });
    expect(screen.queryByRole('button', { name: 'Draft a rota' })).not.toBeInTheDocument();
    expect(get.mock.calls.some(([u]) => u === '/ai/settings')).toBe(false);
  });

  it('shown for the CEO when the server lists the draft-shift WRITE tool and approvals are on', async () => {
    roles = ['ceo'];
    capabilities = { tools: [], skills: [], writeTools: WRITE };
    renderChat();
    expect(await screen.findByRole('button', { name: 'Draft a rota' })).toBeInTheDocument();
  });

  it('hidden when approvals are off, when only a READ list names it, or for someone who cannot read the feature flag', async () => {
    roles = ['ceo'];
    features = { approvals: false };
    capabilities = { tools: [], skills: [], writeTools: WRITE };
    const a = renderChat();
    await screen.findByRole('button', { name: 'See what I can do' });
    await waitFor(() => expect(get.mock.calls.some(([u]) => u === '/ai/settings')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Draft a rota' })).not.toBeInTheDocument();
    a.unmount();
    features = { approvals: true };
    capabilities = { tools: WRITE, skills: [] };
    const b = renderChat();
    await screen.findByRole('button', { name: 'See what I can do' });
    expect(screen.queryByRole('button', { name: 'Draft a rota' })).not.toBeInTheDocument();
    b.unmount();
    roles = ['manager'];
    capabilities = { tools: [], skills: [], writeTools: WRITE };
    renderChat();
    await screen.findByRole('button', { name: 'See what I can do' });
    expect(get.mock.calls.filter(([u]) => u === '/ai/settings')).toHaveLength(2); // only the two CEO renders asked
    expect(screen.queryByRole('button', { name: 'Draft a rota' })).not.toBeInTheDocument();
  });
});

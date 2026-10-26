import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AI_STATE_MESSAGE, type AiStreamEvent } from '@rab/shared';

import { api } from '../../shared/api';
import { TOAST_EVENT } from '../../shared/lib/toast';
import { AiChatProvider } from './AiChatProvider';
import AiChatPanel from './AiChatPanel';
import AiConversationList from './AiConversationList';
import type { AiStreamEnd, AiStreamOptions } from './aiStream';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), delete: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));

interface MockStream { opts: AiStreamOptions; stop: jest.Mock; lastId: string | null }
const mockStreams: MockStream[] = [];
jest.mock('./aiStream', () => ({
  openAiStream: jest.fn((opts: AiStreamOptions) => {
    const entry = { opts, stop: jest.fn(), lastId: opts.lastEventId ?? null };
    mockStreams.push(entry);
    return { stop: entry.stop, lastEventId: () => entry.lastId };
  }),
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const del = api.delete as jest.Mock;
const CONV = '0b6f5d1a-1111-4222-8333-444455556666';
const TURN = '7c1e2a3b-1111-4222-8333-444455556666';
const USER_MSG = '9d8e7f6a-1111-4222-8333-444455556666';
const AVAILABLE = { available: true, reason: null, limits: { maxInputChars: 4000, userRatePerMinute: 6, orgDailyTokenBudget: 200000 }, usage: { day: '2026-10-25', tokensUsedOrReserved: 1171 } };
const conversation = (over: object = {}) => ({ id: CONV, title: 'Which shifts this weekend are unfilled?', messageCount: 0, lastMessageAt: '2026-10-25T10:00:00.000Z', createdAt: '2026-10-25T10:00:00.000Z', ...over });
const httpError = (status: number, data: object) => ({ isAxiosError: true, response: { status, data } });

let availability: unknown = AVAILABLE;
/** The fake server's persisted rows, so a refetch after an event returns what the real API would. */
function serverAppendTurn() {
  const d = details[CONV] as { messages: unknown[] };
  d.messages = [
    { id: USER_MSG, role: 'user', status: 'sent', content: 'Which shifts this weekend are unfilled?', errorCode: null, toolCalls: [], createdAt: '2026-10-25T10:00:00.000Z', completedAt: null },
    { id: TURN, role: 'assistant', status: 'queued', content: '', errorCode: null, toolCalls: [], createdAt: '2026-10-25T10:00:00.000Z', completedAt: null },
  ];
}
function serverFinish(status: string, content: string, errorCode: string | null = null) {
  const d = details[CONV] as { messages: Array<Record<string, unknown>> };
  d.messages = d.messages.map((m) => (m.id === TURN ? { ...m, status, content, errorCode } : m));
}
let details: Record<string, unknown> = {};
let list: unknown = { data: [], nextCursor: null };
function routeGets() {
  get.mockImplementation((url: string) => {
    if (url === '/ai/availability') return Promise.resolve({ data: availability });
    if (url === '/ai/conversations') return Promise.resolve({ data: list });
    const id = url.replace('/ai/conversations/', '');
    if (details[id]) return Promise.resolve({ data: details[id] });
    return Promise.reject(httpError(404, { statusCode: 404, message: 'Not found.' }));
  });
}

function renderChat(withHistory = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiChatProvider workspaceId="ws-a">
        {withHistory && <AiConversationList enabled />}
        <AiChatPanel surface="page" />
      </AiChatProvider>
    </QueryClientProvider>,
  );
}

const latest = () => mockStreams[mockStreams.length - 1]!;
const emit = (event: AiStreamEvent) => act(() => latest().opts.onEvent(event));
const end = (e: AiStreamEnd) => act(() => latest().opts.onEnd(e));

async function ask(text = 'Which shifts this weekend are unfilled?') {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message Crewflow AI' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

beforeEach(() => {
  mockStreams.length = 0;
  availability = AVAILABLE;
  details = {};
  list = { data: [], nextCursor: null };
  get.mockReset();
  post.mockReset();
  del.mockReset();
  routeGets();
  post.mockImplementation((url: string, body: { title?: string }) => {
    if (url === '/ai/conversations') {
      details[CONV] = { conversation: conversation({ title: body.title }), messages: [] };
      return Promise.resolve({ data: conversation({ title: body.title }) });
    }
    if (url === `/ai/conversations/${CONV}/messages`) {
      serverAppendTurn();
      return Promise.resolve({ data: { conversationId: CONV, userMessageId: USER_MSG, turnId: TURN, status: 'queued', replayed: false } });
    }
    return Promise.reject(httpError(404, {}));
  });
});

describe('states from GET /ai/availability', () => {
  it.each([
    ['organisation_disabled', 'The AI assistant is off for your organisation'],
    ['platform_disabled', 'The AI assistant is turned off'],
    ['not_permitted', 'The AI assistant is not available to you'],
    ['no_workspace', 'The AI assistant needs a workspace'],
  ])('%s → its own message, no composer, no history request', async (reason, text) => {
    availability = { available: false, reason, limits: AVAILABLE.limits, usage: null };
    renderChat();
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith('/ai/conversations', expect.anything());
  });

  // PHASE1_TWENTY_PLAN §6 rows 7–10 / C14: disclosed only to an eligible caller; the chat opens, the input is disabled
  // with the exact §1.4/§1.5 text, and NOTHING is sent (no conversation, no question, no history read).
  it.each([
    ['not_configured / provider', { reason: 'not_configured', setup: 'provider', message: AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER }, "AI isn't set up yet. A platform admin needs to add a provider key"],
    ['not_configured / model', { reason: 'not_configured', setup: 'model', message: AI_STATE_MESSAGE.NOT_CONFIGURED_MODEL }, 'Choose a model in Settings → AI'],
    ['demo_data_only', { reason: 'demo_data_only', message: AI_STATE_MESSAGE.DEMO_DATA_ONLY }, 'AI is available for demo data only until the provider checklist is complete.'],
  ])('%s → the chat opens with the input disabled and the exact text; nothing is sent', async (_label, state, text) => {
    availability = { available: false, ...state, limits: AVAILABLE.limits, usage: null };
    renderChat();
    const input = await screen.findByRole('textbox', { name: 'Message Crewflow AI' });
    expect(input).toBeDisabled();
    expect(screen.getByText(text, { selector: 'p' })).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toBeDisabled();
    // Typing (were it possible), Enter and clicking all do nothing: no request of any kind leaves the browser.
    fireEvent.change(input, { target: { value: 'Which shifts this weekend are unfilled?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(send);
    for (const suggestion of screen.getAllByRole('button').filter((b) => b.textContent?.includes('this weekend'))) expect(suggestion).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalledWith('/ai/conversations', expect.anything());
    expect(get.mock.calls.map(([url]) => url)).toEqual(['/ai/availability']);
  });

  it('an older server without `message` still shows the fixed text for its setup', async () => {
    availability = { available: false, reason: 'not_configured', setup: 'model', limits: AVAILABLE.limits, usage: null };
    renderChat();
    expect(await screen.findByText('Choose a model in Settings → AI', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Crewflow AI' })).toBeDisabled();
  });

  it('loading, then an unreachable service offers "Try again"', async () => {
    get.mockRejectedValueOnce({ isAxiosError: true, code: 'ERR_NETWORK' }).mockRejectedValueOnce({ isAxiosError: true, code: 'ERR_NETWORK' });
    renderChat();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the AI assistant');
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 5000 });
    fireEvent.click(retry);
    expect(await screen.findByRole('textbox', { name: 'Message Crewflow AI' })).toBeInTheDocument();
  });
});

describe('asking and streaming', () => {
  it('creates the conversation, submits with an idempotency key, then renders the streamed answer (safe Markdown) and the server’s final content', async () => {
    renderChat();
    expect(await screen.findByText('AI suggests, a person decides. AI can make mistakes and can’t change anything without your approval.')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Organisation AI use today' })).toHaveAttribute('aria-valuenow', '1');
    await ask();
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    expect(post).toHaveBeenNthCalledWith(1, '/ai/conversations', { title: 'Which shifts this weekend are unfilled?' });
    const [, body] = post.mock.calls[1];
    expect(Object.keys(body).sort()).toEqual(['clientRequestId', 'content']); // never organisationId/status/role
    expect(body.content).toBe('Which shifts this weekend are unfilled?');
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(latest().opts).toMatchObject({ conversationId: CONV, turnId: TURN });
    // The question appears only once the server accepted it; the composer is cleared then.
    expect(screen.getByRole('article', { name: 'Your question' })).toHaveTextContent('Which shifts this weekend are unfilled?');
    expect(screen.getByRole('textbox', { name: 'Message Crewflow AI' })).toHaveValue('');

    emit({ type: 'status', turnId: TURN, status: 'running' });
    emit({ type: 'tool', turnId: TURN, name: 'list_unfilled_shifts', phase: 'started' });
    const answer = screen.getByRole('article', { name: 'Assistant answer' });
    expect(within(answer).getByText('Checking unfilled shifts…')).toBeInTheDocument();
    emit({ type: 'tool', turnId: TURN, name: 'list_unfilled_shifts', phase: 'finished', outcome: 'ok' });
    emit({ type: 'delta', turnId: TURN, text: '**2** shift(s) still need staff:\n' });
    emit({ type: 'delta', turnId: TURN, text: '- Bartender at The Mill' });
    expect(within(answer).getByText('2').tagName).toBe('STRONG');
    expect(answer).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
    serverFinish('completed', 'final');
    emit({ type: 'done', turnId: TURN, status: 'completed', errorCode: null, content: '2 shift(s) still need staff:\n- Bartender at The Mill\n- Chef at The Quay' });
    expect(answer.querySelectorAll('.ai-md li')).toHaveLength(2);
    expect(answer).toHaveAttribute('aria-busy', 'false');
    expect(within(answer).getByRole('button', { name: 'Copy answer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('a failed turn shows its error in plain words (never a provider message)', async () => {
    renderChat();
    await ask();
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    serverFinish('failed', '', 'AI_MODEL_TIMEOUT');
    emit({ type: 'done', turnId: TURN, status: 'failed', errorCode: 'AI_MODEL_TIMEOUT', content: '' });
    expect(screen.getByRole('note')).toHaveTextContent('The assistant took too long to answer.');
  });

  it('cancel: a running answer is stopped by the named action; "Stopping…" until the stream confirms', async () => {
    renderChat();
    await ask();
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    emit({ type: 'delta', turnId: TURN, text: 'Partial ' });
    post.mockResolvedValueOnce({ data: { turnId: TURN, status: 'cancelling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(`/ai/conversations/${CONV}/turns/${TURN}/cancel`, {}));
    expect(await screen.findByText('Stopping…')).toBeInTheDocument();
    serverFinish('cancelled', 'Partial ');
    emit({ type: 'done', turnId: TURN, status: 'cancelled', errorCode: null, content: 'Partial ' });
    expect(screen.getByText(/Stopped\. The answer above is incomplete\./)).toBeInTheDocument();
  });

  it('cancel of a queued turn: the server answers "cancelled" at once and the stream is closed', async () => {
    renderChat();
    await ask();
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    post.mockImplementationOnce(() => { serverFinish('cancelled', ''); return Promise.resolve({ data: { turnId: TURN, status: 'cancelled' } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    expect(await screen.findByText(/Stopped\. No answer was produced\./)).toBeInTheDocument();
    expect(latest().stop).toHaveBeenCalled();
  });

  it('reconnect: shows "Reconnecting…", and after the automatic budget a manual Reconnect resumes after the last event id', async () => {
    renderChat();
    await ask();
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    emit({ type: 'delta', turnId: TURN, text: 'First part ' });
    latest().lastId = '1700000000000-4';
    act(() => latest().opts.onReconnecting?.(1));
    expect(screen.getByText('Connection interrupted. Reconnecting…')).toBeInTheDocument();
    end({ kind: 'network' });
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    expect(mockStreams).toHaveLength(2);
    expect(latest().opts).toMatchObject({ conversationId: CONV, turnId: TURN, lastEventId: '1700000000000-4' });
    emit({ type: 'delta', turnId: TURN, text: 'second part' });
    expect(screen.getByRole('article', { name: 'Assistant answer' })).toHaveTextContent('First part second part');
  });
});

describe('limits and refusals', () => {
  it('input character limit (AI_MAX_INPUT_CHARS from availability): over the limit cannot be sent', async () => {
    availability = { ...AVAILABLE, limits: { ...AVAILABLE.limits, maxInputChars: 20 } };
    renderChat();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message Crewflow AI' }), { target: { value: 'x'.repeat(25) } });
    expect(screen.getByRole('alert')).toHaveTextContent('Questions are limited to 20 characters.');
    expect(screen.getByText('25 / 20')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(post).not.toHaveBeenCalled();
  });

  it('usage limit: 429 AI_BUDGET_EXHAUSTED is one inline alert with the wait, sending stays disabled, the draft is kept', async () => {
    post.mockImplementation((url: string) => {
      if (url === '/ai/conversations') { details[CONV] = { conversation: conversation(), messages: [] }; return Promise.resolve({ data: conversation() }); }
      return Promise.reject(httpError(429, { statusCode: 429, code: 'AI_BUDGET_EXHAUSTED', message: 'Your organisation has used its AI allowance for today.', retryAfterSeconds: 3600 }));
    });
    const toasts: unknown[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
    document.addEventListener(TOAST_EVENT, onToast);
    renderChat();
    await ask('What is our fill rate this week?');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your organisation has used today’s AI allowance.');
    expect(screen.getByText(/You can ask again in 60 min/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Crewflow AI' })).toHaveValue('What is our fill rate this week?');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(toasts).toEqual([]); // announced once: inline, no toast on top
    document.removeEventListener(TOAST_EVENT, onToast);
  });

  it('429 AI_RATE_LIMITED says so with the short wait', async () => {
    details[CONV] = { conversation: conversation(), messages: [] };
    post.mockImplementation((url: string) =>
      url === '/ai/conversations' ? Promise.resolve({ data: conversation() }) : Promise.reject(httpError(429, { code: 'AI_RATE_LIMITED', retryAfterSeconds: 12 })),
    );
    renderChat();
    await ask();
    expect(await screen.findByRole('alert')).toHaveTextContent('You are asking questions too quickly.');
    expect(screen.getByText(/You can ask again in 12 s/)).toBeInTheDocument();
  });

  it('permission removed / AI switched off mid-session: 404 AI_NOT_AVAILABLE re-reads availability and shows the disabled state', async () => {
    renderChat();
    await screen.findByRole('textbox', { name: 'Message Crewflow AI' });
    post.mockRejectedValueOnce(httpError(404, { statusCode: 404, code: 'AI_NOT_AVAILABLE', message: 'Not found.' }));
    availability = { available: false, reason: 'organisation_disabled', limits: AVAILABLE.limits, usage: null };
    await ask();
    expect(await screen.findByText('The AI assistant is off for your organisation')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('configuration removed mid-session: 503 AI_NOT_CONFIGURED re-reads availability and the composer is disabled with the fixed text', async () => {
    renderChat();
    await screen.findByRole('textbox', { name: 'Message Crewflow AI' });
    post.mockRejectedValueOnce(httpError(503, { statusCode: 503, code: 'AI_NOT_CONFIGURED', setup: 'provider', message: AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER }));
    availability = { available: false, reason: 'not_configured', setup: 'provider', message: AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER, limits: AVAILABLE.limits, usage: null };
    await ask();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Crewflow AI' })).toBeDisabled());
    expect(screen.getByText(AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER, { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('a server outage (503) offers "Try again" with the SAME idempotency key', async () => {
    details[CONV] = { conversation: conversation(), messages: [] };
    let calls = 0;
    post.mockImplementation((url: string) => {
      if (url === '/ai/conversations') return Promise.resolve({ data: conversation() });
      calls += 1;
      if (calls === 1) return Promise.reject(httpError(503, { code: 'AI_SERVICE_UNAVAILABLE' }));
      return Promise.resolve({ data: { conversationId: CONV, userMessageId: USER_MSG, turnId: TURN, status: 'queued', replayed: true } });
    });
    renderChat();
    await ask();
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI assistant is temporarily unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    const submits = post.mock.calls.filter(([u]) => String(u).endsWith('/messages'));
    expect(submits).toHaveLength(2);
    expect(submits[0][1].clientRequestId).toBe(submits[1][1].clientRequestId);
    expect(post.mock.calls.filter(([u]) => u === '/ai/conversations')).toHaveLength(1); // no second conversation
  });
});

describe('history', () => {
  const completed = {
    conversation: conversation({ messageCount: 2 }),
    messages: [
      { id: USER_MSG, role: 'user', status: 'sent', content: 'How many offers are awaiting replies?', errorCode: null, toolCalls: [], createdAt: '2026-10-25T10:00:00.000Z', completedAt: null },
      { id: TURN, role: 'assistant', status: 'completed', content: 'Offers: **4** waiting for a staff reply.', errorCode: null, toolCalls: [{ name: 'get_offer_status', outcome: 'ok', rows: 7 }], createdAt: '2026-10-25T10:00:01.000Z', completedAt: '2026-10-25T10:00:02.000Z' },
    ],
  };

  it('reopens a previous conversation from the server and deletes it (server-confirmed)', async () => {
    list = { data: [conversation({ title: 'Offers this week', messageCount: 2 })], nextCursor: null };
    details[CONV] = completed;
    del.mockResolvedValue({ status: 204 });
    renderChat(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Offers this week' }));
    const answer = await screen.findByRole('article', { name: 'Assistant answer' });
    expect(within(answer).getByText('4').tagName).toBe('STRONG');
    expect(within(answer).getByText('Checked offer status')).toBeInTheDocument();
    expect(mockStreams).toHaveLength(0); // a finished turn is never streamed again

    fireEvent.click(screen.getByRole('button', { name: 'Delete this conversation' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/ai/conversations/${CONV}`));
    expect(await screen.findByText('New conversation')).toBeInTheDocument();
  });

  it('a reopened conversation whose answer is still running is followed again (resume)', async () => {
    list = { data: [conversation({ title: 'Running one' })], nextCursor: null };
    details[CONV] = { ...completed, messages: [completed.messages[0], { ...completed.messages[1], status: 'running', content: '' }] };
    renderChat(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Running one' }));
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    expect(latest().opts).toMatchObject({ conversationId: CONV, turnId: TURN });
    emit({ type: 'done', turnId: TURN, status: 'completed', errorCode: null, content: 'Done now.' });
    expect(screen.getByText('Done now.')).toBeInTheDocument();
  });
});

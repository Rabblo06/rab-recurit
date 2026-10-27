import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AI_STATE_MESSAGE } from '@rab/shared';

import { api } from '../../shared/api';
import { AiChatProvider } from './AiChatProvider';
import AiChatPanel, { COVERAGE_GAPS_PROMPT } from './AiChatPanel';
import type { AiChatStreamEvent, AiStreamOptions } from './aiStream';

/**
 * Phase 8 chat (TWENTY_UI_INVENTORY H, I, L; T8-C2; security tests of TWENTY_UI_CONTRACT_DELTAS §5): the avatar empty
 * state and quick actions, the always-visible counter, the one footer line, the assistant's name as plain text with the
 * "AI" badge, step labels, "Thought for N s" (duration only), the plan checklist (information only), the level picker
 * (enum on submit) and the usage popover (real figures only, no "credits"). Server answers are mocked; nothing is live.
 */
jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), delete: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const mockStreams: Array<{ opts: AiStreamOptions }> = [];
jest.mock('./aiStream', () => ({
  openAiStream: jest.fn((opts: AiStreamOptions) => {
    mockStreams.push({ opts });
    return { stop: jest.fn(), lastEventId: () => null };
  }),
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const CONV = '0b6f5d1a-1111-4222-8333-444455556666';
const TURN = '7c1e2a3b-1111-4222-8333-444455556666';
const NOTICE = 'AI suggests, a person decides. AI can make mistakes and can’t change anything without your approval.';
const LIMITS = { maxInputChars: 4000, userRatePerMinute: 10, orgDailyTokenBudget: 200000 };
const BASE = { available: true, reason: null, limits: LIMITS, usage: { day: '2026-10-25', tokensUsedOrReserved: 1171 } };
const LEVELS = {
  chatLevel: 'extra_fast',
  options: [
    { level: 'extra_fast', label: 'Extra fast', bars: 1, available: true, unavailableReason: null },
    { level: 'fast', label: 'Fast', bars: 2, available: false, unavailableReason: 'effort_unverified' },
    { level: 'balanced', label: 'Balanced', bars: 3, available: false, unavailableReason: 'no_approved_model' },
    { level: 'smart', label: 'Smart', bars: 4, available: false, unavailableReason: 'no_approved_model' },
    { level: 'extra_smart', label: 'Extra smart', bars: 5, available: false, unavailableReason: 'no_approved_model' },
  ],
};
let availability: unknown = BASE;
let details: Record<string, { conversation: object; messages: Array<Record<string, unknown>> }> = {};

function renderChat(surface: 'page' | 'panel' = 'page') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiChatProvider workspaceId="ws-a">
        <AiChatPanel surface={surface} />
      </AiChatProvider>
    </QueryClientProvider>,
  );
}
const latest = () => mockStreams[mockStreams.length - 1]!;
const emit = (event: AiChatStreamEvent) => act(() => latest().opts.onEvent(event));
const input = () => screen.findByRole('textbox', { name: 'Message Crewflow AI' });

beforeEach(() => {
  mockStreams.length = 0;
  availability = BASE;
  details = {};
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/ai/availability') return Promise.resolve({ data: availability });
    if (url === '/ai/conversations') return Promise.resolve({ data: { data: [], nextCursor: null } });
    const d = details[url.replace('/ai/conversations/', '')];
    if (d) return Promise.resolve({ data: d });
    return Promise.reject({ isAxiosError: true, response: { status: 404, data: { statusCode: 404 } } });
  });
  post.mockImplementation((url: string, body: { title?: string }) => {
    if (url === '/ai/conversations') {
      details[CONV] = { conversation: { id: CONV, title: body.title, messageCount: 0, lastMessageAt: '2026-10-25T10:00:00.000Z', createdAt: '2026-10-25T10:00:00.000Z' }, messages: [] };
      return Promise.resolve({ data: details[CONV]!.conversation });
    }
    if (url === `/ai/conversations/${CONV}/messages`) {
      // The fake server persists the turn like the real one, so a refetch returns it.
      const content = (body as unknown as { content: string }).content;
      details[CONV]!.messages = [
        { id: 'u1', role: 'user', status: 'sent', content, errorCode: null, toolCalls: [], createdAt: '2026-10-25T10:00:00.000Z', completedAt: null },
        { id: TURN, role: 'assistant', status: 'queued', content: '', errorCode: null, toolCalls: [], createdAt: '2026-10-25T10:00:00.000Z', completedAt: null },
      ];
      return Promise.resolve({ data: { conversationId: CONV, userMessageId: 'u1', turnId: TURN, status: 'queued', replayed: false } });
    }
    return Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } });
  });
});

async function askAndRun(text = 'What is our fill rate this week?') {
  fireEvent.change(await input(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(mockStreams).toHaveLength(1));
  emit({ type: 'status', turnId: TURN, status: 'running' });
  return screen.getByRole('article', { name: 'Assistant answer' });
}

describe('empty state, counter, footer (H1–H11, L5, L6, C8-6, D8-2)', () => {
  it.each(['page', 'panel'] as const)('%s: avatar, quick actions, the counter always visible as n / max, the exact footer; no attach and no microphone', async (surface) => {
    const { container } = renderChat(surface);
    const box = await input();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText('0 / 4,000')).toBeInTheDocument();
    expect(container.querySelector('.ai-empty .ai-av[aria-hidden="true"] svg path.ai-av-body')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find open shifts' }));
    expect(box).toHaveValue(COVERAGE_GAPS_PROMPT);
    expect(post).not.toHaveBeenCalled(); // a quick action never sends by itself
    expect(screen.getByText(`${COVERAGE_GAPS_PROMPT.length} / 4,000`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /attach|upload|microphone|dictat|voice/i })).not.toBeInTheDocument();
    // "See what I can do" appears only when the server serves GET /ai/capabilities (it does not here).
    expect(screen.queryByRole('button', { name: 'See what I can do' })).not.toBeInTheDocument();
  });

  it('the counter turns red past the limit', async () => {
    availability = { ...BASE, limits: { ...LIMITS, maxInputChars: 10 } };
    renderChat();
    fireEvent.change(await input(), { target: { value: 'x'.repeat(11) } });
    expect(screen.getByText('11 / 10')).toHaveAttribute('data-over', 'true');
  });

  it('the blocked view carries the same footer line', async () => {
    availability = { available: false, reason: 'not_configured', setup: 'provider', message: AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER, limits: LIMITS, usage: null };
    renderChat();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });

  it('"See what I can do" lists the SERVER’s permitted tools and skills as plain text when the route exists', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/ai/availability') return Promise.resolve({ data: availability });
      if (url === '/ai/capabilities') return Promise.resolve({ data: { tools: [{ name: 'get_fill_rate', label: 'Fill rate', summary: '<b>Shifts</b> filled vs needed' }], skills: [] } });
      return Promise.resolve({ data: { data: [], nextCursor: null } });
    });
    const { container } = renderChat();
    fireEvent.click(await screen.findByRole('button', { name: 'See what I can do' }));
    const dialog = await screen.findByRole('dialog', { name: 'What I can do' });
    expect(within(dialog).getByText('<b>Shifts</b> filled vs needed')).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('.ai-capabilities b')).toBeNull();
  });
});

describe('the assistant identity (CD-3)', () => {
  it('the configured name is plain text with an "AI" badge — markup and bidi tricks stay text', async () => {
    const evil = '<img src=x onerror=alert(1)>‮evil';
    availability = { ...BASE, assistant: { preset: null, name: evil, shape: 'circle', colour: 'violet', face: 'round', animate: true, isDefault: false, updatedAt: null } };
    const { container } = renderChat();
    const answer = await askAndRun();
    expect(within(answer).getByText(evil)).toBeInTheDocument();
    expect(within(answer).getByLabelText('AI assistant')).toHaveTextContent('AI');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.ai-av[data-shape="circle"][data-face="round"].ai-av--violet')).not.toBeNull();
  });
});

describe('turn activity (CD-7)', () => {
  it('thinking → steps with server labels → "Thought for N s" (duration only, not expandable) → plan as information only', async () => {
    renderChat();
    const answer = await askAndRun();
    expect(within(answer).getByText('is thinking')).toBeInTheDocument();
    emit({ type: 'reasoning', turnId: TURN, phase: 'started' });
    expect(within(answer).getByText('Thinking…')).toBeInTheDocument();
    emit({ type: 'reasoning', turnId: TURN, phase: 'finished', durationMs: 2_100 });
    const thought = within(answer).getByText('Thought for 2 s');
    expect(thought.closest('button')).toBeNull();
    expect(within(answer).queryByRole('button', { expanded: false })).not.toBeInTheDocument();
    emit({ type: 'plan', turnId: TURN, steps: [{ label: 'Check <script>alert(1)</script> shifts', status: 'done' }, { label: 'Compare with last week', status: 'in_progress' }, { label: 'Summarise', status: 'pending' }] });
    expect(within(answer).getByText('Planned 3 steps')).toBeInTheDocument();
    const plan = within(answer).getByRole('list', { name: 'Plan' });
    expect(within(plan).getByText('Check <script>alert(1)</script> shifts')).toBeInTheDocument();
    expect(plan.querySelector('script')).toBeNull();
    expect(within(answer).queryByText(/plan approved/i)).not.toBeInTheDocument();
    expect(within(answer).queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    emit({ type: 'tool', turnId: TURN, name: 'get_fill_rate', phase: 'started' });
    expect(within(answer).getByText('Checking the fill rate…')).toBeInTheDocument();
    emit({ type: 'tool', turnId: TURN, name: 'get_fill_rate', phase: 'finished', outcome: 'ok' });
    expect(within(answer).getByText('Checked the fill rate')).toBeInTheDocument();
    emit({ type: 'delta', turnId: TURN, text: '## Fill rate\nIt is **92%**.' });
    expect(answer.querySelector('.ai-md-h2')).not.toBeNull();
    expect(answer.querySelector('h1, h2, h3')).toBeNull();
  });

  it('a reasoning event can never carry text into the DOM (the canary is absent)', async () => {
    const { container } = renderChat();
    await askAndRun();
    emit({ type: 'reasoning', turnId: TURN, phase: 'finished', durationMs: 900, text: 'REASONING-CANARY' } as unknown as AiChatStreamEvent);
    expect(container.textContent).not.toContain('REASONING-CANARY');
    expect(screen.getByText('Thought for 1 s')).toBeInTheDocument();
  });
});

describe('composer controls (CD-1, CD-6)', () => {
  it('the level picker offers the server’s levels; unavailable ones are greyed with the reason; once the server accepts a level the submit carries only the enum', async () => {
    availability = { ...BASE, levels: { ...LEVELS, submitAcceptsLevel: true }, model: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'fast', source: 'any' } };
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Fill rate?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Level: Extra fast' }));
    const slider = await screen.findByRole('slider', { name: 'Answer level' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Extra fast');
    expect(screen.getByRole('button', { name: 'Fast, Unavailable: effort not verified yet' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    // Viewing an unavailable level shows its reason and what is used instead; the chosen level does not change.
    expect(slider).toHaveAttribute('aria-valuetext', 'Fast (Effort not verified)');
    expect(screen.getByRole('note')).toHaveTextContent('Effort not verified · using Extra fast');
    // No invented figures: intelligence and speed show "—" with the reason.
    expect(screen.getAllByTitle('No verified source yet').length).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(slider, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Level: Extra fast' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/messages`, expect.anything()));
    const body = post.mock.calls.find(([u]) => u === `/ai/conversations/${CONV}/messages`)![1];
    expect(Object.keys(body).sort()).toEqual(['clientRequestId', 'content', 'level']);
    expect(body.level).toBe('extra_fast');
  });

  it('levels offered but NOT accepted on submit yet (no submitAcceptsLevel): the picker is read-only and no level is sent', async () => {
    availability = { ...BASE, levels: LEVELS };
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Fill rate?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Level: Extra fast' }));
    expect(await screen.findByRole('slider', { name: 'Answer level' })).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByText(/Questions use your organisation’s level \(Extra fast\) for now/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/messages`, expect.anything()));
    expect(Object.keys(post.mock.calls.find(([u]) => u === `/ai/conversations/${CONV}/messages`)![1]).sort()).toEqual(['clientRequestId', 'content']);
  });

  it('only an AVAILABLE level is sent: an unavailable organisation level sends none (no client fallback)', async () => {
    const options = LEVELS.options.map((o) => (o.level === 'fast' ? o : { ...o, available: o.level === 'extra_fast', unavailableReason: o.level === 'extra_fast' ? null : o.unavailableReason }));
    availability = { ...BASE, levels: { chatLevel: 'fast', options, submitAcceptsLevel: true } };
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Fill rate?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/messages`, expect.anything()));
    expect(Object.keys(post.mock.calls.find(([u]) => u === `/ai/conversations/${CONV}/messages`)![1]).sort()).toEqual(['clientRequestId', 'content']);
  });

  it('409 AI_LEVEL_UNAVAILABLE: the client re-reads availability, explains, and does NOT resubmit', async () => {
    availability = { ...BASE, levels: { ...LEVELS, submitAcceptsLevel: true } };
    const base = post.getMockImplementation()!;
    post.mockImplementation((url: string, body: never) =>
      url === `/ai/conversations/${CONV}/messages`
        ? Promise.reject({ isAxiosError: true, response: { status: 409, data: { statusCode: 409, code: 'AI_LEVEL_UNAVAILABLE', message: 'Level unavailable.' } } })
        : base(url, body),
    );
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Fill rate?' } });
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === '/ai/availability').length).toBeGreaterThan(0));
    const before = get.mock.calls.filter(([u]) => u === '/ai/availability').length;
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('That level can’t be used right now. Choose another level.')).toBeInTheDocument();
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === '/ai/availability').length).toBeGreaterThan(before));
    const sends = () => post.mock.calls.filter(([u]) => u === `/ai/conversations/${CONV}/messages`);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]![1].level).toBe('extra_fast');
    await new Promise((r) => setTimeout(r, 300));
    expect(sends()).toHaveLength(1);
  });

  it('without server levels no picker is shown and no level is sent', async () => {
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Fill rate?' } });
    expect(screen.queryByRole('button', { name: /^Level:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/messages`, expect.anything()));
    expect(Object.keys(post.mock.calls.find(([u]) => u === `/ai/conversations/${CONV}/messages`)![1]).sort()).toEqual(['clientRequestId', 'content']);
  });

  it('the usage ring is hidden until the server reports the Phase 7 meters (U1)', async () => {
    renderChat();
    await input();
    expect(screen.queryByRole('button', { name: 'Context and usage' })).not.toBeInTheDocument();
  });

  it('the usage popover shows real figures only: allowance today; context and per-message usage are "—" until the server sends them (S1); no credits', async () => {
    availability = { ...BASE, usage: { ...BASE.usage, resetsAt: '2026-10-26T00:00:00.000Z' } };
    renderChat();
    await input();
    fireEvent.click(screen.getByRole('button', { name: 'Context and usage' }));
    const pop = await screen.findByLabelText('Context and usage', { selector: '.ai-popover-body' });
    expect(within(pop).getByText(/1% used/)).toBeInTheDocument(); // 1,171 of 200,000 tokens
    expect(within(pop).getByTitle('Not recorded')).toHaveTextContent('—');
    fireEvent.click(within(pop).getByRole('button', { name: 'More' }));
    expect(within(pop).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(pop.textContent).not.toMatch(/credit/i);
  });
});

describe('U1 unavailable states (owner chat mockup state 6)', () => {
  it.each([
    ['provider', { reason: 'not_configured', setup: 'provider', message: AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER }, 'AI isn’t set up yet.'],
    ['model', { reason: 'not_configured', setup: 'model', message: AI_STATE_MESSAGE.NOT_CONFIGURED_MODEL }, 'Choose a model in Settings → AI.'],
    ['demo', { reason: 'demo_data_only', message: AI_STATE_MESSAGE.DEMO_DATA_ONLY }, 'AI is available for demo data only'],
  ])('%s: the sleepy avatar, the heading and its banner; the composer is disabled', async (kind, state, title) => {
    availability = { available: false, limits: LIMITS, usage: null, ...state };
    const { container } = renderChat();
    expect(await screen.findByText('How can I help you?')).toBeInTheDocument();
    const banner = container.querySelector(`.ai-banner[data-kind="${kind}"]`)!;
    expect(banner).not.toBeNull();
    expect(banner.querySelector('strong')).toHaveTextContent(title);
    expect(container.querySelector('.ai-empty .ai-av[data-state="sleepy"].ai-av--grey')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message Crewflow AI' })).toBeDisabled();
    // The settings link is the CEO's only (the me query answers 404 here).
    expect(screen.queryByRole('link', { name: 'Open AI settings' })).not.toBeInTheDocument();
  });

  it('a failed turn shows the error face, the reason, "Nothing was changed" and Try again (puts the question back; nothing re-sent)', async () => {
    renderChat();
    await askAndRun('What is our fill rate this week?');
    details[CONV]!.messages[1] = { ...details[CONV]!.messages[1]!, status: 'failed', errorCode: 'AI_MODEL_ERROR' };
    const reads = () => get.mock.calls.filter(([u]) => u === `/ai/conversations/${CONV}`).length;
    const before = reads();
    emit({ type: 'done', turnId: TURN, status: 'failed', errorCode: 'AI_MODEL_ERROR', content: '' });
    await waitFor(() => expect(reads()).toBeGreaterThan(before)); // the persisted row is re-read after `done`
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Nothing was changed. The assistant could not answer this time. Please ask again.');
    const face = alert.querySelector('.ai-av');
    expect(face?.getAttribute('data-state')).toBe('error');
    expect(face?.className).toContain('ai-av--red');
    const posts = post.mock.calls.length;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('textbox', { name: 'Message Crewflow AI' })).toHaveValue('What is our fill rate this week?');
    expect(post.mock.calls.length).toBe(posts);
  });
});

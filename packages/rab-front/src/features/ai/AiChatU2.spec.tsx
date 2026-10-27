import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../shared/api';
import { AiChatProvider } from './AiChatProvider';
import AiChatPanel from './AiChatPanel';
import { STEP_PRIVACY_TEXT } from './AiMessage';
import type { AiChatStreamEvent, AiStreamOptions } from './aiStream';

/**
 * U2 (owner-approved 2026-10-26, docs/ai/UI_U2_U8_PLAN.md §B): one queued question behind a running answer (Remove,
 * no second queue, picked up when the first ends), Stop, tool steps as disclosures that show server facts only (never
 * inputs or outputs), record chips from STORED content only (label from the record's own route, 404 → "Record
 * unavailable"), the usage popover and the answer footer from the S1 fields ("—" when absent), and the 7b failed-turn
 * texts. Server answers are mocked; nothing is live.
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
const TURN2 = '7c1e2a3b-2222-4222-8333-444455556666';
const SHIFT = '5a0e0c4e-3333-4222-8333-444455556666';
const VENUE = '5a0e0c4e-4444-4222-8333-444455556666';
const AT = '2026-10-25T10:00:00.000Z';
const LIMITS = { maxInputChars: 4000, userRatePerMinute: 10, orgDailyTokenBudget: 200000 };
const MODEL = { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'fast', source: 'any' };
const LEVELS = { chatLevel: 'extra_fast', submitAcceptsLevel: true, options: [{ level: 'extra_fast', label: 'Extra fast', bars: 1, available: true, unavailableReason: null }] };
const USAGE = { day: '2026-10-25', tokensUsedOrReserved: 1171, orgCostMicros: 240000, orgCostCeilingMicros: 2000000, userCostMicros: 180000, userCostCeilingMicros: 1000000, resetsAt: '2026-10-26T00:00:00.000Z', limitingBudget: 'user' };
const BASE = { available: true, reason: null, limits: LIMITS, usage: USAGE, model: MODEL, levels: LEVELS };
const TURN_USAGE = { inputTokens: 8200, cachedInputTokens: 6100, cacheWriteTokens: 0, outputTokens: 640, costUsdMicros: 1100, contextUsedTokens: 24000, contextLimitTokens: 200000 };
const TOTALS = { turns: 3, inputTokens: 24000, cachedInputTokens: 18000, cacheWriteTokens: 0, outputTokens: 2100, costUsdMicros: 3400 };

type Msg = Record<string, unknown>;
let details: Record<string, { conversation: object; messages: Msg[]; usageTotals?: object }> = {};
let extraGet: (url: string) => Promise<unknown> | undefined = () => undefined;

const user = (id: string, content: string): Msg => ({ id, role: 'user', status: 'sent', content, errorCode: null, toolCalls: [], createdAt: AT, completedAt: null });
const answer = (id: string, status: string, extra: Msg = {}): Msg => ({ id, role: 'assistant', status, content: '', errorCode: null, toolCalls: [], createdAt: AT, completedAt: null, ...extra });

function renderChat(surface: 'page' | 'panel' = 'page') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AiChatProvider workspaceId="ws-a">
          <AiChatPanel surface={surface} />
        </AiChatProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const latest = () => mockStreams[mockStreams.length - 1]!;
const emit = (event: AiChatStreamEvent) => act(() => latest().opts.onEvent(event));
const end = () => act(() => latest().opts.onEnd({ kind: 'done' }));
const input = () => screen.findByRole('textbox', { name: 'Message Crewflow AI' });
const sends = () => post.mock.calls.filter(([u]) => u === `/ai/conversations/${CONV}/messages`);

beforeEach(() => {
  mockStreams.length = 0;
  details = {};
  extraGet = () => undefined;
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    const extra = extraGet(url);
    if (extra) return extra;
    if (url === '/ai/availability') return Promise.resolve({ data: BASE });
    if (url === '/ai/conversations') return Promise.resolve({ data: { data: [], nextCursor: null } });
    if (url === '/ai/skills') return Promise.resolve({ data: [{ name: 'shift-filling', label: 'Shift filling', description: 'Who could cover an open shift' }] });
    const d = details[url.replace('/ai/conversations/', '')];
    if (d) return Promise.resolve({ data: JSON.parse(JSON.stringify(d)) });
    return Promise.reject({ isAxiosError: true, response: { status: 404, data: { statusCode: 404 } } });
  });
  post.mockImplementation((url: string, body: { title?: string; content?: string }) => {
    if (url === '/ai/conversations') {
      details[CONV] = { conversation: { id: CONV, title: body.title, messageCount: 0, lastMessageAt: AT, createdAt: AT }, messages: [] };
      return Promise.resolve({ data: details[CONV]!.conversation });
    }
    if (url === `/ai/conversations/${CONV}/messages`) {
      const first = sends().length === 1;
      if (first) {
        details[CONV]!.messages = [user('u1', body.content!), answer(TURN, 'queued')];
        return Promise.resolve({ data: { conversationId: CONV, userMessageId: 'u1', turnId: TURN, status: 'queued', replayed: false } });
      }
      details[CONV]!.messages = [...details[CONV]!.messages.slice(0, 2), user('u2', body.content!), answer(TURN2, 'queued')];
      return Promise.resolve({ data: { conversationId: CONV, userMessageId: 'u2', turnId: TURN2, status: 'queued', replayed: false } });
    }
    if (url.endsWith('/cancel')) return Promise.resolve({ data: { turnId: url.split('/').at(-2), status: 'cancelled' } });
    return Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } });
  });
});

async function askAndRun(text = 'What is our fill rate this week?') {
  renderChat();
  fireEvent.change(await input(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(mockStreams).toHaveLength(1));
  details[CONV]!.messages[1] = answer(TURN, 'running');
  emit({ type: 'status', turnId: TURN, status: 'running' });
}

/** Ends the running turn the way the server does: persisted row first, then `done`, then the stream closes. */
async function finish(content: string, extra: Msg = {}, totals?: object) {
  details[CONV]!.messages[1] = answer(TURN, 'completed', { content, completedAt: AT, ...extra });
  if (totals) details[CONV]!.usageTotals = totals;
  emit({ type: 'done', turnId: TURN, status: 'completed', errorCode: null, content });
  end();
}

describe('B.1 queued message and Stop', () => {
  it('one more question can be sent while an answer runs; it shows as queued with Remove; a second one is refused locally', async () => {
    await askAndRun();
    expect(screen.getByRole('button', { name: 'Stop response' })).toHaveTextContent('Stop');
    fireEvent.change(await input(), { target: { value: 'And next week?' } });
    const queueSend = screen.getByRole('button', { name: 'Send message (asks after the current answer)' });
    expect(queueSend).toBeEnabled();
    fireEvent.click(queueSend);
    const queued = await screen.findByRole('article', { name: 'Your queued question' });
    expect(within(queued).getByText(/Queued · asks after the current answer/)).toBeInTheDocument();
    expect(sends()).toHaveLength(2);
    expect(mockStreams).toHaveLength(1); // still following the running answer, never the queued one
    expect(screen.getByText('One more question is queued. It is asked after the current answer.')).toBeInTheDocument();
    // A second extra question: only Stop is offered; Enter sends nothing.
    fireEvent.change(await input(), { target: { value: 'And the week after?' } });
    expect(screen.queryByRole('button', { name: /^Send message/ })).not.toBeInTheDocument();
    fireEvent.keyDown(await input(), { key: 'Enter' });
    expect(sends()).toHaveLength(2);
  });

  it('Remove cancels exactly the queued turn', async () => {
    await askAndRun();
    fireEvent.change(await input(), { target: { value: 'And next week?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message (asks after the current answer)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove queued question' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/turns/${TURN2}/cancel`, {}));
    expect(post.mock.calls.filter(([u]) => String(u).endsWith('/cancel'))).toHaveLength(1);
  });

  it('when the running answer ends, the queued turn is followed next', async () => {
    await askAndRun();
    fireEvent.change(await input(), { target: { value: 'And next week?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message (asks after the current answer)' }));
    await screen.findByRole('article', { name: 'Your queued question' });
    await finish('Fill rate is 71%.');
    await waitFor(() => expect(mockStreams).toHaveLength(2));
    expect(latest().opts.turnId).toBe(TURN2);
  });

  it('Stop cancels the running turn once', async () => {
    await askAndRun();
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/ai/conversations/${CONV}/turns/${TURN}/cancel`, {}));
    expect(post.mock.calls.filter(([u]) => String(u).endsWith('/cancel'))).toHaveLength(1);
  });
});

describe('B.2 steps (owner decision 2: never inputs or outputs)', () => {
  it('a finished tool step expands to server facts only (result, record count, skill labels) and the fixed privacy line', async () => {
    await askAndRun();
    emit({ type: 'tool', turnId: TURN, name: 'get_fill_rate', phase: 'started' });
    expect(screen.getByRole('button', { name: /Checking fill rate|fill rate/i })).toBeDisabled(); // a running step cannot open
    await finish('Done.', {
      toolCalls: [
        { name: 'load_skills', outcome: 'ok', rows: null, kind: 'meta', skills: ['shift-filling'] },
        { name: 'get_fill_rate', outcome: 'ok', rows: 3 },
      ],
    });
    const skillStep = await screen.findByRole('button', { name: /Shift filling/ });
    fireEvent.click(skillStep);
    expect(skillStep).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: /Details: .*Shift filling/ });
    expect(within(region).getByText('Completed')).toBeInTheDocument();
    expect(within(region).getByText('Shift filling')).toBeInTheDocument();
    expect(within(region).getByText(STEP_PRIVACY_TEXT)).toBeInTheDocument();
    expect(region.textContent).not.toContain('shift-filling'); // the label, never the raw name
    const fillStep = screen.getAllByRole('button', { name: /fill rate/i }).find((b) => b.getAttribute('aria-expanded') !== null)!;
    fireEvent.keyDown(fillStep, { key: 'Enter' });
    fireEvent.click(fillStep);
    expect(within(screen.getByRole('region', { name: /Details: .*fill rate/i })).getByText('3')).toBeInTheDocument();
    // "Thought for" is never a disclosure.
    expect(screen.queryByRole('button', { name: /Thought for/ })).not.toBeInTheDocument();
  });
});

describe('B.3 record chips (S2) and tables', () => {
  it('a reference streams as plain text; once stored it becomes a chip labelled from the record’s own route', async () => {
    extraGet = (url) => (url === `/shifts/${SHIFT}` ? Promise.resolve({ data: { id: SHIFT, startsAt: '2026-10-31T18:00:00.000Z', payRatePence: 1200 } }) : undefined);
    await askAndRun();
    const token = `[[record:shift:${SHIFT}]]`;
    emit({ type: 'delta', turnId: TURN, text: `Gap: ${token}` });
    expect(screen.getByText(new RegExp(`Gap: \\[\\[record:shift:${SHIFT}\\]\\]`))).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Shift:/ })).not.toBeInTheDocument();
    await finish(`Gap: ${token}`);
    const chip = await screen.findByRole('link', { name: /^Shift: \w{3} 31 Oct · \d{2}:\d{2}$/ });
    expect(chip).toHaveAttribute('href', `/venue-offers/${SHIFT}`);
    expect(document.body.textContent).not.toContain('payRatePence');
    expect(document.body.textContent).not.toContain('[[record:');
  });

  it('a record the person cannot see shows "Record unavailable" (404), and a staff reference is never fetched', async () => {
    extraGet = (url) => (url === `/venues/${VENUE}` ? Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } }) : undefined);
    await askAndRun();
    await finish(`See [[record:venue:${VENUE}]] and [[record:staff_profile:${SHIFT}]].`);
    expect(await screen.findByText('Record unavailable')).toBeInTheDocument();
    expect(screen.getByText('a staff member')).not.toHaveClass('ai-record-chip'); // S2: shifts and venues only
    expect(get.mock.calls.some(([u]) => String(u).startsWith('/staff'))).toBe(false);
  });

  it('a Markdown table renders with column headers; HTML in a cell stays text', async () => {
    await askAndRun();
    await finish('| Venue | Fill |\n|---|---|\n| <img src=x onerror=alert(1)> | 71% |');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Venue' })).toBeInTheDocument();
    expect(within(table).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(table.querySelector('img')).toBeNull();
  });
});

describe('B.5 / B.6 usage popover and answer footer (S1)', () => {
  it('real per-message and conversation figures in USD; the footer shows level · model · cost', async () => {
    await askAndRun();
    await finish('Fill rate is 71%.', { usage: TURN_USAGE, level: 'extra_fast', modelId: MODEL.id }, TOTALS);
    expect(await screen.findByText('Extra fast · Claude Haiku 5.5 · $0.0011')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Context and usage' }));
    const pop = await screen.findByLabelText('Context and usage', { selector: '.ai-popover-body' });
    expect(within(pop).getByText(/24k of 200k \(12%\)/)).toBeInTheDocument();
    expect(within(pop).getByText(/18% used/)).toBeInTheDocument(); // your allowance: 0.18 of 1.00 USD
    fireEvent.click(within(pop).getByRole('button', { name: 'More' }));
    expect(within(pop).getByText('$0.0011')).toBeInTheDocument();
    expect(within(pop).getByText('$0.0034')).toBeInTheDocument();
    expect(pop.textContent).not.toMatch(/£|credit/i);
  });

  it('without S1 fields every per-message figure is "—"; an unknown model id shows no model name', async () => {
    await askAndRun();
    await finish('Fill rate is 71%.', { level: 'extra_fast', modelId: 'some-other-model' });
    expect(await screen.findByText('Extra fast')).toHaveClass('ai-message-meta');
    expect(screen.queryByText(/some-other-model/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Context and usage' }));
    const pop = await screen.findByLabelText('Context and usage', { selector: '.ai-popover-body' });
    fireEvent.click(within(pop).getByRole('button', { name: 'More' }));
    expect(within(pop).getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });
});

describe('7b failed-turn texts', () => {
  it('AI_CONTEXT_FULL offers a new conversation, never "Try again"; AI_USER_BUDGET_EXHAUSTED says when it resets', async () => {
    await askAndRun();
    details[CONV]!.messages[1] = answer(TURN, 'failed', { errorCode: 'AI_CONTEXT_FULL' });
    emit({ type: 'done', turnId: TURN, status: 'failed', errorCode: 'AI_CONTEXT_FULL', content: '' });
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('This conversation is too long to continue.');
    expect(within(banner).getByRole('button', { name: 'Start a new conversation' })).toBeInTheDocument();
    expect(within(banner).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('AI_USER_BUDGET_EXHAUSTED on a running turn', async () => {
    await askAndRun();
    details[CONV]!.messages[1] = answer(TURN, 'failed', { errorCode: 'AI_USER_BUDGET_EXHAUSTED' });
    emit({ type: 'done', turnId: TURN, status: 'failed', errorCode: 'AI_USER_BUDGET_EXHAUSTED', content: '' });
    expect(await screen.findByRole('alert')).toHaveTextContent('You’ve used your AI allowance for today. It resets at 00:00 UTC.');
  });
});

describe('U8 announcements and focus', () => {
  it('the streamed text is not a live region; the outcome is announced once', async () => {
    await askAndRun();
    emit({ type: 'delta', turnId: TURN, text: 'Fill rate is' });
    const answer = screen.getByRole('article', { name: 'Assistant answer' });
    expect(answer.querySelector('[aria-live]')).toBeNull();
    expect(screen.getByTestId('ai-outcome')).toHaveTextContent('');
    await finish('Fill rate is 71%.');
    expect(screen.getByTestId('ai-outcome')).toHaveTextContent('Answer complete.');
  });

  it('Esc closes the usage popover and focus returns to its button', async () => {
    await askAndRun();
    await finish('Done.', { usage: TURN_USAGE });
    const ring = screen.getByRole('button', { name: 'Context and usage' });
    fireEvent.click(ring);
    await screen.findByLabelText('Context and usage', { selector: '.ai-popover-body' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Context and usage', { selector: '.ai-popover-body' })).not.toBeInTheDocument());
    expect(ring).toHaveFocus();
  });
});

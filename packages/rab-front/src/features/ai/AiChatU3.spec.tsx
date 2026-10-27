import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../shared/api';
import { AiChatProvider } from './AiChatProvider';
import AiChatPanel from './AiChatPanel';
import type { AiStreamOptions } from './aiStream';

/**
 * U3 (owner-approved 2026-10-26, docs/ai/UI_U2_U8_PLAN.md): skill tags (＋ and "/", at most 2, names only, checked by
 * the server at submit, AI_SKILL_NOT_AVAILABLE re-reads the list and never resubmits), "See what I can do" only when
 * GET /ai/capabilities answers (write tools listed apart, as suggestions to approve), and "Draft a rota" only when a
 * write proposal can complete (the draft-shift tool listed AND the approval cards shipped). Server answers are mocked.
 */
jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), delete: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
jest.mock('./aiStream', () => ({ openAiStream: jest.fn((_opts: AiStreamOptions) => ({ stop: jest.fn(), lastEventId: () => null })) }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const CONV = '0b6f5d1a-1111-4222-8333-444455556666';
const TURN = '7c1e2a3b-1111-4222-8333-444455556666';
const AT = '2026-10-25T10:00:00.000Z';
const BASE = { available: true, reason: null, limits: { maxInputChars: 4000, userRatePerMinute: 10, orgDailyTokenBudget: 200000 }, usage: { day: '2026-10-25', tokensUsedOrReserved: 0 } };
const SKILLS = [
  { name: 'coverage-report', label: 'Coverage report', description: 'Find shifts that still need staff.' },
  { name: 'house-style', label: 'House style', description: 'British English, short answers.' },
  { name: 'shift-filling', label: 'Shift filling', description: 'Who could cover an open shift.' },
];
let skills: unknown = SKILLS;
let capabilities: unknown = null; // null = 404 (route not served)
let submitError: unknown = null;
let details: Record<string, { conversation: object; messages: Array<Record<string, unknown>> }> = {};

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
const input = () => screen.findByRole('textbox', { name: 'Message Crewflow AI' });
const sends = () => post.mock.calls.filter(([u]) => u === `/ai/conversations/${CONV}/messages`);
const skillReads = () => get.mock.calls.filter(([u]) => u === '/ai/skills').length;

beforeEach(() => {
  skills = SKILLS;
  capabilities = null;
  submitError = null;
  details = {};
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/ai/availability') return Promise.resolve({ data: BASE });
    if (url === '/ai/conversations') return Promise.resolve({ data: { data: [], nextCursor: null } });
    if (url === '/ai/skills') return Promise.resolve({ data: skills });
    if (url === '/ai/capabilities') return capabilities ? Promise.resolve({ data: capabilities }) : Promise.reject({ isAxiosError: true, response: { status: 404, data: { statusCode: 404 } } });
    const d = details[url.replace('/ai/conversations/', '')];
    if (d) return Promise.resolve({ data: JSON.parse(JSON.stringify(d)) });
    return Promise.reject({ isAxiosError: true, response: { status: 404, data: { statusCode: 404 } } });
  });
  post.mockImplementation((url: string, body: { title?: string; content?: string; skills?: string[] }) => {
    if (url === '/ai/conversations') {
      details[CONV] = { conversation: { id: CONV, title: body.title, messageCount: 0, lastMessageAt: AT, createdAt: AT }, messages: [] };
      return Promise.resolve({ data: details[CONV]!.conversation });
    }
    if (url === `/ai/conversations/${CONV}/messages`) {
      if (submitError) return Promise.reject(submitError);
      details[CONV]!.messages = [
        { id: 'u1', role: 'user', status: 'sent', content: body.content, skills: body.skills ?? [], errorCode: null, toolCalls: [], createdAt: AT, completedAt: null },
        { id: TURN, role: 'assistant', status: 'queued', content: '', errorCode: null, toolCalls: [], createdAt: AT, completedAt: null },
      ];
      return Promise.resolve({ data: { conversationId: CONV, userMessageId: 'u1', turnId: TURN, status: 'queued', replayed: false } });
    }
    return Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } });
  });
});

describe('skill tags (4w submit tagging)', () => {
  it('＋ lists the active skills; at most 2 can be tagged; the question carries their NAMES; the tags clear once accepted', async () => {
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Who could cover Saturday?' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Tag a skill' }));
    const menu = await screen.findByRole('menu', { name: 'Skills' });
    expect(within(menu).getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual([
      'Coverage reportFind shifts that still need staff.',
      'House styleBritish English, short answers.',
      'Shift fillingWho could cover an open shift.',
    ]);
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: /Shift filling/ }));
    fireEvent.keyDown(within(menu).getByRole('menuitemcheckbox', { name: /House style/ }), { key: 'Enter' });
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Coverage report/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: /Coverage report/ }));
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Coverage report/ })).toHaveAttribute('aria-checked', 'false');
    fireEvent.keyDown(menu, { key: 'Escape' });
    const chips = screen.getByRole('list', { name: 'Tagged skills' });
    expect(within(chips).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Shift filling', 'House style']);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const body = sends()[0]![1];
    expect(body.skills).toEqual(['shift-filling', 'house-style']);
    expect(Object.keys(body).sort()).toEqual(['clientRequestId', 'content', 'skills']);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Remove skill/ })).not.toBeInTheDocument());
    // The sent question shows its tags (labels only).
    const sent = await screen.findByRole('article', { name: 'Your question' });
    expect(within(sent).getByRole('list', { name: 'Tagged skills' })).toHaveTextContent('Shift fillingHouse style');
  });

  it('"/" in an EMPTY composer opens the menu instead of typing; elsewhere it is an ordinary character', async () => {
    renderChat();
    const box = await input();
    await screen.findByRole('button', { name: 'Tag a skill' });
    fireEvent.keyDown(box, { key: '/' });
    expect(await screen.findByRole('menu', { name: 'Skills' })).toBeInTheDocument();
    expect(box).toHaveValue('');
    fireEvent.change(box, { target: { value: 'a' } });
    const ev = fireEvent.keyDown(box, { key: '/' });
    expect(ev).toBe(true); // not prevented
  });

  it('a tag can be removed before sending; with no tags the question carries no skills field', async () => {
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Fill rate?' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Tag a skill' }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Skills' })).getByRole('menuitemcheckbox', { name: /Coverage report/ }));
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Skills' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove skill: Coverage report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(Object.keys(sends()[0]![1]).sort()).toEqual(['clientRequestId', 'content']);
  });

  it('AI_SKILL_NOT_AVAILABLE: explained, the active list re-read, a tag no longer listed dropped, nothing resubmitted', async () => {
    renderChat();
    fireEvent.change(await input(), { target: { value: 'Fill rate?' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Tag a skill' }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Skills' })).getByRole('menuitemcheckbox', { name: /Coverage report/ }));
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Skills' }), { key: 'Escape' });
    submitError = { isAxiosError: true, response: { status: 400, data: { statusCode: 400, code: 'AI_SKILL_NOT_AVAILABLE', message: 'That skill is not available.' } } };
    skills = SKILLS.filter((s) => s.name !== 'coverage-report');
    const before = skillReads();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('A tagged skill isn’t available any more. Check the tags and send again.')).toBeInTheDocument();
    await waitFor(() => expect(skillReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove skill: Coverage report' })).not.toBeInTheDocument());
    expect(sends()).toHaveLength(1);
  });

  it('no active skills: no ＋ button and "/" types normally', async () => {
    skills = [];
    renderChat();
    const box = await input();
    await waitFor(() => expect(skillReads()).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Tag a skill' })).not.toBeInTheDocument();
    expect(fireEvent.keyDown(box, { key: '/' })).toBe(true);
  });
});

describe('"See what I can do" and "Draft a rota"', () => {
  const TOOLS = [
    { name: 'get_fill_rate', label: 'Fill rate', summary: 'Shifts filled vs needed.' },
    { name: 'create_draft_shift', label: 'Draft shift', summary: 'Creates a draft shift; nothing is sent to staff.' },
  ];

  // "Draft a rota" (writeTools + features.approvals) is tested in AiChatU5.spec.tsx.
  it('hidden while GET /ai/capabilities does not answer', async () => {
    renderChat();
    await input();
    await waitFor(() => expect(get.mock.calls.some(([u]) => u === '/ai/capabilities')).toBe(true));
    expect(screen.queryByRole('button', { name: 'See what I can do' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft a rota' })).not.toBeInTheDocument();
  });

  it('lists read tools and skills, and write tools apart as changes to approve', async () => {
    capabilities = { tools: TOOLS.slice(0, 1), writeTools: TOOLS.slice(1), skills: SKILLS.slice(0, 1) };
    renderChat();
    fireEvent.click(await screen.findByRole('button', { name: 'See what I can do' }));
    const sheet = await screen.findByRole('dialog', { name: 'What I can do' });
    expect(within(sheet).getByText('Information I can read').nextElementSibling).toHaveTextContent('Fill rate');
    expect(within(sheet).getByText('Changes I can suggest')).toBeInTheDocument();
    expect(within(sheet).getByText('Each one waits for you on a card. Nothing changes until you approve it.').nextElementSibling).toHaveTextContent('Draft shift');
    expect(within(sheet).getByText('Coverage report')).toBeInTheDocument();
  });
});

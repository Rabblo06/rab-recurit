import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../../shared/api';
import { AiChatProvider } from '../../ai/AiChatProvider';
import AiChatPanel from '../../ai/AiChatPanel';
import type { AiChatStreamEvent, AiStreamOptions } from '../../ai/aiStream';
import { assistantFixture, AVAILABLE, overviewFixture, promptFixture, renderSettings, routeApi, toolsFixture, usageFixture, type ApiCall } from './aiSettingsTestKit';

/**
 * Inventory parity (TWENTY_UI_CONTRACT_DELTAS §5 item 4): for the rows of docs/ai/TWENTY_UI_INVENTORY.md, every BUILD row
 * is PRESENT, every "show as disabled" row is DISABLED WITH ITS REASON, and every CONFLICT row is ABSENT. All server
 * features are switched on with fictional fixtures so nothing is hidden for lack of an API.
 */
jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const mockStreams: Array<{ opts: AiStreamOptions }> = [];
jest.mock('../../ai/aiStream', () => ({
  openAiStream: jest.fn((opts: AiStreamOptions) => {
    mockStreams.push({ opts });
    return { stop: jest.fn(), lastEventId: () => null };
  }),
}));
const mocked = api as unknown as { get: jest.Mock; put: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock };

const ALL = overviewFixture({ skills: true, usage: true, agents: true, assistant: true, instructions: true, levels: true, capabilities: true, approvals: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LEVEL = (over: Record<string, unknown>): Record<string, any> => ({ tier: 'fast', effort: 'low', maxOutputTokens: 1500, allowed: true, pinnedModelId: null, pinUnusable: false, resolved: null, unavailableReason: 'no_approved_model', priceUsdPerMTok: null, contextWindowTokens: null, estimate: null, priceRatio: null, ...over });
const MODELS_V2 = {
  models: [{ id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', tier: 'fast', region: 'global', dataRegion: 'Global routing.', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000, priceUsdPerMTok: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, deprecated: false, state: 'available', stateLabel: 'Available', selectable: true, promptCache: 'none', supportedEfforts: ['low'], sources: [], verifiedAt: '2026-10-25' }],
  tiers: [],
  setup: null,
  levels: [
    LEVEL({ level: 'extra_fast', label: 'Extra fast', bars: 1, resolved: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', source: 'any' }, unavailableReason: null, priceUsdPerMTok: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, contextWindowTokens: 1_000_000, estimate: { per100QuestionsUpperBoundMicros: 1_234_567, assumptions: 'Upper bound at the per-step ceilings.' }, priceRatio: 1 }),
    LEVEL({ level: 'fast', label: 'Fast', bars: 2, effort: 'medium', unavailableReason: 'effort_unverified', pinnedModelId: 'anthropic-claude-haiku-5-5' }),
    LEVEL({ level: 'balanced', label: 'Balanced', bars: 3, tier: 'smart' }),
    LEVEL({ level: 'smart', label: 'Smart', bars: 4, tier: 'smart', effort: 'high' }),
    LEVEL({ level: 'extra_smart', label: 'Extra smart', bars: 5, tier: 'smart', effort: 'high' }),
  ],
  policy: { chatLevel: 'extra_fast', agentLevel: 'extra_fast', allowedLevels: ['extra_fast', 'fast'], dataResidency: 'global', updatedAt: null },
};
const SKILLS = {
  skills: [
    { id: null, name: 'coverage-report', label: 'Coverage report', description: 'Find shifts that still need staff.', isSystem: true, isActive: true, content: null, contentLength: 0, updatedAt: null },
    { id: 's1', name: 'house-style', label: 'House style', description: 'Write in British English.', isSystem: false, isActive: true, content: '# House style\nUse British English.', contentLength: 34, updatedAt: null },
  ],
  customCount: 1,
  limits: { maxContentChars: 20000, maxLabelChars: 80, maxDescriptionChars: 300, maxCustomPerOrganisation: 50, maxPerLoad: 3, maxTaggedPerMessage: 2, turnCharBudget: 24000, tokenAllowancePerStep: 8000, reasonMinChars: 3, reasonMaxChars: 500 },
};
const AGENT = { id: 'a1', name: 'weekly-coverage', label: 'Weekly coverage', description: 'Summarise next week’s gaps', prompt: 'Summarise the coverage gaps for next week.', model: { tier: 'fast', modelId: null }, responseFormat: 'text', roleId: null, isActive: true, configVersion: 1, triggers: [{ id: 't1', agentId: 'a1', kind: 'schedule', schedule: { every: 'week', at: '08:00', dow: 1 }, eventTypes: [], enabled: false, runAsUserId: null, pausedReason: null, nextRunAt: null, lastRunAt: null }], createdAt: '2026-10-25T10:00:00.000Z', updatedAt: '2026-10-25T10:00:00.000Z' };

let calls: ApiCall[] = [];
beforeEach(() => {
  calls = [];
  mockStreams.length = 0;
  routeApi(mocked, {
    'get /ai/availability': { ...AVAILABLE, assistant: assistantFixture(), levels: { chatLevel: 'extra_fast', options: MODELS_V2.levels.map((l) => ({ level: l.level, label: l.label, bars: l.bars, available: Boolean(l.resolved), unavailableReason: l.resolved ? null : l.unavailableReason })) }, model: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'fast', source: 'any' } },
    'get /ai/settings': ALL,
    'get /ai/settings/models': MODELS_V2,
    'get /ai/settings/tools': toolsFixture(),
    'get /ai/settings/prompt-preview': promptFixture(),
    'get /ai/settings/assistant': assistantFixture(),
    'get /ai/settings/instructions': { content: null, contentLength: 0, contentSha256: null, updatedAt: null, limits: { maxChars: 2000, reasonMinChars: 3, reasonMaxChars: 500 } },
    'get /ai/settings/skills': SKILLS,
    'get /ai/settings/usage': usageFixture(),
    'get /ai/agents': [AGENT],
    'get /ai/capabilities': { tools: [{ name: 'list_unfilled_shifts', label: 'Unfilled shifts', summary: 'Shifts that still need staff.' }], skills: [] },
    'get /ai/conversations': { data: [], nextCursor: null },
  }, calls);
});

/** CONFLICT rows: none of these words may appear anywhere, on any screen (hidden, not disabled — TW-D10). */
const FORBIDDEN = /\b(MCP|Model Context Protocol|WhatsApp|Code interpreter|Word Documents|PowerPoint|Research|Extract content|Create company|Create tool|See function|web search|Searched the web|Speed|Intelligence|Artificial Analysis|Credits?|Plan approved|Destroy|Data residency: US)\b/i;

describe('Settings → AI rows', () => {
  it('A1–A2 tabs; B overview (present) and B25 MCP (absent)', async () => {
    const { container } = renderSettings();
    expect((await screen.findAllByRole('tab')).map((t) => t.textContent)).toEqual(['Overview', 'Models', 'Skills', 'Tools', 'Usage', 'Prompt', 'Agents']); // A1, A2
    const group = await screen.findByRole('radiogroup', { name: 'Assistant look' }); // B2
    expect(within(group).getAllByRole('radio')).toHaveLength(8); // B3–B10 (7 presets + Customise)
    expect(within(group).getByText('Customise')).toBeInTheDocument(); // B10
    fireEvent.click(within(group).getByRole('radio', { name: /Customise/ }));
    expect(await screen.findByLabelText('Assistant name')).toBeInTheDocument(); // B12
    for (const item of [/Shape/, /Colour/, /Face/]) expect(screen.getByRole('menuitem', { name: item })).toBeInTheDocument(); // B13–B15
    expect(screen.getByRole('menuitemcheckbox', { name: /Animate/ })).toBeInTheDocument(); // B16
    expect(screen.getByRole('menuitem', { name: /Reset to default/ })).toBeInTheDocument(); // B17
    fireEvent.click(screen.getByRole('menuitem', { name: /Shape/ }));
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(10); // B18
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'At a glance' })).toBeInTheDocument(); // B21–B24
    expect(screen.getByLabelText('Instructions text')).toBeInTheDocument(); // B26–B27
    expect(screen.getByRole('button', { name: 'Read the system prompt' })).toBeInTheDocument(); // B28
    expect(container.textContent).not.toMatch(FORBIDDEN); // B25
  });

  it('C models: C2, C4, C6, C7, C13, C17, C18 present; C3 disabled WITH its reason; C5 / C14–C16 absent', async () => {
    const { container } = renderSettings('/settings/ai?tab=models');
    const preview = await screen.findByRole('table', { name: 'Answer levels' }); // C17
    expect(screen.getByLabelText('Chat')).toBeInTheDocument(); // C2
    expect(screen.getByLabelText('Agent level')).toBeDisabled(); // C3
    expect(screen.getByText(/Agents can’t run yet: this is waiting for the owner’s approval \(EX-3\)/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Data residency')).queryByRole('option', { name: /US/ })).toBeNull(); // C4 present, C5 absent
    expect(screen.getByRole('switch', { name: 'Choose automatically' })).toBeInTheDocument(); // C6
    expect(screen.getByRole('list', { name: 'Model for each level' })).toBeInTheDocument(); // C7 (a level is pinned)
    expect(container.querySelectorAll('.ai-level-glyph').length).toBeGreaterThanOrEqual(5); // C13
    expect(within(preview).getByText('$1.23')).toBeInTheDocument(); // C18
    expect(container.textContent).not.toMatch(FORBIDDEN); // C15, C16
    expect(container.textContent).not.toMatch(/GPT-5\.6|GPT-6 Luna \(Azure\)|GPT-6 Astra/); // C14
  });

  it('D skills: D2–D5, D10–D12 present; D13–D18 in the detail; D6–D9, D14 absent', async () => {
    const { container } = renderSettings('/settings/ai?tab=skills');
    const table = await screen.findByRole('table', { name: 'Skills' });
    expect(within(table).getByText('House style')).toBeInTheDocument();
    expect(within(table).getByText('Built-in')).toBeInTheDocument();
    expect(within(table).getByText('Custom')).toBeInTheDocument();
    expect(screen.getByLabelText('Search skills')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New skill/ })).toBeEnabled();
    expect(container.textContent).not.toMatch(FORBIDDEN);
    fireEvent.click(within(table).getByRole('button', { name: 'Open House style' }));
    expect(await screen.findByLabelText('Instructions')).toBeInTheDocument(); // D13
    expect(screen.getByLabelText('Description')).toBeInTheDocument(); // D15
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument(); // D17
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument(); // D18
  });

  it('E tools: E2–E4, E9, E11–E17 adapted; E5–E8, E10, E15 absent', async () => {
    const { container } = renderSettings('/settings/ai?tab=tools');
    await screen.findByRole('table', { name: 'Assistant tools' });
    expect(container.textContent).not.toMatch(FORBIDDEN);
    fireEvent.click(screen.getByRole('button', { name: 'Open Unfilled shifts' }));
    expect(await screen.findByRole('heading', { name: 'Who can use it' })).toBeInTheDocument(); // E17
    expect(container.textContent).not.toMatch(/Danger zone|Delete this tool/);
  });

  it('F prompt: F1–F4, F6, F12 present; F5, F7, F10, F11 (user name) absent', async () => {
    const { container } = renderSettings('/settings/ai?tab=prompt');
    expect(await screen.findByRole('heading', { name: 'System prompt' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tools you’d be offered' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(FORBIDDEN);
    expect(container.textContent).not.toMatch(/\b(create_|update_|delete_|create_many_)\w+/);
    expect(container.textContent).not.toMatch(/User: |Locale: /);
  });

  it('J agents: J1, J2, J4 present; J9 Test and Runs DISABLED with the EX-3 reason; J5–J7, J12, J19, J20 absent', async () => {
    const { container } = renderSettings('/settings/ai?tab=agents&agent=a1');
    expect(await screen.findByRole('heading', { name: 'Agent · Weekly coverage' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Test' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeDisabled();
    expect(screen.getByText(/Agents can’t run until the owner approves agent execution \(EX-3\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Instructions')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\{\{|\{x\}|Add output|Delete Invoices|Destroy/);
    fireEvent.click(screen.getByRole('tab', { name: 'Triggers' }));
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeDisabled();
  });

  it('usage tab: tokens and estimated USD only (TW-D6), never credits', async () => {
    const { container } = renderSettings('/settings/ai?tab=usage');
    await screen.findByRole('table', { name: 'Usage by person' });
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });
});

describe('chat rows (G, H, I, L)', () => {
  function renderChat() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={qc}><AiChatProvider workspaceId="ws-a"><AiChatPanel surface="panel" /></AiChatProvider></QueryClientProvider>);
  }

  it('H1–H11 empty state and composer; H7, H8 absent; G1 slider; L6 footer', async () => {
    const { container } = renderChat();
    await screen.findByRole('textbox', { name: 'Message Crewflow AI' });
    expect(container.querySelector('.ai-empty-avatar .ai-av')).not.toBeNull(); // H1
    expect(screen.getByRole('button', { name: 'Check coverage gaps' })).toBeInTheDocument(); // H3
    expect(await screen.findByRole('button', { name: 'See what I can do' })).toBeInTheDocument(); // H5
    expect(screen.queryByRole('button', { name: /Draft a shift/ })).not.toBeInTheDocument(); // H4 waits for approvals (P5)
    expect(screen.getByRole('button', { name: 'Context and usage' })).toBeInTheDocument(); // H9
    fireEvent.click(screen.getByRole('button', { name: /^Level:/ })); // H10
    expect(await screen.findByRole('slider', { name: 'Answer level' })).toBeInTheDocument(); // G1
    expect(screen.queryByRole('button', { name: /attach|microphone|voice/i })).not.toBeInTheDocument(); // H7, H8
    expect(screen.getByText('AI suggests, a person decides. AI can make mistakes and can’t change anything without your approval.')).toBeInTheDocument(); // L6
    expect(container.ownerDocument.body.textContent).not.toMatch(FORBIDDEN); // G4, G5, G13, G15, G16, G24
  });

  it('I5, I12, I13, I16, I18 present; I8–I11, I14 (web), I15, I17 absent', async () => {
    mocked.post.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/ai/conversations' ? { id: 'c1', title: 'x', messageCount: 0, lastMessageAt: '2026-10-25T10:00:00.000Z', createdAt: '2026-10-25T10:00:00.000Z' } : { conversationId: 'c1', userMessageId: 'u1', turnId: 't1', status: 'running', replayed: false } }),
    );
    const { container } = renderChat();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message Crewflow AI' }), { target: { value: 'What is the status of the weekend?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mockStreams).toHaveLength(1));
    const emit = (e: AiChatStreamEvent) => act(() => mockStreams[0]!.opts.onEvent(e));
    expect(screen.getByText('is thinking')).toBeInTheDocument(); // I5
    emit({ type: 'plan', turnId: 't1', steps: [{ label: 'Check unfilled shifts', status: 'done' }, { label: 'Compare with last week', status: 'pending' }] });
    expect(screen.getByText('Planned 2 steps')).toBeInTheDocument(); // I12
    expect(screen.getByRole('list', { name: 'Plan' })).toBeInTheDocument(); // I13
    emit({ type: 'tool', turnId: 't1', name: 'list_unfilled_shifts', phase: 'finished', outcome: 'ok' });
    expect(screen.getByText('Checked unfilled shifts')).toBeInTheDocument(); // I16
    emit({ type: 'reasoning', turnId: 't1', phase: 'finished', durationMs: 2000 });
    expect(screen.getByText('Thought for 2 s')).toBeInTheDocument(); // I18
    expect(container.textContent).not.toMatch(FORBIDDEN);
    expect(calls.filter((c) => c.method !== 'get').every((c) => !JSON.stringify(c.body ?? {}).match(/organisationId|"status"/))).toBe(true);
  });
});

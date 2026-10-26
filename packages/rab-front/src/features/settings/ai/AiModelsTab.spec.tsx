import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InternalAxiosRequestConfig } from 'axios';
import { AI_STATE_MESSAGE } from '@rab/shared';

import { api } from '../../../shared/api';
import { TOAST_EVENT } from '../../../shared/lib/toast';
import StepUpHost from '../../auth/stepup/StepUpHost';
import { AiChatProvider } from '../../ai/AiChatProvider';
import { MemoryRouter } from 'react-router-dom';
import AiSettingsPage from './AiSettingsPage';

/**
 * A REAL axios instance with the app's real step-up replay (shared/lib/step-up-retry) and the real "Confirm it's you"
 * host, behind a fake adapter: proves the page goes through the shared step-up flow on 403 STEP_UP_REQUIRED.
 */
jest.mock('../../../shared/api', () => {
  const axios = jest.requireActual('axios');
  const retry = jest.requireActual('../../../shared/lib/step-up-retry');
  const instance = axios.create({ baseURL: 'http://api.test/rest/v1' });
  retry.installStepUpRetry(instance);
  return { api: instance, registerStepUpHandler: retry.registerStepUpHandler };
});

const LIMITS = { maxInputChars: 4000, userRatePerMinute: 6, orgDailyTokenBudget: 200000 };
const model = (over: object = {}) => ({
  id: 'anthropic-claude-haiku-5-5',
  label: 'Claude Haiku 5.5',
  provider: 'anthropic',
  tier: 'fast',
  region: 'global',
  dataRegion: 'Global routing on the Claude API.',
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 128_000,
  priceUsdPerMTok: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  deprecated: false,
  state: 'available',
  stateLabel: 'Available',
  selectable: true,
  ...over,
});
const MODELS = [
  model(),
  model({ id: 'anthropic-claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'smart', priceUsdPerMTok: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }, state: 'not_approved', stateLabel: 'Not approved', selectable: false }),
  model({ id: 'anthropic-claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'smart', priceUsdPerMTok: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 }, state: 'not_approved', stateLabel: 'Not approved', selectable: false }),
  model({ id: 'openai-gpt-6-luna-eu', label: 'OpenAI GPT-6 Luna (EU endpoint)', provider: 'openai', region: 'eu', contextWindowTokens: 1_050_000, priceUsdPerMTok: { input: 0.11, cachedInput: 0.011, cacheWrite: null, output: 0.55 }, state: 'not_approved', stateLabel: 'Not approved', selectable: false }),
];
const view = (fastPin: string | null, over: object = {}) => ({
  models: MODELS,
  tiers: [
    { tier: 'fast', pinnedModelId: fastPin, pinUnusable: false, resolved: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', source: fastPin ? 'pin' : 'any' }, updatedAt: null },
    { tier: 'smart', pinnedModelId: null, pinUnusable: false, resolved: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', source: 'nearest' }, updatedAt: null },
  ],
  setup: null,
  ...over,
});

const OVERVIEW = (features: object = {}) => ({
  features: { skills: false, tools: true, usage: false, promptPreview: true, approvals: false, agents: false, agentExecution: false, assistant: false, instructions: false, levels: false, capabilities: false, ...features },
  counts: { myConversations: 2, orgQuestionsThisMonth: 14, activeSkills: 0, tools: 5 },
  limits: { maxInputChars: 4000, userRatePerMinute: 10, orgRatePerMinute: 0, userTurnsPerDay: 0, orgDailyTokenBudget: 200000, orgDailyCostCeilingMicros: 5_000_000, userDailyCostCeilingMicros: 0 },
});

type Reply = { status: number; data: unknown };
let routes: Record<string, (config: InternalAxiosRequestConfig) => Reply>;
const calls: Array<{ method: string; url: string; body: unknown }> = [];

function axiosError(config: InternalAxiosRequestConfig, status: number, data: unknown) {
  const { AxiosError } = jest.requireActual('axios');
  return new AxiosError(`status ${status}`, 'ERR_BAD_REQUEST', config, null, { status, statusText: '', headers: {}, config, data });
}

beforeEach(() => {
  calls.length = 0;
  routes = {
    'get /ai/availability': () => ({ status: 200, data: { available: true, reason: null, limits: LIMITS, usage: { day: '2026-10-25', tokensUsedOrReserved: 0 } } }),
    'get /ai/settings/models': () => ({ status: 200, data: view(null) }),
    'get /ai/settings': () => ({ status: 200, data: OVERVIEW() }),
    'get /auth/mfa': () => ({ status: 200, data: { hasPassword: true, ssoReauthProviders: [] } }),
  };
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const method = (config.method ?? 'get').toLowerCase();
    const url = String(config.url);
    calls.push({ method, url, body: config.data ? JSON.parse(String(config.data)) : undefined });
    const route = routes[`${method} ${url}`];
    const reply = route ? route(config) : { status: 404, data: { statusCode: 404, message: 'Not found.' } };
    if (reply.status >= 400) throw axiosError(config, reply.status, reply.data);
    return { data: reply.data, status: reply.status, statusText: 'OK', headers: {}, config };
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiChatProvider workspaceId="ws-a">
        <MemoryRouter initialEntries={['/settings/ai?tab=models']}>
          <AiSettingsPage />
        </MemoryRouter>
      </AiChatProvider>
      <StepUpHost />
    </QueryClientProvider>,
  );
}
const writes = () => calls.filter((c) => c.method === 'put' || c.method === 'delete');

it('lists every catalogue model with price, region and its state label; each tier offers ONLY selectable models plus "Choose automatically"', async () => {
  renderPage();
  const table = await screen.findByRole('table', { name: 'AI model catalogue' });
  for (const m of MODELS) expect(within(table).getByText(m.label)).toBeInTheDocument();
  const haiku = within(table).getByText('Claude Haiku 5.5').closest('tr')!;
  expect(within(haiku).getByText('Available')).toBeInTheDocument();
  expect(within(haiku).getByText('0.10 / 0.01 / 0.50')).toBeInTheDocument();
  expect(within(within(table).getByText('OpenAI GPT-6 Luna (EU endpoint)').closest('tr')!).getByText('EU')).toBeInTheDocument();
  expect(within(table).getAllByText('Not approved')).toHaveLength(3);

  const fast = screen.getByLabelText('Chat model (fast)');
  expect(within(fast).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose automatically', 'Claude Haiku 5.5']);
  expect(fast).toHaveValue('');
  // Sonnet / Opus are smart-tier but not approved: nothing but automatic can be chosen there.
  const smart = screen.getByLabelText('Smart model');
  expect(within(smart).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose automatically']);
  expect(screen.getByText('Using: Claude Haiku 5.5 (automatic)', { selector: '.ai-models-tier:first-child p' })).toBeInTheDocument();
});

it('pinning asks for a reason first, then goes through the shared "Confirm it’s you" step-up and replays once; success only after the server saved it', async () => {
  const toasts: string[] = [];
  const onToast = (e: Event) => toasts.push((e as CustomEvent).detail.message);
  document.addEventListener(TOAST_EVENT, onToast);
  let stepped = false;
  routes['put /ai/settings/models/fast'] = () => (stepped ? { status: 200, data: view('anthropic-claude-haiku-5-5') } : { status: 403, data: { statusCode: 403, code: 'STEP_UP_REQUIRED', mfa: false, message: 'Confirm it’s you to continue.' } });
  routes['post /auth/step-up'] = () => {
    stepped = true;
    return { status: 200, data: { validUntil: 'x', mfa: false } };
  };
  renderPage();
  fireEvent.change(await screen.findByLabelText('Chat model (fast)'), { target: { value: 'anthropic-claude-haiku-5-5' } });
  const dialog = await screen.findByRole('dialog', { name: /Use Claude Haiku 5\.5 for the fast tier/ });
  // No reason → nothing is sent.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give a reason of 3 to 500 characters');
  expect(writes()).toEqual([]);
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Pilot with synthetic data' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  // The server refused (stale session): the ONE shared step-up prompt appears.
  expect(await screen.findByRole('heading', { name: 'Confirm it’s you' })).toBeInTheDocument();
  expect(screen.getByLabelText('Chat model (fast)')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Chat model (fast)')).toHaveValue('anthropic-claude-haiku-5-5'));
  expect(writes()).toEqual([
    { method: 'put', url: '/ai/settings/models/fast', body: { modelId: 'anthropic-claude-haiku-5-5', reason: 'Pilot with synthetic data' } },
    { method: 'put', url: '/ai/settings/models/fast', body: { modelId: 'anthropic-claude-haiku-5-5', reason: 'Pilot with synthetic data' } },
  ]);
  expect(calls.find((c) => c.url === '/auth/step-up')?.body).toEqual({ currentPassword: 'pw' });
  expect(screen.getByText('Using: Claude Haiku 5.5', { selector: '.ai-models-tier:first-child p' })).toBeInTheDocument();
  expect(toasts).toEqual(['Model changed: Claude Haiku 5.5']);
  expect(screen.queryByRole('dialog', { name: /Use Claude Haiku/ })).not.toBeInTheDocument();
  document.removeEventListener(TOAST_EVENT, onToast);
});

it('cancelling the step-up saves nothing, raises no toast, and the select keeps the SAVED value', async () => {
  const toasts: string[] = [];
  const onToast = (e: Event) => toasts.push((e as CustomEvent).detail.message);
  document.addEventListener(TOAST_EVENT, onToast);
  routes['put /ai/settings/models/fast'] = () => ({ status: 403, data: { statusCode: 403, code: 'STEP_UP_REQUIRED', mfa: false, message: 'Confirm it’s you to continue.' } });
  renderPage();
  fireEvent.change(await screen.findByLabelText('Chat model (fast)'), { target: { value: 'anthropic-claude-haiku-5-5' } });
  const dialog = await screen.findByRole('dialog', { name: /Use Claude Haiku/ });
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Pilot' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const prompt = (await screen.findByRole('heading', { name: 'Confirm it’s you' })).closest('[role="dialog"]') as HTMLElement;
  fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('not saved');
  expect(toasts).toEqual([]);
  expect(screen.getByLabelText('Chat model (fast)')).toHaveValue('');
  document.removeEventListener(TOAST_EVENT, onToast);
});

it('"Choose automatically" removes the pin with a reason (DELETE with a body)', async () => {
  routes['get /ai/settings/models'] = () => ({ status: 200, data: view('anthropic-claude-haiku-5-5') });
  routes['delete /ai/settings/models/fast'] = () => ({ status: 200, data: view(null) });
  renderPage();
  const fast = await screen.findByLabelText('Chat model (fast)');
  await waitFor(() => expect(fast).toHaveValue('anthropic-claude-haiku-5-5'));
  fireEvent.change(fast, { target: { value: '' } });
  const dialog = await screen.findByRole('dialog', { name: /Choose the fast model automatically/ });
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Back to automatic' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByLabelText('Chat model (fast)')).toHaveValue(''));
  expect(writes()).toEqual([{ method: 'delete', url: '/ai/settings/models/fast', body: { reason: 'Back to automatic' } }]);
});

it('a model the server refuses (400 AI_MODEL_NOT_AVAILABLE) is shown in the dialog and the list is re-read', async () => {
  routes['put /ai/settings/models/fast'] = () => ({ status: 400, data: { statusCode: 400, code: 'AI_MODEL_NOT_AVAILABLE', message: 'Not available.' } });
  renderPage();
  fireEvent.change(await screen.findByLabelText('Chat model (fast)'), { target: { value: 'anthropic-claude-haiku-5-5' } });
  const dialog = await screen.findByRole('dialog', { name: /Use Claude Haiku/ });
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Pilot' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('That model is not available');
  await waitFor(() => expect(calls.filter((c) => c.url === '/ai/settings/models').length).toBeGreaterThanOrEqual(2));
});

it('a stored pin that can no longer be used is shown as skipped, never offered as a choice', async () => {
  routes['get /ai/settings/models'] = () => ({
    status: 200,
    data: {
      ...view(null),
      models: [model({ state: 'key_not_configured', stateLabel: 'Key not configured', selectable: false }), ...MODELS.slice(1)],
      tiers: [
        { tier: 'fast', pinnedModelId: 'anthropic-claude-haiku-5-5', pinUnusable: true, resolved: null, updatedAt: null },
        { tier: 'smart', pinnedModelId: null, pinUnusable: false, resolved: null, updatedAt: null },
      ],
      setup: 'provider',
    },
  });
  renderPage();
  const fast = await screen.findByLabelText('Chat model (fast)');
  await waitFor(() => expect(fast).toHaveValue('anthropic-claude-haiku-5-5'));
  const pinned = within(fast).getByRole('option', { name: 'Claude Haiku 5.5 (not available)' }) as HTMLOptionElement;
  expect(pinned.disabled).toBe(true);
  expect(screen.getByText(/can’t be used right now/)).toBeInTheDocument();
  expect(screen.getAllByText('No model is available for this tier.')).toHaveLength(2);
  expect(within(screen.getByRole('table', { name: 'AI model catalogue' })).getByText('Key not configured')).toBeInTheDocument();
});

it('not set up: the fixed message is shown above the picker', async () => {
  routes['get /ai/availability'] = () => ({ status: 200, data: { available: false, reason: 'not_configured', setup: 'model', message: AI_STATE_MESSAGE.NOT_CONFIGURED_MODEL, limits: LIMITS, usage: null } });
  renderPage();
  expect(await screen.findByText('Choose a model in Settings → AI')).toBeInTheDocument();
  expect(await screen.findByRole('table', { name: 'AI model catalogue' })).toBeInTheDocument();
});

it('an organisation whose AI is off (or an ineligible user) sees no picker and never reads the settings', async () => {
  routes['get /ai/availability'] = () => ({ status: 200, data: { available: false, reason: 'organisation_disabled', limits: LIMITS, usage: null } });
  renderPage();
  expect(await screen.findByText(/not available for your organisation/)).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(calls.some((c) => c.url === '/ai/settings/models')).toBe(false);
  expect(calls.some((c) => c.url === '/ai/settings')).toBe(false);
});

// ── C1 levels (CD-1 / CD-2): rendered only when the server serves them ─────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LEVEL = (over: Record<string, unknown>): Record<string, any> => ({
  tier: 'fast', effort: 'low', maxOutputTokens: 1500, allowed: true, pinnedModelId: null, pinUnusable: false,
  resolved: null, unavailableReason: 'no_approved_model', priceUsdPerMTok: null, contextWindowTokens: null, estimate: null, priceRatio: null, ...over,
});
const LEVELS = [
  LEVEL({ level: 'extra_fast', label: 'Extra fast', bars: 1, resolved: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', source: 'any' }, unavailableReason: null, priceUsdPerMTok: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, contextWindowTokens: 1_000_000, estimate: { per100QuestionsUpperBoundMicros: 1_234_567, assumptions: '100 questions at the per-step ceilings (upper bound).' }, priceRatio: 1 }),
  LEVEL({ level: 'fast', label: 'Fast', bars: 2, effort: 'medium', maxOutputTokens: 4000, unavailableReason: 'effort_unverified' }),
  LEVEL({ level: 'balanced', label: 'Balanced', bars: 3, tier: 'smart', allowed: false }),
  LEVEL({ level: 'smart', label: 'Smart', bars: 4, tier: 'smart', effort: 'high', allowed: false }),
  LEVEL({ level: 'extra_smart', label: 'Extra smart', bars: 5, tier: 'smart', effort: 'high', allowed: false }),
];
const POLICY = { chatLevel: 'extra_fast', agentLevel: 'extra_fast', allowedLevels: ['extra_fast', 'fast'], dataResidency: 'global', updatedAt: null };

it('T8-S2 / U1 levels: chat level, the agents row DISABLED with its EX-3 reason, residency Any + EU (UK disabled, no US), and a preview with no invented numbers', async () => {
  routes['get /ai/settings'] = () => ({ status: 200, data: OVERVIEW({ levels: true }) });
  routes['get /ai/settings/models'] = () => ({ status: 200, data: { ...view(null), levels: LEVELS, policy: POLICY } });
  renderPage();
  const preview = await screen.findByRole('table', { name: 'Answer levels' });
  const chat = screen.getByLabelText('AI chat');
  expect(chat).toHaveValue('extra_fast');
  expect((within(chat).getByRole('option', { name: /^Fast — Unavailable: effort not verified yet/ }) as HTMLOptionElement).disabled).toBe(true);
  const agents = screen.getByLabelText('Agent level');
  expect(agents).toBeDisabled();
  expect(screen.getByText(/Agents can’t run yet: this is waiting for the owner’s approval \(EX-3\)/)).toBeInTheDocument();
  const residency = screen.getByLabelText('Data residency');
  expect(within(residency).getAllByRole('option').map((o) => o.textContent)).toEqual(['Any region', 'EU', 'UK — No approved UK-hosted model']);
  expect((within(residency).getByRole('option', { name: /UK/ }) as HTMLOptionElement).disabled).toBe(true);
  const extraFast = within(preview).getByText('Extra fast').closest('tr')!;
  expect(within(extraFast).getByText('Claude Haiku 5.5')).toBeInTheDocument();
  expect(within(extraFast).getByText('×1')).toBeInTheDocument();
  expect(within(extraFast).getAllByTitle('No verified source yet')).toHaveLength(2);
  expect(within(within(preview).getByText('Fast', { exact: true }).closest('tr')!).getByText('Unavailable: effort not verified yet')).toBeInTheDocument();
  expect(within(within(preview).getByText('Balanced').closest('tr')!).getByText('No approved model')).toBeInTheDocument();
  // No fabricated benchmark columns (TW-D9), no "credits" (TW-D6).
  // Speed / Intelligence columns hold "—" only (no verified source); no throughput or score anywhere.
  expect(preview.textContent).not.toMatch(/tok\/s|\b\d{2,3}\b(?!,)/);
  expect(screen.queryByText(/credits/i)).not.toBeInTheDocument();
});

it('T8-S2 levels: changing the chat level sends ONLY the named field plus the reason (no organisationId, no status)', async () => {
  routes['get /ai/settings'] = () => ({ status: 200, data: OVERVIEW({ levels: true }) });
  const LEVELS_OK = LEVELS.map((l) => (l.level === 'fast' ? { ...l, resolved: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', source: 'any' }, unavailableReason: null } : l));
  routes['get /ai/settings/models'] = () => ({ status: 200, data: { ...view(null), levels: LEVELS_OK, policy: POLICY } });
  routes['put /ai/settings/model-policy'] = () => ({ status: 200, data: { ...view(null), levels: LEVELS_OK, policy: { ...POLICY, chatLevel: 'fast' } } });
  renderPage();
  fireEvent.change(await screen.findByLabelText('AI chat'), { target: { value: 'fast' } });
  const dialog = await screen.findByRole('dialog', { name: /Use Fast for chat/ });
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Try medium effort' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByLabelText('AI chat')).toHaveValue('fast'));
  expect(writes()).toEqual([{ method: 'put', url: '/ai/settings/model-policy', body: { reason: 'Try medium effort', chatLevel: 'fast' } }]);
});

it('without the levels API the tab says so honestly and keeps the tier pickers (no fake levels)', async () => {
  renderPage();
  expect(await screen.findByText(/Not available yet\. The five answer levels/)).toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'Answer levels' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Chat model (fast)')).toBeInTheDocument();
});

it('U1: no API key or provider value ever reaches the screen, whatever a response carries', async () => {
  const CANARY = 'sk-ant-api03-U1CANARY'.padEnd(64, 'Q');
  routes['get /ai/settings'] = () => ({ status: 200, data: OVERVIEW({ levels: true }) });
  routes['get /ai/settings/models'] = () => ({
    status: 200,
    data: { ...view(null), levels: LEVELS, policy: POLICY, apiKey: CANARY, providerKey: CANARY, models: MODELS.map((m) => ({ ...m, apiKeyEnv: 'ANTHROPIC_API_KEY', apiKey: CANARY, baseURL: 'https://provider.example.test/v1' })) },
  });
  const { container } = renderPage();
  await screen.findByRole('table', { name: 'Answer levels' });
  expect(container.innerHTML).not.toContain('U1CANARY');
  expect(container.textContent).not.toMatch(/sk-ant|ANTHROPIC_API_KEY|provider\.example\.test/);
});

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { TOAST_EVENT } from '../../../shared/lib/toast';
import { renderWithQuery, routeGet } from './adminPanelTestKit';
import { AiConfigSection, AiHealthSection, AiPrivacySection, OrganisationAiSwitch } from './AiAdminSections';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;

const ORG = 'aaaaaaaa-1111-4222-8333-444455556666';
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
  state: 'key_not_configured',
  stateLabel: 'Key not configured',
  selectable: false,
  ...over,
});
const OVERVIEW = {
  platformEnabled: true,
  models: [
    model(),
    model({ id: 'anthropic-claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'smart', priceUsdPerMTok: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }, state: 'not_approved', stateLabel: 'Not approved' }),
    model({ id: 'openai-gpt-6-luna-eu', label: 'OpenAI GPT-6 Luna (EU endpoint)', provider: 'openai', region: 'eu', priceUsdPerMTok: { input: 0.11, cachedInput: 0.011, cacheWrite: null, output: 0.55 }, state: 'not_approved', stateLabel: 'Not approved' }),
  ],
  providerKeys: [
    { provider: 'anthropic', envName: 'ANTHROPIC_API_KEY', configured: false, sdkInstalled: true },
    { provider: 'openai', envName: 'OPENAI_API_KEY', configured: false, sdkInstalled: false },
  ],
  defaults: { fast: [], smart: [], disabled: [] },
  readiness: { ready: false, realProvidersPermitted: false, problems: [{ code: 'no_provider_key', message: 'No provider key is configured.' }] },
  telemetry: 'disabled',
  limits: { maxOutputTokens: 1500, maxSteps: 8, maxInputChars: 4000, orgDailyTokenBudget: 200000, turnTokenReservation: 44000, userRatePerMinute: 6, orgMaxActiveTurns: 2, turnTimeoutSeconds: 90, historyMessages: 20, messagesPerConversation: 200, storedCharsPerMessage: 16000, toolRows: 25 },
  retention: { days: 90, mode: 'off', intervalMinutes: 60 },
  queue: { name: 'rab-ai', available: true, waiting: 1, active: 2, delayed: 0, failed: 3, completed: 40 },
  tools: [
    { name: 'list_unfilled_shifts', kind: 'read', permission: 'schedule.view', maxRows: 25 },
    { name: 'compare_payroll_runs', kind: 'read', permission: 'payroll.view', maxRows: 2 },
  ],
};
const usageRow = (over: object = {}) => ({ organisationId: ORG, organisationName: 'Org A Ltd', aiEnabled: true, inputTokens: 150000, outputTokens: 20000, turns: 12, failedTurns: 2, cancelledTurns: 1, toolCalls: 11, ...over });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  routeGet(get, {
    '/admin/ai/overview': OVERVIEW,
    '/admin/ai/usage': () => ({ from: '2026-10-25', to: '2026-10-25', organisations: [usageRow(), usageRow({ organisationId: 'bbbbbbbb-1111-4222-8333-444455556666', organisationName: 'Org B Ltd', aiEnabled: false, inputTokens: 10, outputTokens: 5, turns: 1, failedTurns: 0 })] }),
    [`/admin/ai/organisations/${ORG}/setting`]: { organisationId: ORG, enabled: false, updatedAt: null },
  });
});

it('Health: switch, provider, rab-ai queue counts and per-organisation usage against the daily budget — counts only', async () => {
  renderWithQuery(<AiHealthSection />);
  expect(await screen.findByText('Enabled')).toBeInTheDocument();
  expect(screen.getByText('None available')).toBeInTheDocument();
  expect(screen.getByText(/0 of 2 provider keys configured · 3 models in the catalogue/)).toBeInTheDocument();
  expect(screen.getByText('3 failed')).toBeInTheDocument();
  expect(screen.getByText(/Queued 1 · running 2 · delayed 0 · completed 40/)).toBeInTheDocument();
  const table = await screen.findByRole('table');
  const rowA = within(table).getByText('Org A Ltd').closest('tr')!;
  expect(within(rowA).getByText('85 %')).toHaveClass('ap-warn'); // 170 000 of 200 000 → amber from 80 %
  expect(within(rowA).getByText('12')).toBeInTheDocument();
  expect(within(table).getByText('Org B Ltd')).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith('/admin/ai/usage', { params: expect.objectContaining({ limit: 200 }) });
  // The 7-day range asks the server for a 7-day window and shows an average instead of a budget share.
  fireEvent.click(screen.getByRole('button', { name: '7 days' }));
  await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Avg / day' })).toBeInTheDocument());
  const last = get.mock.calls.filter(([u]) => u === '/admin/ai/usage').pop()!;
  const { from, to } = last[1].params;
  expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(6);
});

it('Config: every catalogue model with its state label, provider key status configured / not configured (never a value), limits and the tool catalogue', async () => {
  const { container } = renderWithQuery(<AiConfigSection />);
  const models = await screen.findByRole('table', { name: 'AI models' });
  const haiku = within(models).getByText('Claude Haiku 5.5').closest('tr')!;
  expect(within(haiku).getByText('Key not configured')).toBeInTheDocument();
  expect(within(haiku).getByText('$0.10')).toBeInTheDocument();
  expect(within(models).getAllByText('Not approved')).toHaveLength(2);
  const keys = screen.getByRole('table', { name: 'AI provider keys' });
  const anthropic = within(keys).getByText('ANTHROPIC_API_KEY').closest('tr')!;
  expect(within(anthropic).getByText('Not configured')).toBeInTheDocument();
  expect(within(anthropic).getByText('Yes')).toBeInTheDocument();
  expect(screen.getByText('Unavailable')).toBeInTheDocument();
  expect(screen.getByText('No provider key is configured.')).toBeInTheDocument();
  expect(screen.getByText('6 questions / minute')).toBeInTheDocument();
  expect(screen.getByText('200,000 tokens')).toBeInTheDocument();
  expect(screen.getByText('Payroll (view)')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/AI_PROVIDER_API_KEY|sk-|apiKey|crewflow-mock/);
});

it('Config: a configured key shows "Configured" and nothing of its value; an available model shows Available and the env default lists', async () => {
  const CANARY = 'sk-ant-canary-value-never-shown';
  routeGet(get, {
    '/admin/ai/overview': {
      ...OVERVIEW,
      models: [model({ state: 'available', stateLabel: 'Available', selectable: true }), ...OVERVIEW.models.slice(1)],
      // A server bug must never be able to put a value on screen: unknown fields are ignored by the view.
      providerKeys: [{ provider: 'anthropic', envName: 'ANTHROPIC_API_KEY', configured: true, sdkInstalled: true, value: CANARY }, OVERVIEW.providerKeys[1]],
      defaults: { fast: ['anthropic-claude-haiku-5-5'], smart: [], disabled: ['openai-gpt-6-luna-eu'] },
      readiness: { ready: true, realProvidersPermitted: true, problems: [] },
      limits: { ...OVERVIEW.limits, dailyBudgetUsd: 2 },
    },
  });
  const { container } = renderWithQuery(<AiConfigSection />);
  const keys = await screen.findByRole('table', { name: 'AI provider keys' });
  expect(within(within(keys).getByText('ANTHROPIC_API_KEY').closest('tr')!).getByText('Configured')).toBeInTheDocument();
  expect(within(screen.getByRole('table', { name: 'AI models' })).getByText('Available')).toBeInTheDocument();
  expect(screen.getByText('Ready')).toBeInTheDocument();
  expect(screen.getByText('Permitted')).toBeInTheDocument();
  expect(screen.getByText('anthropic-claude-haiku-5-5', { selector: 'dd' })).toBeInTheDocument();
  expect(screen.getByText('openai-gpt-6-luna-eu', { selector: 'dd' })).toBeInTheDocument();
  expect(screen.getByText(/\$2 estimated cost/)).toBeInTheDocument();
  expect(container.textContent).not.toContain(CANARY);
  expect(container.textContent).not.toMatch(/sk-|apiKey/);
});

it('Security: privacy configuration (telemetry off, retention mode, no administrator transcript access)', async () => {
  renderWithQuery(<AiPrivacySection />);
  expect(await screen.findByText('Prompt and answer telemetry')).toBeInTheDocument();
  expect(screen.getByText('off')).toBeInTheDocument();
  expect(screen.getByText(/No admin route and no database policy can read a conversation/)).toBeInTheDocument();
});

it('Organisation card: the AI switch defaults OFF and changes only through the reason + step-up dialog; it shows the SAVED value', async () => {
  const toasts: Array<{ message: string }> = [];
  const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
  document.addEventListener(TOAST_EVENT, onToast);
  post.mockResolvedValue({ data: { validUntil: 'x', mfa: false } });
  put.mockResolvedValue({ data: { organisationId: ORG, enabled: true, updatedAt: '2026-10-25T12:00:00.000Z' } });
  renderWithQuery(<OrganisationAiSwitch organisationId={ORG} organisationName="Org A Ltd" />);
  const toggle = await screen.findByRole('checkbox', { name: 'AI assistant for Org A Ltd' });
  await waitFor(() => expect(toggle).not.toBeDisabled());
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Turn on the AI assistant for Org A Ltd')).toBeInTheDocument();
  // A reason is required before anything is sent.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on AI' }));
  expect(put).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Pilot organisation' } });
  fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'pw' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on AI' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith(`/admin/ai/organisations/${ORG}/setting`, { enabled: true, reason: 'Pilot organisation' }));
  expect(post.mock.calls[0]).toEqual(['/auth/step-up', { currentPassword: 'pw' }]); // step-up first, then the change
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('checkbox', { name: 'AI assistant for Org A Ltd' })).toBeChecked();
  expect(toasts.map((t) => t.message)).toEqual(['AI assistant is on for Org A Ltd']);
  document.removeEventListener(TOAST_EVENT, onToast);
});

it('Organisation card: a refused change (step-up required) stays in the dialog as one inline alert and the switch keeps the server value', async () => {
  put.mockRejectedValue({ isAxiosError: true, response: { status: 403, data: { code: 'STEP_UP_REQUIRED', mfa: false, message: 'Confirm it’s you to continue.' } } });
  renderWithQuery(<OrganisationAiSwitch organisationId={ORG} organisationName="Org A Ltd" />);
  const toggle = await screen.findByRole('checkbox', { name: 'AI assistant for Org A Ltd' });
  await waitFor(() => expect(toggle).not.toBeDisabled());
  fireEvent.click(toggle);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Pilot organisation' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on AI' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Confirm it’s you to continue');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('checkbox', { name: 'AI assistant for Org A Ltd' })).not.toBeChecked();
});

// T8-A1 (docs/ai/PHASE8_TWENTY_PLAN.md §5): no key value, prefix, suffix or LENGTH is ever rendered, whatever the server sends.
it('T8-A1: a provider key is only "Configured" / "Not configured" — never its value, a prefix, the last characters or its length', async () => {
  const CANARY = 'sk-ant-api03-T8A1CANARY'.padEnd(97, 'Z');
  routeGet(get, {
    '/admin/ai/overview': {
      ...OVERVIEW,
      providerKeys: [
        { provider: 'anthropic', envName: 'ANTHROPIC_API_KEY', configured: true, sdkInstalled: true, value: CANARY, length: CANARY.length, keyLength: CANARY.length, prefix: CANARY.slice(0, 10), last4: CANARY.slice(-4), masked: `${CANARY.slice(0, 6)}…${CANARY.slice(-4)}` },
        OVERVIEW.providerKeys[1],
      ],
    },
  });
  const { container } = renderWithQuery(<AiConfigSection />);
  const keys = await screen.findByRole('table', { name: 'AI provider keys' });
  const row = within(keys).getByText('ANTHROPIC_API_KEY').closest('tr')!;
  expect(row.textContent).not.toMatch(/97|sk-|ZZZZ|T8A1|…/);
  expect(container.textContent).not.toContain('T8A1CANARY');
  expect(container.innerHTML).not.toContain('T8A1CANARY');
  expect(container.textContent).not.toMatch(/97/);
});

it('U7 / 7b: estimated cost (USD, integer division), cache read / write and today’s budget alerts per organisation; absent fields are "—", never estimated', async () => {
  routeGet(get, {
    '/admin/ai/overview': { ...OVERVIEW, limits: { ...OVERVIEW.limits, dailyBudgetUsd: 5, userDailyBudgetUsd: 1 } },
    '/admin/ai/usage': () => ({
      from: '2026-10-25',
      to: '2026-10-25',
      organisations: [
        usageRow({ costUsdMicros: 2_140_999, cachedInputTokens: 52_000, cacheWriteTokens: 1_200, budgetAlerts: ['cost', 'tokens'] }),
        usageRow({ organisationId: 'bbbbbbbb-1111-4222-8333-444455556666', organisationName: 'Org B Ltd (older server)' }),
      ],
    }),
  });
  renderWithQuery(<AiHealthSection />);
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Organisation', 'AI', 'Turns', 'Failed', 'Cancelled', 'Tool calls', 'Input tokens', 'Cached input', 'Cache writes', 'Output tokens', 'Est. cost (USD)', 'Of daily budget', 'Budget alerts today']);
  const a = (await within(table).findByText('Org A Ltd')).closest('tr')!;
  expect(within(a).getByText('$2.14')).toBeInTheDocument();
  expect(within(a).getByText('52,000')).toBeInTheDocument();
  expect(within(a).getByText('1,200')).toBeInTheDocument();
  expect(within(a).getByText('Cost 80 %')).toHaveClass('ap-warn');
  expect(within(a).getByText('Tokens 80 %')).toHaveClass('ap-warn');
  const b = within(table).getByText('Org B Ltd (older server)').closest('tr')!;
  expect(within(b).getAllByText('—').length).toBe(4); // cached, writes, cost, alerts
  expect(screen.getByText(/Per-person daily limit: \$1 estimated cost\./)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/£/);
});

it('U7: Config shows the per-person daily limit once the overview carries it, "—" before', async () => {
  renderWithQuery(<AiConfigSection />);
  expect((await screen.findByText('Daily limit per person')).nextElementSibling).toHaveTextContent('—');
});

describe('Phase C1: the AI overview is polled only on the Health tab', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
  const overviewCalls = () => get.mock.calls.filter(([u]: [string]) => u === '/admin/ai/overview').length;

  it('Health polls it every 15 s', async () => {
    const { qc } = renderWithQuery(<AiHealthSection />);
    await tick(20);
    expect(overviewCalls()).toBe(1);
    await tick(15_100);
    expect(overviewCalls()).toBe(2);
    qc.clear();
  });

  it.each([
    ['Config', () => <AiConfigSection />],
    ['Security', () => <AiPrivacySection />],
    ['an organisation card (General)', () => <OrganisationAiSwitch organisationId={ORG} organisationName="Org A Ltd" />],
  ])('%s fetches it once and never polls', async (_name, ui) => {
    const { qc } = renderWithQuery(ui());
    await tick(20);
    expect(overviewCalls()).toBe(1);
    await tick(120_000);
    expect(overviewCalls()).toBe(1);
    qc.clear();
  });
});

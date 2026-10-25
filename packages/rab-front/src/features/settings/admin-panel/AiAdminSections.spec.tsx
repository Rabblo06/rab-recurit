import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { TOAST_EVENT } from '../../../shared/lib/toast';
import { renderWithQuery, routeGet } from './adminPanelTestKit';
import { AiConfigSection, AiHealthSection, AiPrivacySection, OrganisationAiSwitch } from './AiAdminSections';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;

const ORG = 'aaaaaaaa-1111-4222-8333-444455556666';
const OVERVIEW = {
  platformEnabled: true,
  provider: 'mock',
  model: 'crewflow-mock-1',
  modelAllowlisted: true,
  credentialsConfigured: false,
  externalProvider: false,
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
  expect(screen.getByText('Test model only')).toBeInTheDocument();
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

it('Config: provider and model identifiers, credentials yes/no (never a key), allowlist, limits, rate limits and the tool catalogue', async () => {
  const { container } = renderWithQuery(<AiConfigSection />);
  expect(await screen.findByText('crewflow-mock-1')).toBeInTheDocument();
  expect(screen.getByText('Allowlisted')).toBeInTheDocument();
  expect(screen.getByText('Not configured')).toBeInTheDocument();
  expect(screen.getByText('6 questions / minute')).toBeInTheDocument();
  expect(screen.getByText('200,000 tokens')).toBeInTheDocument();
  expect(screen.getByText('Payroll (view)')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/AI_PROVIDER_API_KEY|sk-|apiKey/);
});

it('Config: AI readiness and model approval are visible to the administrator (names only, never a key)', async () => {
  routeGet(get, {
    '/admin/ai/overview': {
      ...OVERVIEW,
      model: 'anthropic-claude-haiku-5-5',
      provider: null,
      externalProvider: true,
      credentialsConfigured: true,
      readiness: { ready: false, problems: [{ code: 'dev_flag_missing', message: 'anthropic-claude-haiku-5-5 is a real provider: development needs AI_DEV_ALLOW_REAL_PROVIDERS=true.' }] },
      modelFacts: { id: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', dataRegion: 'Global routing on the Claude API.', approved: true, approvalScope: 'development, synthetic data only, pending provider checklist 3.7', productionApproved: false, priceUsdPerMTok: { input: 0.1, output: 0.5 }, verifiedAt: '2026-10-25' },
      limits: { ...OVERVIEW.limits, dailyBudgetUsd: 2 },
    },
  });
  const { container } = renderWithQuery(<AiConfigSection />);
  expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  expect(screen.getByText(/development needs AI_DEV_ALLOW_REAL_PROVIDERS=true/)).toBeInTheDocument();
  expect(screen.getByText('Not for production')).toBeInTheDocument();
  expect(screen.getByText(/development, synthetic data only, pending provider checklist 3.7/)).toBeInTheDocument();
  expect(screen.getByText(/\$2 estimated cost/)).toBeInTheDocument();
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

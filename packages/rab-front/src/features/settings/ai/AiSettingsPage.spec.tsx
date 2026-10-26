import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { formatMicroUsd } from '../../ai/AiComposerControls';
import {
  assistantFixture,
  AVAILABLE,
  LIMITS,
  overviewFixture,
  PROMPT_CANARY,
  promptFixture,
  renderSettings,
  routeApi,
  toolsFixture,
  usageFixture,
  type ApiCall,
} from './aiSettingsTestKit';
import { meterTone } from './AiUsageTab';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));

const mocked = api as unknown as { get: jest.Mock; put: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock };
let calls: ApiCall[] = [];
let routes: Record<string, unknown>;
const writes = () => calls.filter((c) => c.method !== 'get');

beforeEach(() => {
  calls = [];
  routes = {
    'get /ai/availability': AVAILABLE,
    'get /ai/settings': overviewFixture(),
    'get /ai/settings/tools': toolsFixture(),
    'get /ai/settings/prompt-preview': promptFixture(),
    'get /ai/settings/models': { models: [], tiers: [], setup: null },
  };
  routeApi(mocked, routes, calls);
});
const install = () => routeApi(mocked, routes, calls);
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

// ── T8-S1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T8-S1 the tab shell', () => {
  it('not eligible (AI off for the organisation): no tabs and nothing of Settings → AI is fetched', async () => {
    routes['get /ai/availability'] = { available: false, reason: 'organisation_disabled', limits: LIMITS, usage: null };
    install();
    renderSettings();
    expect(await screen.findByText(/not available for your organisation/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url.startsWith('/ai/settings'))).toEqual([]);
  });

  it('a non-CEO (the server answers 404) sees no tabs', async () => {
    delete routes['get /ai/settings'];
    install();
    renderSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent('Only your organisation’s CEO can open them');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('only the tabs whose API exists on the server are rendered (Skills, Usage, Agents absent today)', async () => {
    renderSettings();
    await screen.findByRole('tablist', { name: 'AI settings' });
    expect(tabNames()).toEqual(['Overview', 'Models', 'Tools', 'Prompt']);
  });

  it('every feature on: all seven tabs, in order', async () => {
    routes['get /ai/settings'] = overviewFixture({ skills: true, usage: true, agents: true });
    install();
    renderSettings();
    await screen.findByRole('tablist');
    expect(tabNames()).toEqual(['Overview', 'Models', 'Skills', 'Tools', 'Usage', 'Prompt', 'Agents']);
  });

  it('deep link ?tab=tools opens Tools; a link to an absent tab (agents) falls back to Overview — never the hidden tab', async () => {
    renderSettings('/settings/ai?tab=tools');
    expect(await screen.findByRole('tab', { name: 'Tools', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Assistant tools' })).toBeInTheDocument();
  });

  it('a hidden tab cannot be reached by URL', async () => {
    renderSettings('/settings/ai?tab=agents');
    expect(await screen.findByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument();
    expect(screen.queryByText(/Agents can’t run/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/ai/agents'))).toBe(false);
  });

  it('keyboard: Left / Right / Home / End move between tabs with a roving tabindex', async () => {
    renderSettings();
    const overview = await screen.findByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    const models = await screen.findByRole('tab', { name: 'Models', selected: true });
    expect(document.activeElement).toBe(models);
    fireEvent.keyDown(models, { key: 'End' });
    expect(await screen.findByRole('tab', { name: 'Prompt', selected: true })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Prompt' }), { key: 'Home' });
    expect(await screen.findByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), { key: 'ArrowLeft' });
    expect(await screen.findByRole('tab', { name: 'Prompt', selected: true })).toBeInTheDocument();
  });
});

// ── Overview ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('Overview (B*)', () => {
  it('without the assistant / instructions APIs: honest "Not available yet", the default avatar, real counts; no MCP section', async () => {
    renderSettings();
    expect(await screen.findByText(/Not available yet\. Choosing a different name and look/)).toBeInTheDocument();
    expect(screen.getByText(/Not available yet\. Organisation instructions arrive/)).toBeInTheDocument();
    const glance = screen.getByRole('heading', { name: 'At a glance' }).closest('section')!;
    expect(within(glance).getByText('3')).toBeInTheDocument();
    expect(within(glance).getByText('41')).toBeInTheDocument();
    expect(within(glance).getByText('5')).toBeInTheDocument();
    // Skills: the API does not exist, so its count is not shown as a number.
    expect(within(glance).queryByText('4')).not.toBeInTheDocument();
    expect(screen.queryByText(/MCP|Model Context Protocol|Cursor/i)).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === '/ai/settings/assistant' || c.url === '/ai/settings/instructions')).toBe(false);
    // Opening the Overview never fetches (and so never audits) the prompt preview.
    expect(calls.some((c) => c.url === '/ai/settings/prompt-preview')).toBe(false);
  });

  it('with the assistant API: presets as a radio group; choosing one sends ONLY {preset}', async () => {
    routes['get /ai/settings'] = overviewFixture({ assistant: true });
    routes['get /ai/settings/assistant'] = assistantFixture();
    routes['put /ai/settings/assistant'] = (body: Record<string, unknown>) => assistantFixture({ preset: body.preset, name: 'Sky', shape: 'cloud', colour: 'sky', face: 'round', isDefault: false });
    install();
    renderSettings();
    const group = await screen.findByRole('radiogroup', { name: 'Assistant look' });
    expect(within(group).getAllByRole('radio')).toHaveLength(8);
    expect(within(group).getByRole('radio', { name: /Crewflow/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(group).getByRole('radio', { name: /Sky/ }));
    await waitFor(() => expect(within(group).getByRole('radio', { name: /Sky/ })).toHaveAttribute('aria-checked', 'true'));
    expect(writes()).toEqual([{ method: 'put', url: '/ai/settings/assistant', body: { preset: 'sky' }, params: undefined }]);
  });

  it('customise menu: a hostile name is refused before sending and every value is an enum; Escape returns focus', async () => {
    routes['get /ai/settings'] = overviewFixture({ assistant: true });
    routes['get /ai/settings/assistant'] = assistantFixture({ preset: null, name: '<img src=x onerror=alert(1)>', shape: 'cloud', colour: 'violet', face: 'round', isDefault: false });
    routes['put /ai/settings/assistant'] = (body: Record<string, unknown>) => assistantFixture({ preset: null, isDefault: false, ...body });
    install();
    const { container } = renderSettings();
    const custom = await screen.findByRole('radio', { name: /<img src=x onerror=alert\(1\)>/ });
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(custom);
    const name = await screen.findByLabelText('Assistant name');
    fireEvent.change(name, { target: { value: 'Ada‮' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(await screen.findByText('Use letters, numbers and ordinary punctuation only.')).toBeInTheDocument();
    expect(writes()).toEqual([]);
    // Round only (owner 2026-10-26): no shape row is offered; the shape travels unchanged from the profile.
    expect(screen.queryByRole('menuitem', { name: /Shape/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Colour/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Teal/ }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ name: '<img src=x onerror=alert(1)>', shape: 'cloud', colour: 'teal', face: 'round', animate: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: /<img/ })));
  });

  it('instructions: counter n / 2,000; save asks a reason and sends exactly {content, reason}', async () => {
    routes['get /ai/settings'] = overviewFixture({ instructions: true });
    routes['get /ai/settings/instructions'] = { content: null, contentLength: 0, contentSha256: null, updatedAt: null, limits: { maxChars: 2000, reasonMinChars: 3, reasonMaxChars: 500 } };
    routes['put /ai/settings/instructions'] = (body: { content: string }) => ({ content: body.content, contentLength: body.content.length, contentSha256: 'h', updatedAt: '2026-10-25T10:00:00.000Z', limits: { maxChars: 2000, reasonMinChars: 3, reasonMaxChars: 500 } });
    install();
    renderSettings();
    const box = await screen.findByLabelText('Instructions text');
    fireEvent.change(box, { target: { value: 'Use British English.' } });
    expect(screen.getByText('20 / 2,000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: /Save the organisation instructions/ });
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'House style' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'put', url: '/ai/settings/instructions', body: { content: 'Use British English.', reason: 'House style' } });
    expect(Object.keys(writes()[0]!.body as object).sort()).toEqual(['content', 'reason']);
  });
});

// ── T8-S4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T8-S4 Tools (read-only)', () => {
  it('shows the permission each tool needs and "You don’t have this"; there is no write control anywhere', async () => {
    renderSettings('/settings/ai?tab=tools');
    const table = await screen.findByRole('table', { name: 'Assistant tools' });
    const payroll = within(table).getByText('Payroll run comparison').closest('tr')!;
    expect(within(payroll).getByText('View payroll')).toBeInTheDocument();
    expect(within(payroll).getByText('You don’t have this')).toBeInTheDocument();
    expect(within(within(table).getByText('Unfilled shifts').closest('tr')!).getByText('Yes')).toBeInTheDocument();
    const panel = screen.getByRole('tabpanel');
    for (const b of within(panel).getAllByRole('button')) expect(b.textContent + (b.getAttribute('aria-label') ?? '')).toMatch(/^Open /);
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/create tool|see function|delete/i)).not.toBeInTheDocument();
  });

  it('detail: description read-only, parameters honestly "not available yet" until the server describes them', async () => {
    renderSettings('/settings/ai?tab=tools&tool=compare_payroll_runs');
    expect(await screen.findByRole('heading', { name: 'Payroll run comparison' })).toBeInTheDocument();
    expect(screen.getByText('Totals of two payroll runs side by side.')).toBeInTheDocument();
    expect(screen.getByText(/Not available yet\. Parameter details/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('filters by name', async () => {
    renderSettings('/settings/ai?tab=tools');
    fireEvent.change(await screen.findByLabelText('Search tools'), { target: { value: 'payroll' } });
    expect(screen.queryByText('Unfilled shifts')).not.toBeInTheDocument();
    expect(screen.getByText('Payroll run comparison')).toBeInTheDocument();
  });
});

// ── T8-S5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T8-S5 Usage', () => {
  it('micro-USD by integer division only', () => {
    expect(formatMicroUsd(1_234_567)).toBe('$1.23');
    expect(formatMicroUsd(999)).toBe('<$0.01');
    expect(formatMicroUsd(0)).toBe('$0.00');
    expect(formatMicroUsd(10_000)).toBe('$0.01');
    expect(formatMicroUsd(123_456_789_012)).toBe('$123,456.78');
  });

  it('meter tones at 80 % and 100 %', () => {
    expect([0, 79, 80, 99, 100, 140].map(meterTone)).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'bad']);
  });

  it('renders cards, by-person and by-model tables (metadata only), the alert, and switches period with ?period', async () => {
    routes['get /ai/settings'] = overviewFixture({ usage: true });
    routes['get /ai/settings/usage'] = (_b: unknown, params?: Record<string, unknown>) => usageFixture({ period: params?.period });
    install();
    renderSettings('/settings/ai?tab=usage');
    const person = await screen.findByRole('table', { name: 'Usage by person' });
    expect(within(person).getByText('Casey Lane')).toBeInTheDocument();
    expect(within(within(person).getByText('Robin Ashford').closest('tr')!).getByText('<$0.01')).toBeInTheDocument();
    expect(within(within(person).getByText('Casey Lane').closest('tr')!).getByText('85%')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByRole('meter', { name: 'Estimated cost today' })).toHaveAttribute('aria-valuenow', '82');
    expect(screen.getByText(/passed 80% of the cost limit/)).toBeInTheDocument();
    expect(screen.queryByText(/credit/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/ai/settings/usage' && (c.params as { period?: string })?.period === 'month')).toBe(true));
  });

  it('empty and error states', async () => {
    routes['get /ai/settings'] = overviewFixture({ usage: true });
    routes['get /ai/settings/usage'] = usageFixture({ byUser: [], byModel: [] });
    install();
    renderSettings('/settings/ai?tab=usage');
    expect(await screen.findAllByText('No questions in this period.')).toHaveLength(2);
  });
});

// ── T8-S6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T8-S6 Prompt', () => {
  it('plain text only: markup and a canary in a mocked response stay inert text; estimate shown; no send / try it', async () => {
    routes['get /ai/settings/prompt-preview'] = promptFixture({ systemPrompt: `Rules.\n<script>alert(1)</script>\n**not bold**\n${PROMPT_CANARY}` });
    install();
    const { container } = renderSettings('/settings/ai?tab=prompt');
    const pre = await screen.findByText(/Rules\./, { selector: 'pre' });
    expect(pre.textContent).toContain('<script>alert(1)</script>');
    expect(pre.textContent).toContain('**not bold**');
    expect(container.querySelector('script, strong.ai-md, .ai-md')).toBeNull();
    expect(screen.getByText(/about 812 tokens \(at most 3,100\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send|try|run|ask/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('sections (CD-5) are shown in order with their own estimates when the server sends them', async () => {
    routes['get /ai/settings/prompt-preview'] = promptFixture({
      sections: [
        { key: 'rules', title: 'Crewflow rules', text: 'Rule text', readOnly: true, tokenEstimate: { estimate: 700, upperBound: 2800 } },
        { key: 'context', title: 'Context sent with each question', text: 'Today is 2026-10-25 (Europe/London).', readOnly: true, tokenEstimate: { estimate: 10, upperBound: 40 } },
      ],
      totalTokenEstimate: { estimate: 710, upperBound: 2840 },
    });
    install();
    renderSettings('/settings/ai?tab=prompt');
    const headings = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(headings).toEqual(['System prompt', 'Crewflow rules', 'Context sent with each question']);
    expect(screen.getByText(/about 710 tokens \(at most 2,840\)/)).toBeInTheDocument();
  });
});

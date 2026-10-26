import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { a11ySweep } from './aiSettingsA11y';
import { AVAILABLE, dailyFixture, overviewFixture, renderSettings, routeApi, usageFixture, type ApiCall } from './aiSettingsTestKit';
import { PER_PERSON_NOTE } from './AiUsageTab';

/**
 * U7 — Usage tab per the settings mockup with REAL numbers from `GET /ai/settings/usage` (7a/7b ledger): the stat box,
 * "Last 14 days" from the S8 `daily` series (hidden behind "Not available yet" while the server doesn't send it), by
 * person (USD shown to the CEO — provisional owner decision, labelled) and by model. USD only; never £, never credits.
 */
jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const mocked = api as unknown as { get: jest.Mock; put: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock };

let calls: ApiCall[] = [];
let routes: Record<string, unknown>;
const install = () => routeApi(mocked, routes, calls);
const MONTH = { period: 'month', totals: { turns: 186, inputTokens: 912_000, cachedInputTokens: 240_000, cacheWriteTokens: 0, outputTokens: 70_100, costUsdMicros: 9_870_000 } };

beforeEach(() => {
  calls = [];
  routes = {
    'get /ai/availability': AVAILABLE,
    'get /ai/settings': overviewFixture({ usage: true }),
    'get /ai/settings/tools': { tools: [] },
    'get /ai/settings/usage': (_b: unknown, p?: Record<string, unknown>) => (p?.period === 'month' ? usageFixture(MONTH) : usageFixture()),
  };
  install();
});

describe('U7 stat box and tables (real numbers)', () => {
  it('Today = live meter / org budget, This month = ledger total, Messages today = today’s turns — exact integer-division USD', async () => {
    renderSettings('/settings/ai?tab=usage');
    const stat = await screen.findByText('Today', { selector: 'dt' });
    const box = stat.closest('dl')!;
    expect(within(box).getByText('$4.10 / $5.00')).toBeInTheDocument();
    expect(within(box).getByText('$9.87')).toBeInTheDocument();
    expect(within(box).getByText('37')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Estimated cost today' })).toHaveAttribute('aria-valuenow', '82');
    expect(screen.getByText(/Tokens today: 120k of 200k \(60%\) · cached input this month: 26%/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/£|credit/i);
    expect(a11ySweep()).toEqual([]);
  });

  it('by person: month by default, Cost (month), Today vs limit "$a / $b" with the tone; the per-person USD note says it is provisional', async () => {
    renderSettings('/settings/ai?tab=usage');
    const person = await screen.findByRole('table', { name: 'Usage by person' });
    expect(within(person).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Person', 'Messages', 'Tokens', 'Cost (month)', 'Today vs limit']);
    expect(within(within(person).getByText('Casey Lane').closest('tr')!).getByText('$0.85 / $1.00')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText(new RegExp(PER_PERSON_NOTE.replace(/[().]/g, '\\$&')))).toBeInTheDocument();
    expect(PER_PERSON_NOTE).toMatch(/provisional owner decision/);
    const model = screen.getByRole('table', { name: 'Usage by model' });
    expect(within(model).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Model', 'Messages', 'Input', 'Cached input', 'Output', 'Cost']);
  });

  it('keyboard: the period radios move with the arrow keys', async () => {
    renderSettings('/settings/ai?tab=usage');
    const month = await screen.findByRole('radio', { name: 'This month' });
    fireEvent.keyDown(month, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByRole('columnheader', { name: 'Cost (today)' })).toBeInTheDocument();
  });
});

describe('U7 "Last 14 days" (S8)', () => {
  it('without `daily` the chart is not drawn: "Not available yet", no made-up series', async () => {
    renderSettings('/settings/ai?tab=usage');
    expect(await screen.findByText(/Not available yet\. The daily series arrives/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Daily estimated cost/ })).not.toBeInTheDocument();
  });

  it('a malformed `daily` is not guessed at (still "Not available yet")', async () => {
    routes['get /ai/settings/usage'] = () => usageFixture({ daily: [{ day: 'yesterday', turns: '3', costUsdMicros: 1.5 }] });
    install();
    renderSettings('/settings/ai?tab=usage');
    expect(await screen.findByText(/Not available yet\. The daily series arrives/)).toBeInTheDocument();
  });

  it('with `daily`: 14 bars, the budget line, an accessible summary; ←/→/Home/End read a day; Esc closes the reading; a table view', async () => {
    routes['get /ai/settings/usage'] = (_b: unknown, p?: Record<string, unknown>) => usageFixture({ ...(p?.period === 'month' ? MONTH : {}), daily: dailyFixture() });
    install();
    const { container } = renderSettings('/settings/ai?tab=usage');
    const chart = await screen.findByRole('group', { name: /Daily estimated cost, 12 Oct to 25 Oct: \$9\.30 in total/ });
    expect(container.querySelectorAll('.ai-usage-col')).toHaveLength(14);
    expect(within(chart).getByText('$5.00 daily budget')).toBeInTheDocument();
    chart.focus();
    fireEvent.keyDown(chart, { key: 'End' });
    expect(within(chart).getByRole('status')).toHaveTextContent('Sun 25 Oct$4.10 · 82 messages');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(within(chart).getByRole('status')).toHaveTextContent('Sat 24 Oct$0.30 · 6 messages');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(within(chart).getByRole('status')).toHaveTextContent('Mon 12 Oct$0.20');
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(within(chart).queryByRole('status')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show as table' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const table = screen.getByRole('table', { name: 'Daily usage, last 14 days' });
    expect(within(table).getAllByRole('row')).toHaveLength(15);
    expect(a11ySweep()).toEqual([]);
  });

  it('hover shows the same reading as the keyboard', async () => {
    routes['get /ai/settings/usage'] = () => usageFixture({ daily: dailyFixture() });
    install();
    const { container } = renderSettings('/settings/ai?tab=usage');
    await screen.findByRole('group', { name: /Daily estimated cost/ });
    fireEvent.mouseEnter(container.querySelectorAll('.ai-usage-col')[10]!);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Thu 22 Oct$0.80 · 16 messages'));
  });
});

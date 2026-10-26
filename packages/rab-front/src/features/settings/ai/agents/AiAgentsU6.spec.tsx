import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../../shared/api';
import { a11ySweep, disabledWithoutReason } from '../aiSettingsA11y';
import { agentFixture, agentRoleFixture, AVAILABLE, overviewFixture, renderSettings, routeApi, type ApiCall } from '../aiSettingsTestKit';

/**
 * U6 — Agents (agents mockup views 1–2), STORAGE ONLY. EX-3 is deferred: `features.agentExecution` is false, so the run
 * switch, "Turn on", Runs and Test are disabled with the EX-3 reason and nothing can start a run. Writes carry a reason
 * (step-up + audit); `updateAgent` sends the reason; the role tab uses GET/PUT /ai/agents/:id/role; standard agents
 * can't be changed or deleted; the agent API answers a uniform 404 to the ineligible.
 */
jest.mock('../../../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const mocked = api as unknown as { get: jest.Mock; put: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock };

let calls: ApiCall[] = [];
let routes: Record<string, unknown>;
const writes = () => calls.filter((c) => c.method !== 'get');
const install = () => routeApi(mocked, routes, calls);
const EX3 = /Agents can’t run until the owner approves agent execution \(EX-3\)/;

beforeEach(() => {
  calls = [];
  routes = {
    'get /ai/availability': AVAILABLE,
    'get /ai/settings': overviewFixture({ agents: true }),
    'get /ai/agents': [agentFixture(), agentFixture({ id: 'a2', name: 'helper', label: 'Helper', description: null, kind: 'standard', readOnly: true, triggers: [] })],
    'get /ai/agents/a1/role': agentRoleFixture(),
    'get /ai/settings/tools': { tools: [] },
    'get /ai/settings/models': { models: [], tiers: [], setup: null },
  };
  install();
});

const giveReason = async (dialogName: RegExp, confirm: string) => {
  const dialog = await screen.findByRole('dialog', { name: dialogName });
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Owner request' } });
  fireEvent.click(within(dialog).getByRole('button', { name: confirm }));
  return dialog;
};

describe('U6 visibility', () => {
  it('features.agents false (AI_AGENTS_ENABLED off): no Agents tab, and a deep link fetches nothing from /ai/agents', async () => {
    routes['get /ai/settings'] = overviewFixture({ agents: false });
    install();
    renderSettings('/settings/ai?tab=agents&agent=a1');
    expect(await screen.findByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Agents' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/ai/agents'))).toBe(false);
  });

  it('an unknown or forbidden agent id gets one neutral "not found" (the server’s uniform 404) — never a 403-style message', async () => {
    renderSettings('/settings/ai?tab=agents&agent=00000000-0000-4000-8000-000000000000');
    expect(await screen.findByText('This agent doesn’t exist, or you can’t open it.')).toBeInTheDocument();
    expect(screen.queryByText(/permission|forbidden|not allowed/i)).not.toBeInTheDocument();
  });
});

describe('U6 list (view 1)', () => {
  it('columns Name · Runs · Role · Model · Last run; runs from the stored trigger; "Last run" is "—" with the EX-3 reason; standard agents are marked', async () => {
    renderSettings('/settings/ai?tab=agents');
    const table = await screen.findByRole('table', { name: 'Agents' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Runs', 'Role', 'Model', 'Last run', 'Open']);
    const row = within(table).getByText('Weekly coverage').closest('tr')!;
    expect(within(row).getByText('Every Monday at 08:00')).toBeInTheDocument();
    expect(within(row).getByText('No role (no data access)')).toBeInTheDocument();
    expect(within(row).getByText('Fast')).toBeInTheDocument();
    expect(within(row).getByTitle(/EX-3/)).toHaveTextContent('—');
    expect(within(within(table).getByText('Helper').closest('tr')!).getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText(EX3)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run now|test/i })).not.toBeInTheDocument();
    expect(a11ySweep()).toEqual([]);
  });

  it('New agent: stored with a reason; the body is exactly name, label, description, prompt, model, reason (no organisationId / status / enabled)', async () => {
    const created = agentFixture({ id: 'a3', name: 'weekend-cover', label: 'Weekend cover', triggers: [] });
    const list = [agentFixture()];
    routes['get /ai/agents'] = () => list;
    routes['post /ai/agents'] = () => { list.push(created); return created; };
    install();
    renderSettings('/settings/ai?tab=agents');
    fireEvent.click(await screen.findByRole('button', { name: 'New agent' }));
    fireEvent.change(await screen.findByLabelText('Identifier'), { target: { value: 'weekend-cover' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekend cover' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Checks next weekend.' } });
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'List next weekend’s unfilled shifts.' } });
    expect(screen.getByText('36 / 8,000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await giveReason(/Create this agent/, 'Create agent');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'post',
      url: '/ai/agents',
      body: { name: 'weekend-cover', label: 'Weekend cover', description: 'Checks next weekend.', prompt: 'List next weekend’s unfilled shifts.', model: { tier: 'fast', modelId: null }, reason: 'Owner request' },
      params: undefined,
    });
    expect(await screen.findByRole('heading', { name: 'Agent · Weekend cover' })).toBeInTheDocument();
  });
});

describe('U6 agent page (view 2)', () => {
  it('Runs and Test tabs and the run switch are disabled WITH the EX-3 reason; arrow keys skip the disabled tabs', async () => {
    renderSettings('/settings/ai?tab=agents&agent=a1');
    expect(await screen.findByRole('heading', { name: 'Agent · Weekly coverage' })).toBeInTheDocument();
    for (const name of ['Runs', 'Test']) {
      expect(screen.getByRole('tab', { name })).toBeDisabled();
      expect(screen.getByRole('tab', { name })).toHaveAttribute('title', expect.stringMatching(EX3));
    }
    const run = screen.getByRole('switch', { name: 'Run this agent' });
    expect(run).toHaveAttribute('aria-checked', 'false');
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).toHaveAccessibleDescription(EX3);
    const settings = screen.getByRole('tab', { name: 'Settings' });
    fireEvent.keyDown(settings, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Triggers' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Triggers' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Settings' }));
    expect(a11ySweep()).toEqual([]);
  });

  it('Save sends the changed fields AND the reason (PATCH); the counter uses the server limit 8,000', async () => {
    routes['patch /ai/agents/a1'] = (body: Record<string, unknown>) => agentFixture({ prompt: body.prompt });
    install();
    renderSettings('/settings/ai?tab=agents&agent=a1');
    const prompt = await screen.findByLabelText('Instructions');
    expect(screen.getByText('42 / 8,000')).toBeInTheDocument();
    fireEvent.change(prompt, { target: { value: 'x'.repeat(8_001) } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(prompt, { target: { value: 'Summarise next week’s gaps by venue.' } });
    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    await giveReason(/Save this agent/, 'Save');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'patch', url: '/ai/agents/a1', body: { prompt: 'Summarise next week’s gaps by venue.', reason: 'Owner request' }, params: undefined });
  });

  it('STEP_UP_REQUIRED on save: stays in the dialog with the fixed text; nothing reported saved', async () => {
    routes['patch /ai/agents/a1'] = { httpStatus: 403, statusCode: 403, code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you.' };
    install();
    renderSettings('/settings/ai?tab=agents&agent=a1');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Weekly coverage check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await giveReason(/Save this agent/, 'Save');
    expect(await within(dialog).findByText('The change was not saved because your identity was not confirmed.')).toBeInTheDocument();
    expect(screen.queryByText('Agent saved')).toBeNull();
  });

  it('Role tab: GET then PUT /ai/agents/:id/role with {flags, reason}; flags the caller can’t grant are disabled and say so', async () => {
    routes['put /ai/agents/a1/role'] = (body: { flags: string[] }) => agentRoleFixture(body.flags);
    install();
    renderSettings('/settings/ai?tab=agents&agent=a1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Role' }));
    const shifts = await screen.findByRole('checkbox', { name: 'See shifts' });
    expect(screen.getByRole('checkbox', { name: 'See payroll' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'See payroll' })).toHaveAccessibleDescription('Payroll · read only · you can’t grant this yet');
    expect(screen.getByRole('checkbox', { name: 'Suggest shifts (needs approval)' })).toBeDisabled();
    expect(screen.getByText('Never available to agents')).toBeInTheDocument();
    fireEvent.click(shifts);
    fireEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await giveReason(/Save what this agent may see/, 'Save');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'put', url: '/ai/agents/a1/role', body: { flags: ['schedule.view'], reason: 'Owner request' }, params: undefined });
    expect(calls.filter((c) => c.method === 'get' && c.url === '/ai/agents/a1/role')).toHaveLength(1);
    expect(a11ySweep()).toEqual([]);
  });

  it('Triggers: "Turn on" is disabled with the EX-3 reason; a new trigger is stored OFF with a reason; Esc closes the form and returns focus; nothing ever calls /enable', async () => {
    routes['post /ai/agents/a1/triggers'] = { id: 't2' };
    install();
    renderSettings('/settings/ai?tab=agents&agent=a1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Triggers' }));
    const turnOn = await screen.findByRole('button', { name: 'Turn on' });
    expect(turnOn).toBeDisabled();
    expect(turnOn).toHaveAccessibleDescription(EX3);
    expect(disabledWithoutReason(document.body, /^Turn on$/)).toEqual([]);
    const add = screen.getByRole('button', { name: 'Add trigger' });
    fireEvent.click(add);
    const form = (await screen.findByRole('group', { name: 'New trigger' })).closest('form')!;
    fireEvent.keyDown(form, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'New trigger' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add trigger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add trigger' }));
    await screen.findByRole('group', { name: 'New trigger' });
    fireEvent.click(within(screen.getByRole('group', { name: 'New trigger' }).closest('form')!).getByRole('button', { name: 'Add trigger' }));
    await giveReason(/Add this trigger/, 'Add trigger');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'post', url: '/ai/agents/a1/triggers', body: { kind: 'schedule', schedule: { every: 'week', at: '09:00', dow: 4 }, reason: 'Owner request' }, params: undefined });
    expect(calls.some((c) => /\/enable$/.test(c.url))).toBe(false);
  });

  it('a standard agent can’t be changed or deleted: fields disabled, no Save, Delete disabled with its reason, no trigger controls', async () => {
    renderSettings('/settings/ai?tab=agents&agent=a2');
    expect(await screen.findByText('Standard agent: it can’t be edited or deleted.')).toBeInTheDocument();
    expect(screen.getByLabelText('Instructions')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription('Standard agents can’t be deleted.');
    fireEvent.click(screen.getByRole('tab', { name: 'Triggers' }));
    expect(await screen.findByText('No triggers.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add trigger' })).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it('delete (custom agent) sends only {reason}', async () => {
    routes['delete /ai/agents/a1'] = { deleted: true, id: 'a1' };
    install();
    renderSettings('/settings/ai?tab=agents&agent=a1');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete agent' }));
    await giveReason(/Delete Weekly coverage/, 'Delete');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'delete', url: '/ai/agents/a1', body: { reason: 'Owner request' }, params: undefined });
  });
});

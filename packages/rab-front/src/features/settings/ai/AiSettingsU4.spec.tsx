import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { a11ySweep, disabledWithoutReason } from './aiSettingsA11y';
import { AVAILABLE, overviewFixture, promptFixture, renderSettings, routeApi, skillsFixture, toolsFixture, type ApiCall } from './aiSettingsTestKit';

/**
 * U4 — Settings → AI pages matched to the settings mockup (docs/design/ai/crewflow-ai-settings-mockup.html): Overview
 * (MCP "Coming later", audited counter), System prompt as a page under Overview (breadcrumb, skill catalogue states),
 * Skills (App column, Standard on/off only, server-limit counters, Danger zone), Tools (no create, Delete disabled with
 * its reason). Plus keyboard, the in-page a11y sweep and the light/dark token rule.
 */
jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const mocked = api as unknown as { get: jest.Mock; put: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock };

let calls: ApiCall[] = [];
let routes: Record<string, unknown>;
const writes = () => calls.filter((c) => c.method !== 'get');
const install = () => routeApi(mocked, routes, calls);
const ALL = overviewFixture({ skills: true, usage: true, assistant: false, instructions: true });

beforeEach(() => {
  calls = [];
  routes = {
    'get /ai/availability': AVAILABLE,
    'get /ai/settings': ALL,
    'get /ai/settings/tools': toolsFixture(),
    'get /ai/settings/prompt-preview': promptFixture(),
    'get /ai/settings/skills': skillsFixture(),
    'get /ai/settings/instructions': { content: null, contentLength: 0, contentSha256: null, updatedAt: null, limits: { maxChars: 2000, reasonMinChars: 3, reasonMaxChars: 500 } },
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

describe('U4 System prompt page (under Overview)', () => {
  it('opens from Overview with a breadcrumb; focus lands on the page heading; "Overview" goes back and focuses the Overview tab', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Read system prompts' }));
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('System prompt')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'System prompt' })));
    expect(a11ySweep()).toEqual([]);
    fireEvent.click(within(crumb).getByRole('button', { name: 'Overview' }));
    expect(await screen.findByRole('heading', { name: 'At a glance' })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Overview' })));
  });

  it('the old ?tab=prompt link still opens the page; there is no Prompt tab', async () => {
    renderSettings('/settings/ai?tab=prompt');
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Prompt' })).not.toBeInTheDocument();
  });

  it('skill catalogue (S9): the server lines are shown as plain text when sent', async () => {
    routes['get /ai/settings/prompt-preview'] = promptFixture({ skillCatalogue: ['shift-filling: Who could cover an open shift.', 'house-style: <b>British</b> English.'] });
    install();
    const { container } = renderSettings('/settings/ai?tab=overview&page=prompt');
    const pre = await screen.findByText(/shift-filling: Who could cover/, { selector: 'pre' });
    expect(pre.textContent).toContain('<b>British</b>');
    expect(container.querySelector('pre b')).toBeNull();
    expect(pre.closest('section')).toHaveTextContent('Skill catalogue');
  });

  it('skill catalogue: no skill on → says so (no "Not available yet"); the list is never made up', async () => {
    routes['get /ai/settings'] = overviewFixture({ skills: true }, { myConversations: 1, orgQuestionsThisMonth: 1, activeSkills: 0, tools: 2 });
    install();
    renderSettings('/settings/ai?tab=overview&page=prompt');
    expect(await screen.findByText('No skill is switched on, so the assistant is given no skill list.')).toBeInTheDocument();
    expect(screen.queryByText(/This server doesn’t send the list of skills/)).not.toBeInTheDocument();
  });

  it('skill catalogue: the server section is used as-is when present (never duplicated)', async () => {
    routes['get /ai/settings/prompt-preview'] = promptFixture({
      sections: [
        { key: 'rules', title: 'Crewflow rules', text: 'Rule text', readOnly: true, tokenEstimate: { estimate: 7, upperBound: 28 } },
        { key: 'skills', title: 'Skills the assistant can load', text: 'shift-filling: Who could cover.', readOnly: true, tokenEstimate: { estimate: 7, upperBound: 28 } },
      ],
      skillCatalogue: ['shift-filling: Who could cover.'],
    });
    install();
    renderSettings('/settings/ai?tab=overview&page=prompt');
    expect(await screen.findByRole('heading', { name: 'Skills the assistant can load' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Skill catalogue' })).not.toBeInTheDocument();
  });
});

describe('U4 Overview', () => {
  it('MCP is a static "Coming later" row; instructions counter is "n / 2,000 · changes are audited"; a11y sweep clean', async () => {
    renderSettings();
    const mcp = (await screen.findByRole('heading', { name: 'MCP server' })).closest('section')!;
    expect(within(mcp).getByText('Set up MCP')).toBeInTheDocument();
    expect(within(mcp).getByText('Coming later')).toBeInTheDocument();
    expect(within(mcp).queryAllByRole('button')).toHaveLength(0);
    expect(await screen.findByText('0 / 2,000 · changes are audited')).toBeInTheDocument();
    expect(a11ySweep()).toEqual([]);
  });
});

describe('U4 Skills', () => {
  it('list: Name · Description · App columns, "Off" for a switched-off skill, Standard / Custom; a row opens its page', async () => {
    renderSettings('/settings/ai?tab=skills');
    const table = await screen.findByRole('table', { name: 'Skills' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Description', 'App', 'Open']);
    const venue = within(table).getByText('Venue onboarding').closest('tr')!;
    expect(within(venue).getByText('Off')).toBeInTheDocument();
    expect(within(venue).getByText('Standard')).toBeInTheDocument();
    expect(within(within(table).getByText('House style').closest('tr')!).getByText('Custom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create skill' })).toBeEnabled();
    expect(a11ySweep()).toEqual([]);
    fireEvent.click(within(table).getByText('Shift filling'));
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Skills');
  });

  it('standard skill: only on/off — fields read-only, its text "Not available yet", Delete disabled WITH its reason; turning off sends only {reason}', async () => {
    routes['post /ai/settings/skills/builtin/shift-filling/deactivate'] = { ok: true };
    install();
    renderSettings('/settings/ai?tab=skills&skill=shift-filling');
    expect(await screen.findByText('Standard skill: only on/off can change.')).toBeInTheDocument();
    expect(screen.getByLabelText('Skill name')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByText(/Not available yet\. A standard skill’s text is part of Crewflow’s reviewed code/)).toBeInTheDocument();
    expect(screen.getByText('30 / 300')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription('Standard skills can’t be deleted.');
    expect(disabledWithoutReason(document.body, /^Delete$/)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await giveReason(/Turn off Shift filling/, 'Turn off');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'post', url: '/ai/settings/skills/builtin/shift-filling/deactivate', body: { reason: 'Owner request' }, params: undefined });
    expect(calls.some((c) => c.method === 'patch' || c.method === 'delete')).toBe(false);
  });

  it('custom skill: counters use the server limits (20,000 / 300); over the limit = invalid and no save; save sends exactly label, description, content, reason', async () => {
    routes['patch /ai/settings/skills/sk-1'] = { ok: true };
    install();
    renderSettings('/settings/ai?tab=skills&skill=house-style');
    const content = await screen.findByLabelText('Instructions');
    expect(screen.getByText('34 / 20,000')).toBeInTheDocument();
    expect(screen.getByText('25 / 300')).toBeInTheDocument();
    fireEvent.change(content, { target: { value: 'x'.repeat(20_001) } });
    expect(screen.getByText('20,001 / 20,000')).toHaveClass('ai-set-field-error');
    expect(content).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(content, { target: { value: '# House style\nUse British English and 24-hour times.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await giveReason(/Save this skill/, 'Save');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'patch', url: '/ai/settings/skills/sk-1' });
    expect(Object.keys(writes()[0]!.body as object).sort()).toEqual(['content', 'description', 'label', 'reason']);
  });

  it('a write refused with STEP_UP_REQUIRED stays in the dialog with the fixed text; nothing is reported saved', async () => {
    routes['patch /ai/settings/skills/sk-1'] = { httpStatus: 403, statusCode: 403, code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you.' };
    install();
    renderSettings('/settings/ai?tab=skills&skill=house-style');
    fireEvent.change(await screen.findByLabelText('Instructions'), { target: { value: 'Changed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await giveReason(/Save this skill/, 'Save');
    expect(await within(dialog).findByText('The change was not saved because your identity was not confirmed.')).toBeInTheDocument();
    expect(screen.queryByText('Skill saved')).toBeNull();
  });

  it('keyboard: Escape closes the reason dialog without writing', async () => {
    renderSettings('/settings/ai?tab=skills&skill=house-style');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: /Delete House style/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes()).toEqual([]);
  });
});

describe('U4 Tools', () => {
  it('list: Name · Kind · Needs permission · App; no "Create tool" anywhere; the page has a breadcrumb, Delete disabled with its reason and "Output fields" not invented', async () => {
    const { container } = renderSettings('/settings/ai?tab=tools');
    const table = await screen.findByRole('table', { name: 'Assistant tools' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Kind', 'Needs permission', 'App', 'Open']);
    expect(container.textContent).not.toMatch(/create tool/i);
    expect(a11ySweep()).toEqual([]);
    fireEvent.click(within(table).getByRole('button', { name: 'Open Unfilled shifts' }));
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Tools');
    expect(screen.getByText('list_unfilled_shifts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAccessibleDescription('Built-in tools can’t be deleted.');
    const output = screen.getByText('Output fields').closest('.ai-set-row')!;
    expect(output).toHaveTextContent('Not available yet');
    expect(a11ySweep()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('parameters appear once the server describes them (CD-9)', async () => {
    const t = toolsFixture();
    t.tools[0] = { ...t.tools[0]!, parameters: [{ name: 'from', type: 'date', required: true, description: 'First day.', limits: 'today or later' }] } as never;
    routes['get /ai/settings/tools'] = t;
    install();
    renderSettings('/settings/ai?tab=tools&tool=list_unfilled_shifts');
    const params = await screen.findByRole('table', { name: 'Parameters' });
    expect(within(params).getByText('from')).toBeInTheDocument();
    expect(within(params).getByText('First day. · today or later')).toBeInTheDocument();
  });
});

describe('U4 server fields settled by Agent 9 / 10 (R-U2, R-U3)', () => {
  it('R-U3: a built-in skill’s text is shown read-only when the server sends it; still no Save and no PATCH', async () => {
    const sk = skillsFixture();
    sk.skills[0] = { ...sk.skills[0]!, content: '# Shift filling\nSuggest at most 5 people.', contentLength: 41 } as never;
    routes['get /ai/settings/skills'] = sk;
    install();
    renderSettings('/settings/ai?tab=skills&skill=shift-filling');
    const text = await screen.findByLabelText('Instructions');
    expect(text).toBeDisabled();
    expect(text).toHaveValue('# Shift filling\nSuggest at most 5 people.');
    expect(screen.getByText('41 / 20,000')).toBeInTheDocument();
    expect(screen.queryByText(/this server doesn’t send it/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it('R-U2: output fields are listed when the server sends them; [] = "None"; absent = "Not available yet"', async () => {
    const t = toolsFixture();
    t.tools[0] = { ...t.tools[0]!, outputFields: ['id', 'venue', 'role', 'startsAt', 'endsAt'] } as never;
    t.tools[1] = { ...t.tools[1]!, outputFields: [] } as never;
    routes['get /ai/settings/tools'] = t;
    install();
    const { unmount } = renderSettings('/settings/ai?tab=tools&tool=list_unfilled_shifts');
    expect(((await screen.findByText('Output fields')).closest('.ai-set-row')!)).toHaveTextContent('id, venue, role, startsAt, endsAt');
    unmount();
    renderSettings('/settings/ai?tab=tools&tool=compare_payroll_runs');
    expect(((await screen.findByText('Output fields')).closest('.ai-set-row')!)).toHaveTextContent('None (no record data)');
  });
});

describe('the in-page a11y sweep itself', () => {
  it('reports an unnamed button, a duplicate id, a dangling reference, an unlabelled field and a table without a caption', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button></button><span id="x"></span><span id="x"></span><p aria-describedby="nope">t</p><input type="text"><table><tr><td>1</td></tr></table><button disabled>Delete</button>';
    document.body.appendChild(root);
    const problems = a11ySweep(root);
    expect(problems.join('\n')).toMatch(/duplicate id "x"/);
    expect(problems.join('\n')).toMatch(/aria-describedby="nope"/);
    expect(problems.filter((p) => p.includes('no accessible name'))).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/table has no caption/);
    expect(disabledWithoutReason(root, /^Delete$/)).toEqual(['disabled "Delete" gives no reason']);
    root.remove();
  });
});

describe('light and dark themes', () => {
  it('the Settings → AI stylesheet uses design tokens only (no literal colour), so both themes come from index.css', () => {
    const css = readFileSync(join(__dirname, 'ai-settings.css'), 'utf8');
    expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? []).toEqual([]);
  });
});

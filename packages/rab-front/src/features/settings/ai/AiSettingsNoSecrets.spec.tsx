import { fireEvent, screen } from '@testing-library/react';

import { api } from '../../../shared/api';
import {
  agentFixture,
  agentRoleFixture,
  AVAILABLE,
  dailyFixture,
  overviewFixture,
  promptFixture,
  renderSettings,
  routeApi,
  skillsFixture,
  toolsFixture,
  usageFixture,
  type ApiCall,
} from './aiSettingsTestKit';

/**
 * U4 / U6 / U7: no API key or provider value ever reaches a screen. Every response below is POISONED with key-shaped
 * canaries in fields the contracts don't have (`apiKey`, `providerKey`, `secret`, nested `provider.credentials`) and in
 * an unknown top-level block. Each screen is rendered and the whole page text (and every attribute) is checked: no
 * canary, nothing key-shaped. Requests are checked too: no canary is ever sent back.
 */
jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const mocked = api as unknown as { get: jest.Mock; put: jest.Mock; post: jest.Mock; delete: jest.Mock; patch: jest.Mock };

const CANARY = 'sk-ant-api03-U4U6U7CANARY000000000000000000000000';
const PROVIDER_CANARY = 'ANTHROPIC_API_KEY=sk-live-PROVIDERCANARY0000000000';
const poison = <T extends object>(v: T): T => ({ ...v, apiKey: CANARY, providerKey: PROVIDER_CANARY, secret: CANARY, provider: { credentials: CANARY }, debug: { env: PROVIDER_CANARY } });
const poisonRows = <T extends object>(rows: T[]): T[] => rows.map(poison);
const KEY_SHAPED = /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|ANTHROPIC_API_KEY|OPENAI_API_KEY|CANARY/;

let calls: ApiCall[] = [];
beforeEach(() => {
  calls = [];
  const skills = skillsFixture();
  const tools = toolsFixture();
  routeApi(mocked, {
    'get /ai/availability': poison(AVAILABLE),
    'get /ai/settings': poison(overviewFixture({ skills: true, usage: true, agents: true, instructions: true })),
    'get /ai/settings/tools': poison({ tools: poisonRows(tools.tools) }),
    'get /ai/settings/prompt-preview': poison(promptFixture({ skillCatalogue: ['shift-filling: Who could cover an open shift.'] })),
    'get /ai/settings/skills': poison({ ...skills, skills: poisonRows(skills.skills) }),
    'get /ai/settings/instructions': poison({ content: 'Use British English.', contentLength: 20, contentSha256: 'h', updatedAt: null, limits: { maxChars: 2000, reasonMinChars: 3, reasonMaxChars: 500 } }),
    'get /ai/settings/usage': () => poison(usageFixture({ daily: poisonRows(dailyFixture()), byUser: poisonRows(usageFixture().byUser), byModel: poisonRows(usageFixture().byModel) })),
    'get /ai/settings/models': poison({ models: [], tiers: [], setup: null }),
    'get /ai/agents': [poison(agentFixture())],
    'get /ai/agents/a1/role': poison(agentRoleFixture()),
  }, calls);
});

const SCREENS: Array<[string, string, ((/* after render */) => Promise<void>) | null]> = [
  ['Overview', '/settings/ai', null],
  ['System prompt', '/settings/ai?tab=overview&page=prompt', null],
  ['Skills', '/settings/ai?tab=skills', null],
  ['Skill page', '/settings/ai?tab=skills&skill=house-style', null],
  ['Tools', '/settings/ai?tab=tools', null],
  ['Tool page', '/settings/ai?tab=tools&tool=list_unfilled_shifts', null],
  ['Usage', '/settings/ai?tab=usage', async () => { fireEvent.click(await screen.findByRole('button', { name: 'Show as table' })); }],
  ['Agents', '/settings/ai?tab=agents', null],
  ['Agent page', '/settings/ai?tab=agents&agent=a1', null],
  ['Agent role', '/settings/ai?tab=agents&agent=a1', async () => { fireEvent.click(await screen.findByRole('tab', { name: 'Role' })); await screen.findByRole('checkbox', { name: 'See shifts' }); }],
  ['Agent triggers', '/settings/ai?tab=agents&agent=a1', async () => { fireEvent.click(await screen.findByRole('tab', { name: 'Triggers' })); await screen.findByRole('button', { name: 'Turn on' }); }],
];

it.each(SCREENS)('%s: no key, provider value or canary on screen or in any attribute', async (_name, path, then) => {
  const { container } = renderSettings(path);
  await screen.findAllByRole('heading', { level: 3 });
  await new Promise((r) => setTimeout(r, 0));
  if (then) await then();
  expect(container.textContent).not.toMatch(KEY_SHAPED);
  expect(container.innerHTML).not.toMatch(KEY_SHAPED);
  expect(calls.filter((c) => c.method !== 'get').every((c) => !JSON.stringify(c.body ?? {}).match(KEY_SHAPED))).toBe(true);
  expect(calls.every((c) => !JSON.stringify(c.params ?? {}).match(KEY_SHAPED))).toBe(true);
});

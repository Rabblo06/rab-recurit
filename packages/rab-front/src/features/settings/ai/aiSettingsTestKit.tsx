import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { AiChatProvider } from '../../ai/AiChatProvider';
import AiSettingsPage from './AiSettingsPage';

/**
 * TEST-ONLY helpers and FICTIONAL fixtures for the Settings → AI specs (imported by *.spec.tsx only; never by production
 * code). Shapes are the C0/C1 contracts in @rab/shared. `routeApi` answers `METHOD path` from a table and records every
 * call with its body, so a spec can snapshot exactly what left the browser; anything unmapped is a 404.
 */
export const LIMITS = { maxInputChars: 4000, userRatePerMinute: 10, orgDailyTokenBudget: 200000 };
export const AVAILABLE = { available: true, reason: null, limits: LIMITS, usage: { day: '2026-10-25', tokensUsedOrReserved: 1200 } };

export const FEATURES = { skills: false, tools: true, usage: false, promptPreview: true, approvals: false, agents: false, agentExecution: false as const, assistant: false, instructions: false, levels: false, capabilities: false };
export const overviewFixture = (features: Partial<typeof FEATURES> = {}, counts: object | null = { myConversations: 3, orgQuestionsThisMonth: 41, activeSkills: 4, tools: 5 }) => ({
  features: { ...FEATURES, ...features },
  ...(counts ? { counts } : {}),
  limits: { maxInputChars: 4000, userRatePerMinute: 10, orgRatePerMinute: 60, userTurnsPerDay: 100, orgDailyTokenBudget: 200000, orgDailyCostCeilingMicros: 5_000_000, userDailyCostCeilingMicros: 1_000_000 },
});

export const toolsFixture = () => ({
  tools: [
    { name: 'list_unfilled_shifts', label: 'Unfilled shifts', summary: 'Shifts that still need staff in a date range.', kind: 'read', permission: 'schedule.view', permissionLabel: 'View shifts and schedules', held: true, maxRows: 25, maxBytes: null, requiresApproval: false },
    { name: 'compare_payroll_runs', label: 'Payroll run comparison', summary: 'Totals of two payroll runs side by side.', kind: 'read', permission: 'payroll.view', permissionLabel: 'View payroll', held: false, maxRows: 2, maxBytes: null, requiresApproval: false },
  ],
});

export const PROMPT_CANARY = 'sk-ant-api03-PREVIEWCANARY0000000000000000000000';
export const promptFixture = (over: object = {}) => ({
  promptVersion: 'p1-1a2b3c4d',
  tier: 'fast',
  modelId: 'anthropic-claude-haiku-5-5',
  systemPrompt: "You are Crewflow's read-only operations assistant.\nToday is 2026-10-25.",
  skillCatalogue: [],
  toolCatalogue: [{ name: 'list_unfilled_shifts', summary: 'Shifts that still need staff.' }],
  sdkTools: [{ name: 'list_unfilled_shifts', schemaBytes: 210 }],
  tokenEstimate: { estimate: 812, upperBound: 3100 },
  promptCache: 'none',
  generatedAt: '2026-10-25T10:00:00.000Z',
  ...over,
});

export const assistantFixture = (over: object = {}) => ({ preset: 'crewflow', name: 'Crewflow', shape: 'circle', colour: 'orange', face: 'classic', animate: true, isDefault: true, updatedAt: null, ...over });

export const usageFixture = (over: object = {}) => ({
  period: 'today',
  from: '2026-10-25T00:00:00.000Z',
  to: '2026-10-25T23:59:59.999Z',
  totals: { turns: 37, inputTokens: 120_000, cachedInputTokens: 30_000, cacheWriteTokens: 0, outputTokens: 9_000, costUsdMicros: 1_234_567 },
  byUser: [
    { userId: 'u1', displayName: 'Casey Lane', turns: 30, inputTokens: 100_000, cachedInputTokens: 25_000, cacheWriteTokens: 0, outputTokens: 8_000, costUsdMicros: 1_200_000, userCostTodayMicros: 850_000 },
    { userId: 'u2', displayName: 'Robin Ashford', turns: 7, inputTokens: 20_000, cachedInputTokens: 5_000, cacheWriteTokens: 0, outputTokens: 1_000, costUsdMicros: 999, userCostTodayMicros: 999 },
  ],
  byModel: [{ modelId: 'anthropic-claude-haiku-5-5', label: 'Claude Haiku 5.5', turns: 37, inputTokens: 120_000, cachedInputTokens: 30_000, cacheWriteTokens: 0, outputTokens: 9_000, costUsdMicros: 1_234_567 }],
  budgets: { orgDailyCostCeilingMicros: 5_000_000, userDailyCostCeilingMicros: 1_000_000, orgDailyTokenBudget: 200_000 },
  today: { orgCostMicros: 4_100_000, orgTokensUsedOrReserved: 120_000, alerts: ['cost'] },
  ...over,
});

export interface ApiCall { method: string; url: string; body: unknown; params?: unknown }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = { mockImplementation: (fn: (...args: any[]) => unknown) => unknown };
type Route = unknown | ((body: unknown, params?: Record<string, unknown>) => unknown);

/** Answers `METHOD url` from `routes` (a value or a function of the body); unmapped → 404. Records every call. */
export function routeApi(api: { get: MockFn; put: MockFn; post: MockFn; delete: MockFn; patch?: MockFn }, routes: Record<string, Route>, calls: ApiCall[]) {
  const answer = (method: string) => (url: string, a?: unknown, b?: unknown) => {
    const config = (method === 'get' || method === 'delete' ? a : b) as { params?: Record<string, unknown>; data?: unknown } | undefined;
    const body = method === 'get' ? undefined : method === 'delete' ? config?.data : a;
    calls.push({ method, url, body, params: config?.params });
    const hit = routes[`${method} ${url}`];
    if (hit === undefined) return Promise.reject({ isAxiosError: true, response: { status: 404, data: { statusCode: 404, code: 'AI_NOT_AVAILABLE', message: 'Not found.' } } });
    const value = typeof hit === 'function' ? (hit as (b: unknown, p?: Record<string, unknown>) => unknown)(body, config?.params) : hit;
    if (value && typeof value === 'object' && 'httpStatus' in (value as object)) {
      const { httpStatus, ...data } = value as { httpStatus: number };
      return Promise.reject({ isAxiosError: true, response: { status: httpStatus, data } });
    }
    return Promise.resolve({ data: value });
  };
  api.get.mockImplementation(answer('get'));
  api.put.mockImplementation(answer('put'));
  api.post.mockImplementation(answer('post'));
  api.delete.mockImplementation(answer('delete'));
  api.patch?.mockImplementation(answer('patch'));
}

export function renderSettings(path = '/settings/ai') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <AiChatProvider workspaceId="ws-a">
          <MemoryRouter initialEntries={[path]}>
            <AiSettingsPage />
          </MemoryRouter>
        </AiChatProvider>
      </QueryClientProvider>,
    ),
  };
}

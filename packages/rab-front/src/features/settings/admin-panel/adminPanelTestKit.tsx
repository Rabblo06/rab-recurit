import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

/**
 * TEST-ONLY helpers for the Admin panel specs (imported by *.spec.tsx only; never by production code) (fixtures mirror the server's allowlist mapper shapes; nothing here is used
 * by production code). `routes` maps an exact API path to a response body; anything unmapped rejects with a 404.
 */
export function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) };
}

type MockFn = { mockImplementation: (fn: (url: string, config?: { params?: Record<string, unknown> }) => Promise<{ data: unknown }>) => unknown };

export function routeGet(get: MockFn, routes: Record<string, unknown | ((params?: Record<string, unknown>) => unknown)>) {
  get.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
    const hit = routes[url];
    // Unmapped endpoints fail like a real 404, so specs also exercise the honest error / "not available" states.
    if (hit === undefined) return Promise.reject({ isAxiosError: true, response: { status: 404, data: { message: 'Not found' } } });
    return Promise.resolve({ data: typeof hit === 'function' ? (hit as (p?: Record<string, unknown>) => unknown)(config?.params) : hit });
  });
}

export const ME = { id: 'me-0000-4000-8000-000000000001', organisationId: 'org-0000-4000-8000-000000000001' };

export function user(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u1-00000-4000-8000-000000000001',
    organisationId: 'org-2',
    organisationName: 'Example Agency Ltd',
    firstName: 'Alex',
    lastName: 'Morgan',
    email: 'alex@example-agency.test',
    status: 'active',
    createdAt: '2026-10-24T08:00:00.000Z',
    lastLoginAt: '2026-10-24T08:42:00.000Z',
    isPlatformAdmin: false,
    roleKeys: ['ceo'],
    roles: ['CEO'],
    twoFactor: { enabled: true, enabledAt: '2026-10-24T09:00:00.000Z', recoveryCodesRemaining: 8, recoveryCodesTotal: 10 },
    ...over,
  };
}

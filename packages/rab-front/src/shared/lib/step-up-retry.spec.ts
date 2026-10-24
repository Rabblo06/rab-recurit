import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

import { installStepUpRetry, registerStepUpHandler } from './step-up-retry';

const api = axios.create();
installStepUpRetry(api);

/**
 * Lane D (M10-2): the API client's step-up replay (installed on `shared/api`'s instance exactly like this). A 403 STEP_UP_REQUIRED asks the registered handler ONCE (shared by
 * concurrent refusals), replays the original request once on success, and fails it otherwise. The server remains the
 * only authority — these tests only pin the client plumbing.
 */
type Reply = { status: number; data: unknown };

function adapterFrom(script: (config: InternalAxiosRequestConfig) => Reply): { adapter: AxiosAdapter; seen: string[] } {
  const seen: string[] = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(`${config.method?.toUpperCase()} ${config.url}`);
    const reply = script(config);
    const response = { data: reply.data, status: reply.status, statusText: String(reply.status), headers: {}, config };
    if (reply.status >= 400) {
      throw Object.assign(new Error(`HTTP ${reply.status}`), { isAxiosError: true, config, response, toJSON: () => ({}) });
    }
    return response;
  };
  return { adapter, seen };
}

const stepUpRequired = (mfa: boolean): Reply => ({ status: 403, data: { code: 'STEP_UP_REQUIRED', mfa, message: 'Confirm it’s you to continue.' } });

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
  api.defaults.adapter = undefined;
});

it('a STEP_UP_REQUIRED refusal asks the handler (with the mfa hint) and replays the original request once on success', async () => {
  let granted = false;
  const { adapter, seen } = adapterFrom((config) => (config.url === '/staff/s1/deactivate' && !granted ? stepUpRequired(true) : { status: 200, data: { ok: true } }));
  api.defaults.adapter = adapter;
  const handler = jest.fn(async ({ mfa }: { mfa: boolean }) => {
    expect(mfa).toBe(true);
    granted = true;
    return true;
  });
  unregister = registerStepUpHandler(handler);
  const res = await api.post('/staff/s1/deactivate', {});
  expect(res.data).toEqual({ ok: true });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(seen).toEqual(['POST /staff/s1/deactivate', 'POST /staff/s1/deactivate']);
});

it('cancelling the prompt fails the original request with the server’s 403 (no replay)', async () => {
  const { adapter, seen } = adapterFrom(() => stepUpRequired(false));
  api.defaults.adapter = adapter;
  unregister = registerStepUpHandler(async () => false);
  await expect(api.post('/roles', { name: 'x' })).rejects.toMatchObject({ response: { status: 403 } });
  expect(seen).toEqual(['POST /roles']);
});

it('a replay that is refused again is NOT prompted a second time (no loop)', async () => {
  const { adapter, seen } = adapterFrom(() => stepUpRequired(false));
  api.defaults.adapter = adapter;
  const handler = jest.fn(async () => true);
  unregister = registerStepUpHandler(handler);
  await expect(api.post('/members/u1/suspend', {})).rejects.toMatchObject({ response: { status: 403 } });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(seen).toHaveLength(2);
});

it('concurrent refusals (a bulk action) share ONE prompt and all replay', async () => {
  let granted = false;
  const { adapter } = adapterFrom((config) => (!granted && config.url!.endsWith('/deactivate') ? stepUpRequired(false) : { status: 200, data: config.url }));
  api.defaults.adapter = adapter;
  let release: (ok: boolean) => void = () => undefined;
  const handler = jest.fn(() => new Promise<boolean>((resolve) => { release = (ok) => { granted = ok; resolve(ok); }; }));
  unregister = registerStepUpHandler(handler);
  const all = Promise.all(['/staff/a/deactivate', '/staff/b/deactivate', '/staff/c/deactivate'].map((u) => api.post(u, {})));
  await new Promise((r) => setTimeout(r, 0));
  release(true);
  const results = await all;
  expect(results.map((r) => r.data)).toEqual(['/staff/a/deactivate', '/staff/b/deactivate', '/staff/c/deactivate']);
  expect(handler).toHaveBeenCalledTimes(1);
});

it('other 403s (a plain permission refusal) and the step-up call itself never prompt', async () => {
  const { adapter } = adapterFrom((config) => (config.url === '/auth/step-up' ? stepUpRequired(true) : { status: 403, data: { message: 'You do not have access to this.' } }));
  api.defaults.adapter = adapter;
  const handler = jest.fn(async () => true);
  unregister = registerStepUpHandler(handler);
  await expect(api.post('/payroll/approve', {})).rejects.toMatchObject({ response: { status: 403 } });
  await expect(api.post('/auth/step-up', { currentPassword: 'x' })).rejects.toMatchObject({ response: { status: 403 } });
  expect(handler).not.toHaveBeenCalled();
});

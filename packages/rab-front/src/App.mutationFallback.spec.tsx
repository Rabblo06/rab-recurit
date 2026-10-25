import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { createAppMutationCache, MUTATION_ERROR_HANDLED, MUTATION_FALLBACK_MESSAGE } from './App';
import { getApiErrorMessage } from './shared/lib/apiError';
import { TOAST_EVENT, type ToastDetail } from './shared/lib/toast';

jest.mock('./shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
  bootstrapSession: jest.fn().mockResolvedValue(false),
  observeIdentityErrors: jest.fn(() => () => undefined),
  registerStepUpHandler: jest.fn(() => () => undefined),
  withAuthLock: jest.fn((run: () => unknown) => run()),
  broadcastLogout: jest.fn(),
  broadcastLogin: jest.fn(),
  resolveIdentityViaCookie: jest.fn().mockResolvedValue(false),
  getLastMeSnapshot: jest.fn().mockReturnValue(null),
  getLastIdentityFailure: jest.fn().mockReturnValue('rejected'),
}));

/**
 * FEEDBACK_REPORT §6 "SettingsLayout / App.tsx": the global MutationCache fallback. It must catch a failure nobody can
 * show, and NEVER double-announce one that a handler (hook `onError`, `useFeedbackMutation`, an inline `mutation.error`,
 * a `mutateAsync` catch) already shows.
 */
const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data } });

let toasts: ToastDetail[] = [];
const onToast = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail);
beforeEach(() => {
  toasts = [];
  document.addEventListener(TOAST_EVENT, onToast);
});
afterEach(() => document.removeEventListener(TOAST_EVENT, onToast));

function client() {
  return new QueryClient({ mutationCache: createAppMutationCache(), defaultOptions: { mutations: { retry: false } } });
}

/** Starts a mutation with the given options, then (optionally) unmounts before the server answers. */
function Starter({ options, start }: { options: Parameters<typeof useMutation>[0]; start: (m: ReturnType<typeof useMutation>) => void }) {
  const mutation = useMutation(options);
  const [started, setStarted] = useState(false);
  if (!started) {
    setStarted(true);
    queueMicrotask(() => start(mutation));
  }
  return mutation.isError ? <p role="alert">{getApiErrorMessage(mutation.error, 'Inline failure text.')}</p> : <p>idle</p>;
}

function Host({ qc, show, ...props }: { qc: QueryClient; show: boolean } & Parameters<typeof Starter>[0]) {
  return <QueryClientProvider client={qc}>{show ? <Starter {...props} /> : <p>gone</p>}</QueryClientProvider>;
}

async function runAndUnmount(options: Parameters<typeof useMutation>[0], error: unknown) {
  const qc = client();
  let fail: (e: unknown) => void = () => undefined;
  const fullOptions = { ...options, mutationFn: () => new Promise((_resolve, reject) => (fail = reject)) };
  const view = render(<Host qc={qc} show options={fullOptions} start={(m) => m.mutate(undefined)} />);
  await waitFor(() => expect(qc.isMutating()).toBe(1));
  view.rerender(<Host qc={qc} show={false} options={fullOptions} start={() => undefined} />); // the drawer closed
  await act(async () => {
    fail(error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('a failure nobody is left to show (the component unmounted, no onError) becomes ONE red toast with safe text', async () => {
  await runAndUnmount({}, httpError(503, { message: 'QueryFailedError: relation "x" does not exist' }));
  expect(toasts).toEqual([expect.objectContaining({ variant: 'error', message: MUTATION_FALLBACK_MESSAGE })]);
});

it('an expired session in that case is the persistent "Sign in again" toast', async () => {
  await runAndUnmount({}, httpError(401, {}));
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatchObject({ persistent: true });
  expect(toasts[0]!.action?.label).toBe('Sign in again');
});

it('never for a mutation with its own onError (useFeedbackMutation and hand-written handlers), even after unmount', async () => {
  const onError = jest.fn();
  await runAndUnmount({ onError }, httpError(503));
  expect(onError).toHaveBeenCalled();
  expect(toasts).toEqual([]);
});

it('never when the call site opts out (meta.errorFeedback = handled), nor for a cancelled request or a step-up refusal', async () => {
  await runAndUnmount({ meta: { errorFeedback: MUTATION_ERROR_HANDLED } }, httpError(503));
  await runAndUnmount({}, Object.assign(new Error('canceled'), { isAxiosError: true, code: 'ERR_CANCELED' }));
  await runAndUnmount({}, httpError(403, { code: 'STEP_UP_REQUIRED' }));
  expect(toasts).toEqual([]);
});

it('never while the component that started it is mounted: it owns the error (inline alert here), so no second announcement', async () => {
  const qc = client();
  render(
    <Host
      qc={qc}
      show
      options={{ mutationFn: () => Promise.reject(httpError(409, { message: 'This record has changed. Refresh and try again.' })) }}
      start={(m) => m.mutate(undefined)}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('This record has changed. Refresh and try again.');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(toasts).toEqual([]);
});

it('never for a mounted mutateAsync caller that catches the failure itself', async () => {
  const qc = client();
  const caught = jest.fn();
  render(
    <Host
      qc={qc}
      show
      options={{ mutationFn: () => Promise.reject(httpError(503)) }}
      start={(m) => void m.mutateAsync(undefined).catch(caught)}
    />,
  );
  await waitFor(() => expect(caught).toHaveBeenCalled());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(toasts).toEqual([]);
});

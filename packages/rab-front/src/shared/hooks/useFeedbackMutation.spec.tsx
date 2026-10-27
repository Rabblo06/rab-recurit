import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TOAST_EVENT, type ToastDetail } from '../lib/toast';
import { useFeedbackMutation } from './useFeedbackMutation';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function captureToasts() {
  const seen: ToastDetail[] = [];
  const on = (e: Event) => seen.push((e as CustomEvent<ToastDetail>).detail);
  document.addEventListener(TOAST_EVENT, on);
  return { seen, stop: () => document.removeEventListener(TOAST_EVENT, on) };
}

const httpError = (status: number, data: unknown) => Object.assign(new Error('x'), { isAxiosError: true, response: { status, data } });

describe('useFeedbackMutation', () => {
  it('submit() is a synchronous in-flight guard: repeated calls before the answer start one request', async () => {
    let resolve!: (v: string) => void;
    const fn = jest.fn(() => new Promise<string>((r) => (resolve = r)));
    const { result } = renderHook(() => useFeedbackMutation<string, number>({ mutationFn: fn, errorFeedback: { fallback: 'Could not do it.' } }), { wrapper });
    let started: boolean[] = [];
    act(() => {
      started = [result.current.submit(1), result.current.submit(2), result.current.submit(3)];
    });
    expect(started).toEqual([true, false, false]);
    expect(result.current.busy).toBe(true);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    await act(async () => resolve('ok'));
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => void result.current.submit(4));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  });

  it('success toast only from the confirmed response; caller onSuccess still runs', async () => {
    const toasts = captureToasts();
    const onSuccess = jest.fn();
    const { result } = renderHook(
      () => useFeedbackMutation<{ n: number }>({ mutationFn: async () => ({ n: 3 }), successMessage: (d) => `Done ${d.n}.`, errorFeedback: { fallback: 'x' }, onSuccess }),
      { wrapper },
    );
    act(() => void result.current.submit());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(toasts.seen.map((t) => [t.variant, t.message])).toEqual([['success', 'Done 3.']]);
    toasts.stop();
  });

  it('errors: a safe toast with "Try again" for retryable failures, none for validation; errorFeedback false shows nothing', async () => {
    const toasts = captureToasts();
    const fn = jest.fn().mockRejectedValueOnce(httpError(503, { message: 'pg_terminate_backend' })).mockRejectedValueOnce(httpError(409, { message: 'This shift has already been published.' }));
    const { result } = renderHook(() => useFeedbackMutation<unknown, void>({ mutationFn: fn, errorFeedback: { fallback: 'Could not publish the shift.' } }), { wrapper });
    act(() => void result.current.submit());
    await waitFor(() => expect(toasts.seen).toHaveLength(1));
    expect(toasts.seen[0]).toMatchObject({ variant: 'error', message: 'Could not publish the shift.' });
    expect(toasts.seen[0].action?.label).toBe('Try again');
    act(() => toasts.seen[0].action!.onClick());
    await waitFor(() => expect(toasts.seen).toHaveLength(2));
    expect(toasts.seen[1]).toMatchObject({ variant: 'error', message: 'This shift has already been published.' });
    expect(toasts.seen[1].action).toBeUndefined();

    const silent = renderHook(() => useFeedbackMutation<unknown, void>({ mutationFn: () => Promise.reject(httpError(500, {})), errorFeedback: false }), { wrapper });
    act(() => void silent.result.current.submit());
    await waitFor(() => expect(silent.result.current.isError).toBe(true));
    expect(toasts.seen).toHaveLength(2);
    toasts.stop();
  });
});

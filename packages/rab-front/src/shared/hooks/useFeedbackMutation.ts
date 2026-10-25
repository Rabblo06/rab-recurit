import { useCallback, useRef, useState } from 'react';
import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';
import { toast } from '../lib/toast';
import { notifyApiError, type NotifyApiErrorOptions } from '../lib/mutationFeedback';

type ErrorFeedback<TVars> = Omit<NotifyApiErrorOptions, 'retry'> | ((error: unknown, vars: TVars) => Omit<NotifyApiErrorOptions, 'retry'> | false);

export interface FeedbackMutationOptions<TData, TVars, TContext> extends UseMutationOptions<TData, unknown, TVars, TContext> {
  /** Success toast, raised only from `onSuccess` (the server confirmed). A function may return null for "no toast". */
  successMessage?: string | ((data: TData, vars: TVars) => string | null | undefined);
  /**
   * Error toast via `notifyApiError`. `false` (or a function returning `false`) means the caller shows the error inline
   * instead (a form's own error line): one announcement, never an inline alert AND an assertive toast for the same failure.
   */
  errorFeedback: ErrorFeedback<TVars> | false;
  /** Offer "Try again" (same variables) when the failure is retryable. Default true. */
  offerRetry?: boolean;
}

export type FeedbackMutationResult<TData, TVars, TContext> = UseMutationResult<TData, unknown, TVars, TContext> & {
  /**
   * Starts the mutation unless one from this hook is already in flight; returns whether it started. Use this from the
   * triggering control instead of `mutate`: TanStack's `isPending` only re-renders on the next tick, so a fast
   * double-click can otherwise send the same request twice.
   */
  submit: (vars: TVars) => boolean;
  /** True from the click that started the request until the server answered (synchronous, unlike `isPending`). */
  busy: boolean;
};

/**
 * `useMutation` plus the app's standard user feedback: loading/duplicate guard (`submit` + `busy`), a success toast only
 * after the server confirms, and a safe error toast with a next action. The caller's own `onSuccess` / `onError` /
 * `onSettled` still run (after the feedback), so query invalidation, closing a drawer or mapping field errors stay where
 * they are. Form state is never touched here: on failure everything the user typed stays as it was.
 */
export function useFeedbackMutation<TData = unknown, TVars = void, TContext = unknown>(
  options: FeedbackMutationOptions<TData, TVars, TContext>,
): FeedbackMutationResult<TData, TVars, TContext> {
  const { successMessage, errorFeedback, offerRetry = true, onSuccess, onError, onSettled, ...rest } = options;
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const submitRef = useRef<(vars: TVars) => boolean>(() => false);

  const mutation = useMutation<TData, unknown, TVars, TContext>({
    ...rest,
    onSuccess: (data, vars, context, ...more) => {
      const text = typeof successMessage === 'function' ? successMessage(data, vars) : successMessage;
      if (text) toast.success(text);
      return (onSuccess as ((...args: unknown[]) => unknown) | undefined)?.(data, vars, context, ...more);
    },
    onError: (error, vars, context, ...more) => {
      const feedback = typeof errorFeedback === 'function' ? errorFeedback(error, vars) : errorFeedback;
      if (feedback) notifyApiError(error, { ...feedback, retry: offerRetry ? () => void submitRef.current(vars) : undefined });
      return (onError as ((...args: unknown[]) => unknown) | undefined)?.(error, vars, context, ...more);
    },
    onSettled: (data, error, vars, context, ...more) => {
      inFlight.current = false;
      setBusy(false);
      return (onSettled as ((...args: unknown[]) => unknown) | undefined)?.(data, error, vars, context, ...more);
    },
  });

  const { mutate } = mutation;
  const submit = useCallback(
    (vars: TVars) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      mutate(vars);
      return true;
    },
    [mutate],
  );
  submitRef.current = submit;

  return Object.assign(mutation, { submit, busy: busy || mutation.isPending });
}

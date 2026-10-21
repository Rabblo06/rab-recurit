export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  /** Display time in ms. Defaults per variant (`TOAST_DURATION_MS`); clamped to 2–15 s. */
  duration?: number;
}

export interface ToastDetail {
  id: number;
  message: string;
  variant: ToastVariant;
  /** Absent → the variant default. */
  duration?: number;
}

/**
 * How long each variant stays on screen. The tinted fill drains over exactly this time; it is display time only and
 * never stands for the progress of an operation. Errors and warnings stay longer so they can be read.
 */
export const TOAST_DURATION_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  warning: 7000,
  error: 7000,
};

/** At most this many toasts are visible; later ones wait in a queue and appear as earlier ones leave. */
export const TOAST_MAX_VISIBLE = 3;

export const TOAST_EVENT = 'toast';
export const TOAST_DISMISS_EVENT = 'toast-dismiss';

let nextId = 1;

function clampDuration(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Math.min(15000, Math.max(2000, Math.round(ms)));
}

function emit(message: string, variant: ToastVariant, options?: ToastOptions): number {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return 0;
  const detail: ToastDetail = { id: nextId++, message: text, variant, duration: clampDuration(options?.duration) };
  document.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
  return detail.id;
}

/**
 * Temporary feedback (toasts). CustomEvent bus, matching the app's `open-create-user` convention, so any feature can
 * raise one without importing the shell. Rendered by `shell/ToastHost`, mounted once at the app root (`App.tsx`), so
 * toasts also show on onboarding/auth screens and survive route changes.
 *
 * - Same variant + message while one is already showing or queued → that toast's timer restarts; no second card.
 * - For a failed API call, build the text with `getApiErrorMessage(error, fallback)` (`shared/lib/apiError`) — never
 *   show `error.response.data.message` or `error.message` directly.
 * - Not for field validation, destructive confirmations or persistent page/empty/error states: keep those inline.
 *
 * Each call returns the toast id (0 for an empty message), usable with `toast.dismiss(id)`.
 */
export const toast = {
  success: (message: string, options?: ToastOptions) => emit(message, 'success', options),
  error: (message: string, options?: ToastOptions) => emit(message, 'error', options),
  warning: (message: string, options?: ToastOptions) => emit(message, 'warning', options),
  info: (message: string, options?: ToastOptions) => emit(message, 'info', options),
  /** Dismiss one toast by id, or every visible and queued toast when called without an id. */
  dismiss: (id?: number) => {
    document.dispatchEvent(new CustomEvent<{ id?: number }>(TOAST_DISMISS_EVENT, { detail: { id } }));
  },
};

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastDetail {
  id: number;
  message: string;
  variant: ToastVariant;
}

let nextId = 1;

function emit(message: string, variant: ToastVariant): void {
  const detail: ToastDetail = { id: nextId++, message, variant };
  document.dispatchEvent(new CustomEvent<ToastDetail>('toast', { detail }));
}

/**
 * CustomEvent-bus toast API, matching the app's existing
 * `open-create-user`/`open-create-placement` convention — no new npm
 * dependency. Rendered by `ToastHost`, mounted once in `Layout.tsx`.
 */
export const toast = {
  success: (message: string) => emit(message, 'success'),
  error: (message: string) => emit(message, 'error'),
  info: (message: string) => emit(message, 'info'),
};

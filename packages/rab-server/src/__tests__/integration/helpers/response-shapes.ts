/**
 * Manager-facing list endpoints (`/shifts`, `/venues`, `/staff`, `/offers`,
 * `/users`, ...) return `{ data, total }`; a few older/mobile ones still return
 * a bare array. The SECURITY property these suites assert is "which rows are
 * visible", not the envelope, so they read rows through this helper.
 *
 * It fails loudly on anything that is neither shape (e.g. an error body), so a
 * 4xx/5xx payload can never be mistaken for "an empty list" and make an
 * isolation assertion pass vacuously.
 */
export function rowsOf<T = Record<string, unknown>>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: T[] }).data;
  }
  throw new Error(`Expected a list response (array or { data: [] }) but got: ${JSON.stringify(body)?.slice(0, 200)}`);
}

/** Convenience: the ids of every visible row. */
export const idsOf = (body: unknown): string[] => rowsOf<{ id: string }>(body).map((r) => r.id);

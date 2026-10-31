import { api } from '../api';
import { MAX_PAGE_SIZE } from './pageSize';

export { LIST_PAGE_SIZE, MAX_PAGE_SIZE } from './pageSize';

/** A walk that would need more pages than this (40 000 rows) fails loudly instead of truncating or running forever. */
export const MAX_WALK_PAGES = 200;

export class ListTooLargeError extends Error {
  constructor(url: string) {
    super(`The list at ${url} is too large to load completely.`);
    this.name = 'ListTooLargeError';
  }
}

/**
 * Every row of an offset-paged list endpoint (`{ data, total }`), fetched in pages of 200 so nothing is silently
 * truncated. Stops at the first short page or once `total` rows are in hand. A bare-array answer (an endpoint that does
 * not page) is returned as is.
 */
export async function fetchAllPages<T>(url: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_WALK_PAGES; page++) {
    const { data } = await api.get<{ data: T[]; total?: number } | T[]>(url, { params: { ...params, page, limit: MAX_PAGE_SIZE } });
    if (Array.isArray(data)) return rows.concat(data);
    const batch = Array.isArray(data?.data) ? data.data : [];
    rows.push(...batch);
    const total = typeof data?.total === 'number' ? data.total : undefined;
    if (batch.length < MAX_PAGE_SIZE || (total !== undefined && rows.length >= total)) return rows;
  }
  throw new ListTooLargeError(url);
}

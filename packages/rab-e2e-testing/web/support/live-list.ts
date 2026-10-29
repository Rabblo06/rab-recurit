import type { Page, Response } from '@playwright/test';

/**
 * Helpers for the live-backend table-toolbar specs (table-toolbar-users, table-toolbar-remaining-pages).
 *
 * Returning to a query the console fetched less than 30 s earlier is answered from React Query's cache, without a request
 * (App.tsx `staleTime: 30_000`, a74a2110, 2026-09-25 — after these specs were written). So "Clear all / the All tab brings
 * back the full server-backed dataset" is checked against the total the server returned for that unfiltered query when the
 * page loaded, whether the page shows it from the cache or refetches it.
 */

/** The server total a list page shows: "N records" (shared RecordFooter) or "N entries" (Audit Log footer). NaN until rendered. */
export async function listTotal(page: Page): Promise<number> {
  const text = ((await page.locator('.list-footer > span, .table-footer > span').first().textContent()) ?? '').trim();
  const match = /^([\d,]+) (records?|entry|entries)$/.exec(text);
  return match ? Number(match[1]!.replace(/,/g, '')) : Number.NaN;
}

/** Resolves with the next successful GET of a list endpoint (`/rest/v1/<resource>` with or without a query, never `/<id>`). */
export function nextListResponse(page: Page, resource: string): Promise<Response> {
  const list = new RegExp(`/rest/v1/${resource}(\\?|$)`);
  return page.waitForResponse((r) => list.test(r.url()) && r.request().method() === 'GET' && r.ok());
}

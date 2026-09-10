import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ActiveFilters, SortState, TableToolbarConfig } from './types';

function filterParamKeys(config: TableToolbarConfig): string[] {
  return config.filters.flatMap((f) =>
    f.type === 'dateRange' || f.type === 'numberRange' ? [`${f.key}From`, `${f.key}To`] : [f.key],
  );
}

/**
 * Filter/sort/page state lives in the URL (`?q=&status=&sort=&direction=&page=`)
 * — refresh keeps it, back/forward works, a view is shareable by copying the
 * link. Nothing filter-related here is ever sensitive (no org/workspace id is
 * ever a param — those come only from the verified session, never the URL).
 */
export function useTableQueryState(config: TableToolbarConfig) {
  const [params, setParams] = useSearchParams();
  const filterKeys = useMemo(() => filterParamKeys(config), [config]);

  // One-time: if a `defaultFilters` key has genuinely never been touched
  // (absent from the URL, not merely cleared-to-"Any" — after this runs
  // once, absence means the latter, since the key gets written into the
  // URL for real below), write it in as a real, visible param — not a
  // hidden fallback applied every render, which could never be
  // distinguished from a user's deliberate "Any" choice once cleared.
  // `replace: true` avoids an extra back-button stop for a default the
  // user never asked to see.
  const appliedDefaults = useRef(false);
  useEffect(() => {
    if (appliedDefaults.current || !config.defaultFilters) return;
    appliedDefaults.current = true;
    const missing = Object.entries(config.defaultFilters).filter(([key]) => !params.has(key));
    if (missing.length === 0) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of missing) next.set(key, value);
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = params.get('q') ?? '';
  const filters: ActiveFilters = useMemo(() => {
    const out: ActiveFilters = {};
    for (const key of filterKeys) {
      const value = params.get(key);
      if (value) out[key] = value;
    }
    return out;
  }, [params, filterKeys]);

  const sortState: SortState = {
    sort: params.get('sort') ?? config.defaultSort?.key ?? '',
    direction: (params.get('direction') as 'asc' | 'desc') ?? config.defaultSort?.direction ?? 'asc',
  };
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const update = useCallback(
    (mutate: (next: URLSearchParams) => void, resetPage: boolean) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        if (resetPage) next.delete('page');
        return next;
      });
    },
    [setParams],
  );

  const setSearch = useCallback(
    (q: string) => update((next) => { if (q) next.set('q', q); else next.delete('q'); }, true),
    [update],
  );

  const setFilters = useCallback(
    (next: ActiveFilters) =>
      update((p) => {
        for (const key of filterKeys) p.delete(key);
        for (const [key, value] of Object.entries(next)) if (value) p.set(key, value);
      }, true),
    [update, filterKeys],
  );

  const setSort = useCallback(
    (next: SortState) => update((p) => { p.set('sort', next.sort); p.set('direction', next.direction); }, true),
    [update],
  );

  const setPage = useCallback(
    (next: number) => update((p) => { if (next > 1) p.set('page', String(next)); else p.delete('page'); }, false),
    [update],
  );

  const clearFilters = useCallback(() => setFilters({}), [setFilters]);

  // Count logical filters, not raw params — a dateRange/numberRange filter
  // uses two params (`${key}From`/`${key}To`) but is one filter to the user.
  const activeFilterCount = config.filters.filter((f) => {
    if (f.type === 'dateRange' || f.type === 'numberRange') {
      return Boolean(filters[`${f.key}From`] || filters[`${f.key}To`]);
    }
    return Boolean(filters[f.key]);
  }).length;

  return { search, filters, sort: sortState, page, setSearch, setFilters, setSort, setPage, clearFilters, activeFilterCount };
}

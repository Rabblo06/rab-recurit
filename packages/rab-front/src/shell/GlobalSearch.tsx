import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconSearch, IconX } from '@tabler/icons-react';
import { api } from '../shared/api';
import { EmptyState, ListSkeleton } from '../shared/components/LoadingState';
import RightSidePanel from '../shared/components/RightSidePanel';

/** 250ms — short enough to feel live, long enough not to fire a request per keystroke. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

type Result = { id: string; name: string; type: string; group: string; to: string };

export default function GlobalSearch({ open, onClose, initialQuery = '' }: {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
}) {
  const nav = useNavigate();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setQuery(initialQuery); setActive(0); }
  }, [open, initialQuery]);

  const debouncedQuery = useDebounced(query.trim(), 250);

  // Bounded, authorized, server-side search — see modules/search on the
  // server. Replaces the previous pattern of downloading full Staff/
  // Manager/Shift/Offer/Venue lists and filtering them in the browser,
  // which silently missed anything past each list's 500-row page cap.
  const { data: results = [], isLoading: loading } = useQuery<Result[]>({
    queryKey: ['search', debouncedQuery],
    queryFn: async () => {
      const { data } = await api.get('/search', { params: { q: debouncedQuery } });
      return data;
    },
    enabled: open && debouncedQuery.length > 0,
  });

  // Group results preserving global indexes for keyboard navigation
  const groups = useMemo(() => {
    const out: { name: string; items: { r: Result; index: number }[] }[] = [];
    results.forEach((r, index) => {
      let g = out.find(x => x.name === r.group);
      if (!g) { g = { name: r.group, items: [] }; out.push(g); }
      g.items.push({ r, index });
    });
    return out;
  }, [results]);

  useEffect(() => {
    const el = listRef.current?.querySelector('.search-result.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function pick(r: Result) {
    onClose();
    nav(r.to);
  }

  return (
    <RightSidePanel open={open} onClose={onClose}>
      <div
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && results[active]) pick(results[active]);
        }}
      >
        <div className="side-panel-input">
          <button className="btn-icon" onClick={onClose} title="Close"><IconX size={15}/></button>
          <IconSearch size={15}/>
          <input
            placeholder="Search staff, managers, shifts, offers, venues…"
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            autoFocus
          />
        </div>
        <div className="side-panel-body" ref={listRef}>
          {loading ? (
            <ListSkeleton rows={5} />
          ) : results.length === 0 ? (
            <EmptyState compact variant="matches" title="No results found" description="Try another search term." />
          ) : (
            groups.map(g => (
              <div key={g.name}>
                <div className="command-section">{g.name}</div>
                {g.items.map(({ r, index }) => {
                  const c = getColor(r.name);
                  return (
                    <button
                      key={`${r.type}-${r.id}`}
                      className={`search-result${index === active ? ' active' : ''}`}
                      onClick={() => pick(r)}
                      onMouseEnter={() => setActive(index)}
                    >
                      <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{r.name[0]}</span>
                      <span className="search-result-name">{r.name}</span>
                      <span className="search-result-type">{r.type}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </RightSidePanel>
  );
}

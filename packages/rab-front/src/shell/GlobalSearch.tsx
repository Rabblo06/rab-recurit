import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconSearch, IconX } from '@tabler/icons-react';
import { api } from '../shared/api';
import RightSidePanel from '../shared/components/RightSidePanel';

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

  const { data: staff = [], isLoading: l1 } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => { const { data } = await api.get('/staff'); return data; },
    enabled: open,
  });
  const { data: managers = [], isLoading: l2 } = useQuery({
    queryKey: ['managers'],
    queryFn: async () => { const { data } = await api.get('/managers'); return data; },
    enabled: open,
  });
  const { data: shifts = [], isLoading: l3 } = useQuery({
    queryKey: ['shifts'],
    queryFn: async () => { const { data } = await api.get('/shifts'); return data; },
    enabled: open,
  });
  const { data: offers = [], isLoading: l4 } = useQuery({
    queryKey: ['offers'],
    queryFn: async () => { const { data } = await api.get('/offers'); return data; },
    enabled: open,
  });
  const { data: venues = [], isLoading: l5 } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get('/venues'); return data; },
    enabled: open,
  });

  const loading = l1 || l2 || l3 || l4 || l5;

  const results = useMemo<Result[]>(() => {
    const q = query.toLowerCase().trim();
    const match = (s?: string) => !q || (s ?? '').toLowerCase().includes(q);
    const venueName = (id: string) => venues.find((v: any) => v.id === id)?.name ?? '';
    const out: Result[] = [];
    for (const s of staff) {
      const name = `${s.firstName} ${s.lastName}`;
      if (match(name) || match(s.email) || match(s.staffRef)) {
        out.push({ id: s.id, name, type: 'Staff', group: 'People', to: '/users' });
      }
    }
    for (const m of managers) {
      const name = `${m.firstName} ${m.lastName}`;
      if (match(name) || match(m.email)) {
        out.push({ id: m.id, name, type: 'Manager', group: 'People', to: '/users' });
      }
    }
    for (const sh of shifts) {
      const name = venueName(sh.venueId);
      if (match(name)) {
        out.push({ id: sh.id, name: `${name} · ${new Date(sh.startsAt).toLocaleDateString('en-GB')}`, type: 'Shift', group: 'Shifts', to: '/shifts' });
      }
    }
    for (const o of offers) {
      if (match(o.staffName) || match(o.venueName)) {
        out.push({ id: o.id, name: `${o.staffName ?? '?'} → ${o.venueName ?? '?'}`, type: 'Offer', group: 'Offers', to: '/offers' });
      }
    }
    for (const v of venues) {
      if (match(v.name)) {
        out.push({ id: v.id, name: v.name, type: 'Venue', group: 'Venues', to: '/venues' });
      }
    }
    return out.slice(0, 40);
  }, [staff, managers, shifts, offers, venues, query]);

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
            <div className="search-empty">Loading…</div>
          ) : results.length === 0 ? (
            <div className="search-empty">No results found</div>
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

import { useRef, useState } from 'react';
import { IconCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';

import { toast } from '../../../shared/lib/toast';
import { adminApi, formatDate, fullName, type AdminOrganisation, type AdminUser } from './adminPanelApi';
import OrganisationResultCard from './OrganisationResultCard';
import PlatformAdminsTable from './PlatformAdminsTable';
import ResetTwoFactorDialog from './ResetTwoFactorDialog';
import UserResultCard from './UserResultCard';
import UserSecurityTable from './UserSecurityTable';

const n = (v: number | undefined) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '—');

/**
 * Admin panel → General (mockup v2): version/commit/migrations, platform counts, Look up (user | organisation) with the
 * account-security "User security" table, platform admins, recent users. Every value is from the server; a missing source
 * shows "Unknown" / "Not available", never a sample number.
 */
export default function GeneralTab({ meId }: { meId?: string }) {
  const general = useQuery({ queryKey: ['admin', 'general'], queryFn: adminApi.general });
  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: adminApi.overview, staleTime: 60_000 });
  const migrations = useQuery({ queryKey: ['admin', 'migrations'], queryFn: adminApi.migrations, staleTime: 60_000 });
  const admins = useQuery({ queryKey: ['admin', 'platform-admins'], queryFn: adminApi.platformAdmins });
  const recent = useQuery({ queryKey: ['admin', 'users', 'recent'], queryFn: () => adminApi.searchUsers('', undefined, 10) });

  const [mode, setMode] = useState<'user' | 'org'>('user');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  // The selected row is kept as its id and read from the CURRENT results, so a card never shows (and acts on) a frozen
  // copy after a reset / grant changed it server-side. The clicked row is only a fallback while it is not in the results.
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [selectedOrg, setSelectedOrg] = useState<AdminOrganisation | null>(null);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [resetDone, setResetDone] = useState<{ userId: string; name: string; revokedSessions: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const users = useQuery({
    queryKey: ['admin', 'users', 'search', query, role],
    queryFn: () => adminApi.searchUsers(query, role || undefined, 25),
    enabled: mode === 'user',
  });
  const orgs = useQuery({ queryKey: ['admin', 'org-search', query], queryFn: () => adminApi.searchOrganisations(query), enabled: mode === 'org' });

  function search(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (q && q.length < (mode === 'user' ? 3 : 2)) {
      toast.info(mode === 'user' ? 'Type at least 3 characters to search.' : 'Type at least 2 characters to search.');
      return;
    }
    setQuery(q);
    setSelectedUser(null);
    setSelectedOrg(null);
    setResetDone(null); // the confirmation belongs to the previous look-up
  }

  const v = general.data;
  const m = migrations.data && typeof migrations.data.applied === 'number' ? migrations.data : undefined;
  // Defensive: a malformed / empty body renders "Not available", never a crash.
  const o = overview.data && overview.data.organisations ? overview.data : undefined;
  const userResults = Array.isArray(users.data) ? users.data : undefined;
  const freshSelected = selectedUser ? userResults?.find((u) => u.id === selectedUser.id) ?? selectedUser : null;
  const shownUser = freshSelected ?? (query && userResults?.length === 1 ? userResults[0]! : null);
  const orgResults = Array.isArray(orgs.data) ? orgs.data : undefined;
  const shownOrg = selectedOrg ?? (query && orgResults?.length === 1 ? orgResults[0]! : null);

  return (
    <>
      <section className="ap-block" aria-label="Platform summary">
        <div className="ap-grid-4">
          <div className="ap-card ap-stat">
            <span className="ap-k">Version</span>
            <span className="ap-v" style={{ fontSize: 18 }}>{v ? v.version : '—'}</span>
            <span className="ap-d">
              Commit {v?.commit ?? 'Unknown'} · {m ? `${m.applied} migrations applied${m.pending ? ` · ${m.pending} pending` : ''}` : 'migrations not available'}
            </span>
          </div>
          <div className="ap-card ap-stat">
            <span className="ap-k">Organisations</span>
            <span className="ap-v">{n(o?.organisations.total)}</span>
            <span className="ap-d">{o ? `${n(o.organisations.active)} active · ${n(o.organisations.suspended)} suspended` : !overview.isLoading ? 'Not available' : '…'}</span>
          </div>
          <div className="ap-card ap-stat">
            <span className="ap-k">Users</span>
            <span className="ap-v">{n(o?.users.total)}</span>
            <span className="ap-d">{o ? `${n(o.users.signedInLast7Days)} signed in this week` : !overview.isLoading ? 'Not available' : '…'}</span>
          </div>
          <div className="ap-card ap-stat">
            <span className="ap-k">Active sessions</span>
            <span className="ap-v">{n(o?.sessions.active)}</span>
            <span className="ap-d">{o ? `${n(o.sessions.platformAdminSessionsToday)} platform-admin sessions today` : !overview.isLoading ? 'Not available' : '…'}</span>
          </div>
        </div>
      </section>

      <section className="ap-block" aria-label="Look up">
        <div className="ap-block-head">
          <h2 className="ap-h2">Look up</h2>
          <p className="ap-sub">Find a user or an organisation across the whole platform. Results show IDs, roles and status only. Searches are recorded in the audit log.</p>
        </div>
        <form className="ap-row" onSubmit={search} role="search">
          <div className="ap-seg" role="group" aria-label="Look up type">
            <button type="button" aria-pressed={mode === 'user'} onClick={() => { setMode('user'); setQuery(''); setInput(''); setResetDone(null); }}>User</button>
            <button type="button" aria-pressed={mode === 'org'} onClick={() => { setMode('org'); setQuery(''); setInput(''); setResetDone(null); }}>Organisation</button>
          </div>
          <input
            ref={inputRef}
            className="ap-input ap-grow"
            type="search"
            aria-label="Search"
            placeholder={mode === 'user' ? 'Email, name or user ID' : 'Organisation name, slug or ID'}
            value={input}
            maxLength={200}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="ap-btn ap-primary" type="submit">Search</button>
        </form>

        {mode === 'user' && (
          <>
            {resetDone && (
              <p className="ap-callout ap-success">
                <IconCheck size={16} aria-hidden="true" />
                Two-factor authentication was reset for {resetDone.name}. {resetDone.revokedSessions} session{resetDone.revokedSessions === 1 ? ' was' : 's were'} ended.
              </p>
            )}
            {shownUser && (
              <UserResultCard
                key={shownUser.id}
                user={shownUser}
                meId={meId}
                onReset={(r) => setResetDone({ userId: shownUser.id, ...r })}
              />
            )}
            <UserSecurityTable
              users={userResults}
              loading={users.isLoading}
              error={users.isError}
              role={role}
              onRole={setRole}
              meId={meId}
              selectedId={shownUser?.id ?? null}
              onSelect={(u) => {
                setSelectedUser(u);
                if (resetDone && resetDone.userId !== u.id) setResetDone(null);
              }}
              onReset={(u) => {
                setResetDone(null);
                setResetFor(u);
              }}
            />
          </>
        )}

        {mode === 'org' && (
          <>
            {shownOrg && <OrganisationResultCard key={shownOrg.id} org={shownOrg} />}
            <div className="ap-tablewrap">
              <table className="ap-table">
                <thead><tr><th>Organisation</th><th>Slug</th><th>Status</th><th>CEO</th><th>Created</th></tr></thead>
                <tbody>
                  {orgs.isLoading ? (
                    <tr><td colSpan={5} className="ap-empty">Loading…</td></tr>
                  ) : orgs.isError ? (
                    <tr><td colSpan={5} className="ap-empty">Organisations could not be loaded.</td></tr>
                  ) : !orgResults?.length ? (
                    <tr><td colSpan={5} className="ap-empty">No organisations match this search.</td></tr>
                  ) : (
                    orgResults.map((org) => (
                      <tr key={org.id} data-selected={shownOrg?.id === org.id || undefined}>
                        <td><button type="button" className="ap-btn ap-sm" onClick={() => setSelectedOrg(org)} aria-label={`Show ${org.name}`}>{org.name}</button></td>
                        <td className="ap-mono">{org.slug}</td>
                        <td>{org.suspended ? <span className="ap-pill ap-bad">Suspended</span> : <span className="ap-pill ap-ok">Active</span>}</td>
                        <td className="ap-muted">{org.ceo ? `${org.ceo.name || org.ceo.email}${org.ceo.activated ? '' : ' (not activated)'}` : '—'}</td>
                        <td className="ap-muted">{formatDate(org.createdAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <PlatformAdminsTable
        admins={admins.data}
        total={o?.platformAdmins?.active}
        loading={admins.isLoading}
        error={admins.isError}
        onAdd={() => {
          setMode('user');
          inputRef.current?.focus();
          toast.info('Find the user first, then choose “Make platform admin” on their card.');
        }}
      />

      <section className="ap-block" aria-label="Recent users">
        <h2 className="ap-h2">Recent users</h2>
        <div className="ap-tablewrap">
          <table className="ap-table ap-narrow">
            <thead><tr><th>User</th><th>Organisation</th><th>Joined</th></tr></thead>
            <tbody>
              {recent.isLoading ? (
                <tr><td colSpan={3} className="ap-empty">Loading…</td></tr>
              ) : recent.isError ? (
                <tr><td colSpan={3} className="ap-empty">Recent users could not be loaded.</td></tr>
              ) : !Array.isArray(recent.data) || !recent.data.length ? (
                <tr><td colSpan={3} className="ap-empty">No users yet.</td></tr>
              ) : (
                recent.data.map((u) => (
                  <tr key={u.id}>
                    <td>{fullName(u)}</td>
                    <td>{u.organisationName ?? '—'}</td>
                    <td>{formatDate(u.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {resetFor && (
        <ResetTwoFactorDialog
          userId={resetFor.id}
          userLabel={fullName(resetFor)}
          onClose={() => setResetFor(null)}
          onDone={(r) => setResetDone({ userId: resetFor.id, name: fullName(resetFor), revokedSessions: r.revokedSessions })}
        />
      )}
    </>
  );
}

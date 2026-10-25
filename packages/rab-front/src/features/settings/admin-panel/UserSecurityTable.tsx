import { IconDeviceMobile, IconInfoCircle, IconKey, IconShieldCheck } from '@tabler/icons-react';

import { formatDate, fullName, initials, ROLE_FILTERS, roleLabel, type AdminUser } from './adminPanelApi';
import { resetBlockedReason } from './UserResultCard';

/**
 * "User security" — the owner's account-security design (docs/design/crewflow-account-security.html, admin()), placed
 * under General → Look up → User. Columns User | Organisation | Role | Two-factor | Enabled | Recovery codes | Actions.
 * The design's Staff / Venue managers tabs become a role filter; rows come from `GET /admin/users/search` (the
 * admin_search_users function's fixed columns: 2FA on/off, enabled date, recovery-code counts — never a secret).
 * The three summary cards are static explanatory copy (owner-approved).
 */
export default function UserSecurityTable({
  users,
  loading,
  error,
  role,
  onRole,
  meId,
  selectedId,
  onSelect,
  onReset,
}: {
  users: AdminUser[] | undefined;
  loading: boolean;
  error: boolean;
  role: string;
  onRole: (role: string) => void;
  meId?: string;
  selectedId: string | null;
  onSelect: (u: AdminUser) => void;
  onReset: (u: AdminUser) => void;
}) {
  const roleText = ROLE_FILTERS.find((r) => r.value === role)?.label ?? 'All roles';
  const count = users?.length ?? 0;
  return (
    <section className="ap-block" aria-label="User security">
      <div className="ap-block-head">
        <h3 className="ap-h3">User security</h3>
        <p className="ap-sub">Two-factor status for each account. 2FA is optional for every role; enabled factors are verified on every platform.</p>
      </div>
      <div className="ap-sec-summary">
        <div className="ap-card">
          <span className="ap-sec-icon" aria-hidden="true"><IconShieldCheck size={18} /></span>
          <div><h3>Available to every role</h3><p>Two-factor setup is optional.</p></div>
        </div>
        <div className="ap-card">
          <span className="ap-sec-icon" aria-hidden="true"><IconDeviceMobile size={18} /></span>
          <div><h3>Verified on every platform</h3><p>Once enabled, codes are required at sign-in.</p></div>
        </div>
        <div className="ap-card">
          <span className="ap-sec-icon" aria-hidden="true"><IconKey size={18} /></span>
          <div><h3>Secure account recovery</h3><p>Admin resets require identity verification.</p></div>
        </div>
      </div>
      <div className="ap-tablewrap">
        <div className="ap-row" style={{ justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--border-light)' }}>
          <select className="ap-input" aria-label="Filter by role" value={role} onChange={(e) => onRole(e.target.value)}>
            {ROLE_FILTERS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <span className="ap-muted" style={{ font: 'var(--text-small)' }}>{roleText} · {loading ? '…' : `${count} user${count === 1 ? '' : 's'}`}</span>
        </div>
        <table className="ap-table">
          <thead>
            <tr><th>User</th><th>Organisation</th><th>Role</th><th>Two-factor</th><th>Enabled</th><th>Recovery codes</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="ap-empty">Loading users…</td></tr>
            ) : error ? (
              <tr><td colSpan={7} className="ap-empty">Users could not be loaded. Try again.</td></tr>
            ) : count === 0 ? (
              <tr><td colSpan={7} className="ap-empty">No users match this search.</td></tr>
            ) : (
              users!.map((u) => {
                const name = fullName(u);
                const blocked = resetBlockedReason(u, meId);
                return (
                  <tr key={u.id} data-selected={selectedId === u.id || undefined}>
                    <td>
                      <button type="button" className="ap-who" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit' }} onClick={() => onSelect(u)} aria-label={`Show ${name}`}>
                        <span className="ap-avatar ap-avatar-sm" aria-hidden="true">{initials(name)}</span>
                        <span style={{ minWidth: 0 }}>
                          <strong>{name}{meId === u.id ? ' (you)' : ''}</strong>
                          <span className="ap-muted" style={{ display: 'block', font: 'var(--text-small)' }}>{u.email}</span>
                        </span>
                      </button>
                    </td>
                    <td className="ap-muted">{u.organisationName ?? '—'}</td>
                    <td className="ap-muted">{u.isPlatformAdmin ? `${roleLabel(u)} · Platform admin` : roleLabel(u)}</td>
                    <td>{u.twoFactor.enabled ? <span className="ap-pill ap-ok">On</span> : <span className="ap-pill">Off</span>}</td>
                    <td className="ap-muted">{u.twoFactor.enabled ? formatDate(u.twoFactor.enabledAt) : '—'}</td>
                    <td className="ap-muted">{u.twoFactor.enabled && u.twoFactor.recoveryCodesTotal ? `${u.twoFactor.recoveryCodesRemaining ?? 0} of ${u.twoFactor.recoveryCodesTotal}` : '—'}</td>
                    <td>
                      <button type="button" className="ap-btn ap-sm" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => onReset(u)} aria-label={`Reset 2FA for ${name}`}>
                        Reset 2FA
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <div className="ap-table-foot">
          <span>{count} user{count === 1 ? '' : 's'}</span>
          <span>A reset signs the user out on all devices.</span>
        </div>
      </div>
      <p className="ap-footnote"><IconInfoCircle size={14} aria-hidden="true" />Use a reset only when a user can’t access their authenticator or recovery codes.</p>
    </section>
  );
}

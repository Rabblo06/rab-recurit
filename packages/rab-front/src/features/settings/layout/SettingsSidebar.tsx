import { NavLink } from 'react-router-dom';
import {
  IconUserCircle, IconAdjustmentsHorizontal, IconKey,
  IconBuilding, IconWorld, IconUsersGroup, IconShieldLock, IconLogout,
} from '@tabler/icons-react';

const userNav = [
  { to: '/settings/profile', label: 'Profile', Icon: IconUserCircle },
  { to: '/settings/experience', label: 'Experience', Icon: IconAdjustmentsHorizontal },
  { to: '/settings/account', label: 'Account', Icon: IconKey },
];

const workspaceNav = [
  { to: '/settings/my-workspace', label: 'General', Icon: IconBuilding },
  { to: '/settings/my-workspace/domains', label: 'Domains', Icon: IconWorld },
  { to: '/settings/workspace/members', label: 'Members', Icon: IconUsersGroup },
];

export default function SettingsSidebar({
  isPlatformAdmin,
  isPlatformAdminOnly,
  onLogoutClick,
  compact = false,
}: {
  isPlatformAdmin: boolean;
  /** A platform admin with no operational org role owns no workspace at all (General/Domains/
   * Roles/Security are all meaningless for it) — mirrors `Layout.tsx`'s own sidebar gating. */
  isPlatformAdminOnly: boolean;
  onLogoutClick: () => void;
  compact?: boolean;
}) {
  return (
    <aside className={compact ? 'settings-mode-navigation' : 'settings-shell-sidebar'} aria-label="Settings navigation">
      <div className="sidebar-section">
        <p className="sidebar-section-label">Your account</p>
        <nav className="sidebar-nav">
          {userNav.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} title={label} aria-label={label} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <Icon size={16} stroke={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      {!isPlatformAdminOnly && (
        <div className="sidebar-section">
          <p className="sidebar-section-label">Workspace</p>
          <nav className="sidebar-nav">
            {workspaceNav.map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} title={label} aria-label={label} end={to === '/settings/my-workspace'} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
                <Icon size={16} stroke={1.8} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      )}

      <div className="sidebar-section">
        <p className="sidebar-section-label">Other</p>
        <nav className="sidebar-nav">
          {isPlatformAdmin && (
            <NavLink to="/settings/admin" title="Admin Panel" aria-label="Admin Panel" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <IconShieldLock size={16} stroke={1.8} />
              <span>Admin Panel</span>
            </NavLink>
          )}
          <button type="button" className="nav-item" title="Log out" aria-label="Log out" style={{ width: '100%', border: 'none', background: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={onLogoutClick}>
            <IconLogout size={16} stroke={1.8} />
            <span>Log out</span>
          </button>
        </nav>
      </div>
    </aside>
  );
}

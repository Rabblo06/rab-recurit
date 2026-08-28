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
  { to: '/settings/workspace/roles', label: 'Roles', Icon: IconUsersGroup },
];

export default function SettingsSidebar({
  isPlatformAdmin,
  onLogoutClick,
}: {
  isPlatformAdmin: boolean;
  onLogoutClick: () => void;
}) {
  return (
    <aside className="settings-shell-sidebar">
      <div className="sidebar-section">
        <p className="sidebar-section-label">User</p>
        <nav className="sidebar-nav">
          {userNav.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <Icon size={16} stroke={1.8} />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="sidebar-section">
        <p className="sidebar-section-label">Workspace</p>
        <nav className="sidebar-nav">
          {workspaceNav.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} end={to === '/settings/my-workspace'} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <Icon size={16} stroke={1.8} />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="sidebar-section">
        <p className="sidebar-section-label">Other</p>
        <nav className="sidebar-nav">
          {isPlatformAdmin && (
            <NavLink to="/settings/admin" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <IconShieldLock size={16} stroke={1.8} />
              Admin Panel
            </NavLink>
          )}
          <button type="button" className="nav-item" style={{ width: '100%', border: 'none', background: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={onLogoutClick}>
            <IconLogout size={16} stroke={1.8} />
            Logout
          </button>
        </nav>
      </div>
    </aside>
  );
}

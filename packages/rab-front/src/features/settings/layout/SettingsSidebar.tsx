import { NavLink } from 'react-router-dom';
import type { Icon as TablerIcon } from '@tabler/icons-react';
import { LayoutGroup, motion } from 'framer-motion';
import { spring, usePrefersReducedMotion } from '../../../shared/motion';
import { useLeadershipCapabilities } from '../members/leadershipCapabilities';
import {
  IconUserCircle, IconAdjustmentsHorizontal, IconKey,
  IconBuilding, IconWorld, IconUsersGroup, IconShieldLock, IconShieldCheck, IconLogout,
} from '@tabler/icons-react';

const userNav = [
  { to: '/settings/profile', label: 'Profile', Icon: IconUserCircle },
  { to: '/settings/experience', label: 'Experience', Icon: IconAdjustmentsHorizontal },
  { to: '/settings/account', label: 'Account', Icon: IconKey },
  { to: '/settings/security', label: 'Security', Icon: IconShieldCheck },
];

const workspaceNav = [
  { to: '/settings/my-workspace', label: 'General', Icon: IconBuilding },
  { to: '/settings/my-workspace/domains', label: 'Domains', Icon: IconWorld },
  { to: '/settings/workspace/members', label: 'Members', Icon: IconUsersGroup },
];

/**
 * One Settings destination. Active state comes from React Router (`NavLink` → `aria-current="page"`, works for direct
 * URLs, reloads and Back/Forward). The white rounded highlight is the same `nav-active-pill` the Home navigation uses:
 * one shared `layoutId`, so it slides between rows (interruptible spring, never delays navigation) and there is only
 * ever one. Reduced motion: it jumps (duration 0).
 */
function SettingsLink({ to, label, Icon, end }: { to: string; label: string; Icon: TablerIcon; end?: boolean }) {
  // Framer's MotionConfig does not stop shared-layout moves (and paints one frame at the old row), so reduced motion
  // renders a plain, non-shared highlight instead.
  const reduce = usePrefersReducedMotion();
  return (
    <NavLink to={to} title={label} aria-label={label} end={end} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
      {({ isActive }) => <>
        {isActive && (reduce
          ? <span className="nav-active-pill" aria-hidden="true" />
          : <motion.span layoutId="settings-active-pill" className="nav-active-pill" aria-hidden="true" transition={spring} />)}
        <Icon size={16} stroke={1.8} />
        <span>{label}</span>
      </>}
    </NavLink>
  );
}

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
  const { canAdd } = useLeadershipCapabilities(isPlatformAdminOnly);
  return (
    <LayoutGroup id="settings-navigation">
    <aside className={compact ? 'settings-mode-navigation' : 'settings-shell-sidebar'} aria-label="Settings navigation">
      <div className="sidebar-section">
        <p className="sidebar-section-label">Your account</p>
        <nav className="sidebar-nav">
          {userNav.map(({ to, label, Icon }) => <SettingsLink key={to} to={to} label={label} Icon={Icon} />)}
        </nav>
      </div>

      {(!isPlatformAdminOnly || canAdd) && (
        <div className="sidebar-section">
          <p className="sidebar-section-label">Workspace</p>
          <nav className="sidebar-nav">
            {workspaceNav.filter((item) => !isPlatformAdminOnly || item.label === 'Members').map(({ to, label, Icon }) => (
              // `end` on General: /settings/my-workspace must not also light up on /settings/my-workspace/domains.
              <SettingsLink key={to} to={isPlatformAdminOnly ? `${to}?tab=add` : to} label={label} Icon={Icon} end={to === '/settings/my-workspace'} />
            ))}
          </nav>
        </div>
      )}

      <div className="sidebar-section">
        <p className="sidebar-section-label">Other</p>
        <nav className="sidebar-nav">
          {isPlatformAdmin && (
            <SettingsLink to="/settings/admin" label="Admin Panel" Icon={IconShieldLock} />
          )}
          <button type="button" className="nav-item" title="Log out" aria-label="Log out" style={{ width: '100%', border: 'none', background: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={onLogoutClick}>
            <IconLogout size={16} stroke={1.8} />
            <span>Log out</span>
          </button>
        </nav>
      </div>
    </aside>
    </LayoutGroup>
  );
}

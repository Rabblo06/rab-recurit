import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  IconSettings, IconChevronDown,
  IconChartPie, IconUsers, IconBuildingSkyscraper, IconChecklist,
  IconCalendarMonth, IconCash, IconMapPin, IconHistory,
  IconDotsVertical, IconMail,
} from '@tabler/icons-react';
import AdminDropdown from './AdminDropdown';
import GlobalSearch from './GlobalSearch';
import CommandPalette from './CommandPalette';
import ToastHost from './ToastHost';
import TimelinePanel from '../features/audit/TimelinePanel';
import CreateUserModal from '../features/users/CreateUserModal';
import UserDetailPanel from '../features/users/UserDetailPanel';
import ShiftDrawers from '../features/scheduling/ShiftDrawers';
import CreateVenueDrawer from '../features/venues/CreateVenueDrawer';
import BatchOfferDrawer from '../features/offers/BatchOfferDrawer';
import NotificationBell from '../features/notifications/NotificationBell';
import Avatar from '../shared/components/Avatar';
import { useCurrentProfile } from '../shared/hooks/useCurrentProfile';

const workspaceNav = [
  { to: '/',           label: 'Dashboard',  Icon: IconChartPie, end: true },
  { to: '/users',      label: 'Users',       Icon: IconUsers },
  { to: '/shifts',     label: 'Shifts',      Icon: IconBuildingSkyscraper },
  { to: '/offers',     label: 'Offers',      Icon: IconChecklist },
  { to: '/calendar',   label: 'Calendar',    Icon: IconCalendarMonth },
];

const adminNav = [
  { to: '/payroll',    label: 'Payroll',     Icon: IconCash },
  { to: '/venues',     label: 'Venues',      Icon: IconMapPin },
];

const otherNav = [
  { to: '/audit',      label: 'Audit Log',   Icon: IconHistory },
  { to: '/settings',   label: 'Settings',    Icon: IconSettings },
];

const pageVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { ease: 'linear', duration: 0.25 } },
  exit:    { opacity: 0,       transition: { ease: 'linear', duration: 0.15 } },
};

export default function Layout() {
  const location = useLocation();
  const { data: profile } = useCurrentProfile();
  const displayName = profile?.firstName || 'Account';
  const isUserProfile = location.pathname.startsWith('/users/') && location.pathname !== '/users';

  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  // Ctrl+K / Cmd+K opens the command palette; "/" opens global search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette(v => !v);
        return;
      }
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const openSearch = useCallback(() => setShowSearch(true), []);
  const openTimeline = useCallback(() => setShowTimeline(true), []);

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="sidebar-profile" onClick={() => setShowAdminMenu(v => !v)}>
            <Avatar imageKey={profile?.avatarKey} label={displayName} variant="sidebar" alt={displayName} />
            <span className="sidebar-profile-name">{displayName}</span>
            <IconChevronDown size={14} color="var(--font-tertiary)"/>
          </button>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-section-label">Workspace</p>
          <nav className="sidebar-nav">
            {workspaceNav.map(({ to, label, Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
              >
                <Icon size={16} stroke={1.8}/>
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-section-label">Admin</p>
          <nav className="sidebar-nav">
            {adminNav.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
              >
                <Icon size={16} stroke={1.8}/>
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-section-label">Other</p>
          <nav className="sidebar-nav">
            {otherNav.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
              >
                <Icon size={16} stroke={1.8}/>
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

      </aside>

      <div className="main-content">
        <div className="topbar">
          <div className="topbar-spacer"/>
          <div className="topbar-actions">
            {isUserProfile && (
              <button className="btn btn-outline" style={{ gap: 6 }} onClick={() => document.dispatchEvent(new CustomEvent('trigger-send-email'))}>
                <IconMail size={14}/>
                Send Email
              </button>
            )}
            <NotificationBell/>
            <button className="btn-icon" title="More (Ctrl K) — search, timeline, and other commands live here" onClick={() => setShowPalette(true)}>
              <IconDotsVertical size={16} stroke={1.8}/>
            </button>
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            <Outlet/>
          </motion.div>
        </AnimatePresence>
      </div>

      <AdminDropdown open={showAdminMenu} onClose={() => setShowAdminMenu(false)}/>
      <GlobalSearch open={showSearch} onClose={() => setShowSearch(false)}/>
      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        onOpenSearch={openSearch}
        onOpenTimeline={openTimeline}
      />
      <TimelinePanel open={showTimeline} onClose={() => setShowTimeline(false)}/>
      <CreateUserModal/>
      <UserDetailPanel/>
      <ShiftDrawers/>
      <CreateVenueDrawer/>
      <BatchOfferDrawer/>
      <ToastHost/>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  IconSearch, IconSettings, IconChevronDown,
  IconChartPie, IconUsers, IconBuildingSkyscraper, IconChecklist,
  IconCalendarMonth, IconCash, IconMapPin, IconHistory,
  IconPlus, IconTimelineEvent, IconDotsVertical, IconMail,
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

const pages: Record<string, { title: string; Icon: any; create?: string }> = {
  '/':           { title: 'Dashboard',  Icon: IconChartPie },
  '/users':      { title: 'Users',      Icon: IconUsers },
  '/shifts':     { title: 'Shifts',     Icon: IconBuildingSkyscraper, create: 'open-create-placement' },
  '/offers':     { title: 'Offers',     Icon: IconChecklist },
  '/calendar':   { title: 'Calendar',   Icon: IconCalendarMonth },
  '/payroll':    { title: 'Payroll',    Icon: IconCash },
  '/venues':     { title: 'Venues',     Icon: IconMapPin, create: 'open-create-venue' },
  '/audit':      { title: 'Audit Log',  Icon: IconHistory },
  '/settings':   { title: 'Settings',   Icon: IconSettings },
};

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
  const isSettings = location.pathname.startsWith('/settings');
  const page = pages[location.pathname]
    ?? (isUserProfile ? { title: 'Users', Icon: IconUsers } : undefined)
    ?? (isSettings ? { title: 'Settings', Icon: IconSettings } : undefined)
    ?? { title: 'rab', Icon: IconChartPie };
  const PageIcon = page.Icon;

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
          <div className="sidebar-workspace" onClick={() => setShowAdminMenu(v => !v)}>
            <Avatar imageKey={profile?.avatarKey} label={displayName} variant="sidebar" alt={displayName} />
            {displayName}
            <IconChevronDown size={14} color="#999" style={{ marginLeft: 'auto' }}/>
          </div>
        </div>

        <div className="sidebar-search" onClick={openSearch}>
          <IconSearch size={16}/>
          Search
          <kbd>⌘K</kbd>
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
          <div className="topbar-tab">
            <PageIcon size={15} stroke={1.8}/>
            {page.title}
          </div>
          <div className="topbar-spacer"/>
          <div className="topbar-actions">
            {page.create && (
              <button className="btn btn-outline" onClick={() => document.dispatchEvent(new CustomEvent(page.create!))}>
                <IconPlus size={14}/>
                New <span style={{ color: 'var(--font-tertiary)' }}>{page.title.replace(/s$/, '')}</span>
              </button>
            )}
            {isUserProfile && (
              <button className="btn btn-outline" style={{ gap: 6 }} onClick={() => document.dispatchEvent(new CustomEvent('trigger-send-email'))}>
                <IconMail size={14}/>
                Send Email
              </button>
            )}
            <button className="btn btn-outline" onClick={openTimeline}>
              <IconTimelineEvent size={14}/>
              Timeline Activities
            </button>
            <NotificationBell/>
            <button className="btn btn-outline" style={{ gap: 8 }} onClick={() => setShowPalette(true)}>
              <IconDotsVertical size={14}/>
              <span style={{ width: 1, height: 14, background: 'var(--border-medium)' }}/>
              <span className="topbar-kbd">Ctrl K</span>
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

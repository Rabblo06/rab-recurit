import { useState, useEffect, useCallback, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { api } from '../shared/api';
import WelcomeOverlay from '../features/onboarding/WelcomeOverlay';
import type { WelcomeRole } from '../features/onboarding/WelcomeOverlay';
import { hasPendingWelcome, clearPendingWelcome } from '../features/onboarding/onboardingMotion';
import {
  IconSettings, IconChevronDown,
  IconChartPie, IconUsers, IconBuildingSkyscraper, IconChecklist,
  IconCalendarMonth, IconCash, IconMapPin, IconHistory,
  IconDotsVertical, IconMail, IconSend2,
  IconSearch, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconMenu2, IconBell, IconArrowRight, IconX, IconLayoutGrid, IconCalendarCheck, IconSparkles, IconLayoutSidebarRightExpand, IconPencilPlus,
} from '@tabler/icons-react';
import AdminDropdown from './AdminDropdown';
import GlobalSearch from './GlobalSearch';
import CommandPalette from './CommandPalette';
import ToastHost from './ToastHost';
import TimelinePanel from '../features/audit/TimelinePanel';
import CreateUserModal from '../features/users/CreateUserModal';
import UserDetailPanel from '../features/users/UserDetailPanel';
import BulkEmailPanel from '../features/users/BulkEmailPanel';
import ShiftDrawers from '../features/scheduling/ShiftDrawers';
import CreateVenueDrawer from '../features/venues/CreateVenueDrawer';
import BatchOfferDrawer from '../features/offers/BatchOfferDrawer';
import OfferDecisionDrawers from '../features/offers/OfferDecisionDrawers';
import ShiftApprovalDrawer from '../features/scheduling/ShiftApprovalDrawer';
import ShiftRequestDrawer from '../features/scheduling/ShiftRequestDrawer';
import NotificationBell from '../features/notifications/NotificationBell';
import Avatar from '../shared/components/Avatar';
import { useCurrentProfile } from '../shared/hooks/useCurrentProfile';
import { useRealtimeStatus } from '../shared/lib/RealtimeProvider';
import { useMyWorkspace } from '../shared/hooks/useMyWorkspace';
import { AiChatProvider, useAiChat } from '../features/ai/AiChatProvider';
import AiChatNavigation from '../features/ai/AiChatNavigation';
import AskAiPanel from '../features/ai/AskAiPanel';
import SettingsSidebar from '../features/settings/layout/SettingsSidebar';
import LogoutDialog from '../features/settings/LogoutDialog';
import NavigationModes, { navigationMode, type NavigationMode } from './NavigationModes';
import './sidebar-motion.css';
import '../features/ai/ai-chat.css';

const workspaceNav = [
  { to: '/',           label: 'Dashboard',  Icon: IconLayoutGrid, end: true },
  { to: '/users',      label: 'Users',       Icon: IconUsers },
  { to: '/shifts',     label: 'Shifts',      Icon: IconCalendarCheck },
  { to: '/offers',     label: 'Offers',      Icon: IconMail },
  { to: '/calendar',   label: 'Calendar',    Icon: IconCalendarMonth },
];

const adminNav = [
  { to: '/payroll',    label: 'Payroll',     Icon: IconCash },
  { to: '/venues',     label: 'Venues',      Icon: IconMapPin },
];

// Retain breadcrumb metadata for pages that are not listed in the sidebar.
const additionalPages = [
  { to: '/venue-offers', label: 'Venue Offers', Icon: IconSend2 },
  { to: '/audit',      label: 'Audit Log',   Icon: IconHistory },
  { to: '/settings',   label: 'Settings',    Icon: IconSettings },
];

export default function Layout() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<{ roles: string[] }>('/auth/me')).data, staleTime: 5 * 60 * 1000 });
  const { data: workspace } = useMyWorkspace({ enabled: !!me?.roles.some(role => ['manager', 'ceo'].includes(role)) });
  // Synchronous remount fences every draft on account/session/workspace changes.
  return <AiChatProvider workspaceId={workspace?.id}><LayoutContent /></AiChatProvider>;
}

function LayoutContent() {
  const location = useLocation();
  const navigate = useNavigate();
  const chat = useAiChat();
  const mode = navigationMode(location.pathname);
  const previousMode = useRef(mode);
  const lastHome = useRef('/');
  const [mobile, setMobile] = useState(() => window.innerWidth <= 760);
  const [showLogout, setShowLogout] = useState(false);
  const workspaceTrigger = useRef<HTMLButtonElement>(null);
  const workspaceContent = useRef<HTMLDivElement>(null);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const modeOrder = { home: 0, ai: 1, settings: 2 };
  const modeDirection = modeOrder[mode] >= modeOrder[previousMode.current] ? 1 : -1;
  useEffect(() => {
    if (mode === 'home') lastHome.current = location.pathname + location.search;
    if (previousMode.current === 'ai' && mode === 'home' && chat.current.text.trim() && window.innerWidth > 1000) chat.setPanelOpen(true);
    previousMode.current = mode;
  }, [mode, location.pathname, location.search, chat.current.text, chat.setPanelOpen]);
  useEffect(() => {
    const resize = () => { setMobile(window.innerWidth <= 760); if (window.innerWidth <= 1000 && chat.panelOpen) { chat.setPanelOpen(false); navigate('/chat'); } };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [chat.panelOpen, chat.setPanelOpen, navigate]);
  function openChatPage() {
    if (mode !== 'ai') chat.setReturnTo(location.pathname + location.search);
    chat.setPanelOpen(false); navigate('/chat');
  }
  function selectMode(next: NavigationMode) {
    if (next === mode) return;
    if (next === 'ai') openChatPage();
    else navigate(next === 'settings' ? '/settings/profile' : isPlatformAdminOnly ? '/settings/admin' : lastHome.current);
  }
  function openAskAi() {
    // Business drawers retain their own unsaved-change guards and focus ownership.
    const existing = document.querySelector<HTMLElement>('.side-panel-dock:not(.ai-panel-dock)');
    if (existing) { existing.querySelector<HTMLElement>('input,button,textarea')?.focus(); return; }
    chat.setReturnTo(location.pathname + location.search);
    if (window.innerWidth <= 1000) openChatPage(); else chat.setPanelOpen(true);
  }
  function continueInPanel() {
    chat.setPanelOpen(window.innerWidth > 1000);
    navigate(chat.returnTo === '/chat' ? '/' : chat.returnTo);
  }
  useEffect(() => {
    const open = (e: Event) => { const id = (e as CustomEvent).detail?.shiftId; if (id) navigate(`/venue-offers/${id}`); };
    document.addEventListener('open-venue-pipeline', open);
    return () => document.removeEventListener('open-venue-pipeline', open);
  }, [navigate]);
  const { data: profile } = useCurrentProfile();
  const displayName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || 'Account';
  const isUserProfile = location.pathname.startsWith('/users/') && location.pathname !== '/users';
  const realtimeStatus = useRealtimeStatus();

  // Same `['me']` query key `OnboardingGate` (one level up in the tree) already populated with a
  // 5-minute staleTime before `Layout` ever mounts — this reuses that cache entry rather than
  // issuing a second request.
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<{ roles: string[]; isPlatformAdmin: boolean }>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });
  // Same "no operational role" case `OnboardingGate` (App.tsx) already redirects away from these
  // routes for — this account only reaches `Layout` via `/settings/*` or the UI-only `/chat`, but the sidebar
  // itself still renders once (Settings' own layout nests under this shell), so it must not offer
  // links into pages the redirect would immediately bounce it back out of.
  const isPlatformAdminOnly = Boolean(me?.isPlatformAdmin) && (me?.roles.length ?? 0) === 0;
  const { data: workspace } = useMyWorkspace({ enabled: !!me && me.roles.some(role => ['manager', 'ceo'].includes(role)) });
  const workspaceName = workspace?.name || 'Crewflow';
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const reducedMotion = useReducedMotion();
  const { data: unread } = useQuery({ queryKey: ['notifications', 'unread-count'], queryFn: async () => (await api.get<{ count: number }>('/notifications/unread-count')).data });
  const activePage = [...workspaceNav, ...adminNav, ...additionalPages].find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to));
  const PageIcon = activePage?.Icon || IconUsers;
  const openNotifications = () => document.dispatchEvent(new CustomEvent('open-notifications'));
  useEffect(() => { setMobileNav(false); setWorkspaceMenu(false); }, [location.pathname]);
  useEffect(() => {
    if (workspaceMenu) workspaceContent.current?.querySelector<HTMLElement>('button')?.focus();
  }, [workspaceMenu]);
  useEffect(() => {
    if (sidebarRef.current) sidebarRef.current.inert = mobile && !mobileNav;
    if (mobileNav) sidebarRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [mobile, mobileNav]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && workspaceMenu) { event.preventDefault(); setWorkspaceMenu(false); workspaceTrigger.current?.focus(); }
      else if (event.key === 'Escape' && mobileNav) { event.preventDefault(); setMobileNav(false); mobileTrigger.current?.focus(); }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [workspaceMenu, mobileNav]);
  // Read once, synchronously, so a genuinely-just-activated CEO/Super-Admin never sees even one
  // frame of the dashboard before the welcome overlay — but only ever consumed (removed) once we
  // actually know which role's copy to show, below, not here, so a slow `/auth/me` response
  // can't silently swallow the flag before role is known.
  const [pendingWelcome] = useState(() => hasPendingWelcome());
  const welcomeRole: WelcomeRole | null = !pendingWelcome || !me
    ? null
    : me.isPlatformAdmin ? 'platform_admin' : me.roles.includes('ceo') ? 'ceo' : null;
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);

  useEffect(() => {
    // Not "welcomeRole !== null" — a Staff/Venue-Manager activation also sets the flag (set
    // unconditionally in `ActivateAccount.tsx`, before any role is known) but has no welcome copy
    // of its own here, so the flag must still be cleared the first time we have a real answer,
    // or it would linger and misfire if that same browser session later also holds a CEO/admin
    // account via account switching.
    if (!me) return;
    clearPendingWelcome();
  }, [me]);

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
    <div className={`app-layout mode-${mode}${collapsed && !mobile ? ' sidebar-collapsed' : ''}${mobileNav ? ' mobile-nav-open' : ''}`}>
      {welcomeRole && !welcomeDismissed && (
        <WelcomeOverlay
          role={welcomeRole}
          firstName={profile?.firstName}
          avatarKey={profile?.avatarKey}
          onDone={() => setWelcomeDismissed(true)}
        />
      )}
      {mobileNav && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => { setMobileNav(false); mobileTrigger.current?.focus(); }} />}
      <aside className="sidebar" ref={sidebarRef} aria-label="Main navigation" onKeyDown={event => {
        if (!mobileNav || event.key !== 'Tab') return;
        const controls = [...(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? [])].filter(el => el.offsetParent !== null);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <div className="sidebar-top">
          <button ref={workspaceTrigger} className="sidebar-profile" aria-label="Workspace menu" title={workspaceName} aria-expanded={workspaceMenu} onClick={() => setWorkspaceMenu(v => !v)}>
            <Avatar imageKey={workspace?.logoKey} label={workspaceName} variant="sidebar" alt={workspaceName} />
            <span className="sidebar-profile-name">{workspaceName}</span>
            <IconChevronDown size={12}/>
          </button>
          <button className="btn-icon sidebar-search" aria-label="Search workspace" title="Search workspace (/)" onClick={openSearch}><IconSearch size={16}/></button>
          <button className="btn-icon sidebar-collapse" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed(v => !v)}>{collapsed ? <IconLayoutSidebarLeftExpand size={16}/> : <IconLayoutSidebarLeftCollapse size={16}/>}</button>
          <button className="btn-icon sidebar-mobile-close" aria-label="Close navigation" onClick={() => setMobileNav(false)}><IconX size={18}/></button>
          {workspaceMenu && <>
            <button className="workspace-menu-dismiss" tabIndex={-1} aria-label="Close workspace menu" onClick={() => { setWorkspaceMenu(false); workspaceTrigger.current?.focus(); }}/>
            <div ref={workspaceContent} className="workspace-menu dropdown-menu">
              <div className="dropdown-label">Current workspace</div>
              <div className="workspace-menu-current">{workspaceName}</div>
              <button className="dropdown-item" onClick={() => { setWorkspaceMenu(false); navigate(workspace ? '/settings/my-workspace' : '/settings/profile'); }}><IconSettings size={16}/>Workspace settings</button>
            </div>
          </>}
        </div>
        <NavigationModes mode={mode} expanded={!collapsed || mobile} onSelect={selectMode}/>

        <motion.div className="sidebar-mode-content" key={mode} initial={reducedMotion || previousMode.current === mode ? false : { opacity: 0, x: modeDirection * (document.documentElement.dir === 'rtl' ? -8 : 8) }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reducedMotion ? 0 : .18, ease: [.2, .8, .2, 1] }}>
        {mode === 'ai' ? <AiChatNavigation /> : mode === 'settings' ? <SettingsSidebar compact isPlatformAdmin={!!me?.isPlatformAdmin} isPlatformAdminOnly={isPlatformAdminOnly} onLogoutClick={() => setShowLogout(true)}/> : !isPlatformAdminOnly && (
          <div className="sidebar-section">
            <p className="sidebar-section-label">Workspace</p>
            <nav className="sidebar-nav">
              {[...workspaceNav, ...adminNav].map(({ to, label, Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  title={label}
                  aria-label={label}
                  className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
                >
                  <Icon size={16} stroke={1.8}/>
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>
          </div>
        )}
        </motion.div>

        <div className="sidebar-footer">
          {mode === 'home' && <div className="sidebar-priority">
            <div className="sidebar-priority-label">Priority <IconBell size={16}/></div>
            <p>{unread ? (unread.count > 0 ? `${unread.count} unread update${unread.count === 1 ? '' : 's'}` : 'You’re all caught up') : 'Your updates'}</p>
            <span>Important updates will appear here.</span>
            <button onClick={openNotifications}>View notifications <IconArrowRight size={13}/></button>
          </div>}
          <button className="sidebar-user" aria-label="Account menu" aria-expanded={showAdminMenu} onClick={() => setShowAdminMenu(v => !v)}>
            <Avatar imageKey={profile?.avatarKey} label={displayName} variant="sidebar" alt={displayName}/>
            <span className="sidebar-user-info"><span className="user-name">{displayName}</span><span className="user-role">{me?.isPlatformAdmin ? 'Platform Super Admin' : me?.roles.join(', ').replace(/_/g, ' ') || 'Account'}</span></span>
            <IconChevronDown size={12}/>
          </button>
        </div>
      </aside>

      <div className="main-content">
        <div className="topbar">
          <button ref={mobileTrigger} className="btn-icon mobile-nav-toggle" aria-label="Open navigation" onClick={() => setMobileNav(true)}><IconMenu2 size={20}/></button>
          <div className="topbar-breadcrumb">{mode === 'ai' ? <strong>New chat</strong> : <><PageIcon size={18} stroke={1.6}/><span>Workspace</span><span>/</span><strong>{activePage?.label || 'Workspace'}</strong></>}</div>
          <div className="topbar-spacer"/>
          <div className="topbar-actions">
            {mode === 'ai' ? <>
              <button className="btn-icon" aria-label="New chat" title="New chat" onClick={chat.newChat}><IconPencilPlus size={17}/></button>
              <button className="btn-icon" aria-label="Continue chat beside workspace" title="Continue chat beside workspace" onClick={continueInPanel}><IconLayoutSidebarRightExpand size={17}/></button>
            </> : <button className="btn-icon ask-ai-trigger" aria-label="Ask AI" title="Ask AI" onClick={openAskAi}><IconSparkles size={17}/></button>}
            {isUserProfile && (
              <button className="btn btn-outline" style={{ gap: 6 }} onClick={() => document.dispatchEvent(new CustomEvent('trigger-send-email'))}>
                <IconMail size={14}/>
                Send Email
              </button>
            )}
            {realtimeStatus === 'reconnecting' && (
              // Subtle and non-alarming on purpose: a brief drop/backoff reconnect is routine
              // (see `realtime-client.ts`'s bounded jittered backoff), never worth a banner. Shown
              // only for 'reconnecting' — never for 'connecting' (first-ever connect, same
              // non-event) or 'offline' (only reachable here mid-logout, already leaving the page).
              <span
                title="Reconnecting live updates…"
                aria-label="Reconnecting live updates"
                style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--warning, #f59f00)', display: 'inline-block' }}
              />
            )}
            <NotificationBell/>
            <button className="btn-icon" title="More (Ctrl K) — search, timeline, and other commands live here" onClick={() => setShowPalette(true)}>
              <IconDotsVertical size={16} stroke={1.8}/>
            </button>
          </div>
        </div>

          <div
            className="workspace-route-content"
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            <Outlet/>
          </div>
      </div>

      {mode !== 'ai' && <AskAiPanel onExpand={openChatPage}/>}
      <LogoutDialog open={showLogout} onClose={() => setShowLogout(false)}/>
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
      <BulkEmailPanel/>
      <ShiftDrawers/>
      <CreateVenueDrawer/>
      <BatchOfferDrawer/>
      <OfferDecisionDrawers/>
      <ShiftApprovalDrawer/>
      <ShiftRequestDrawer/>
      <ToastHost/>
    </div>
  );
}

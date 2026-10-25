import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { api } from '../shared/api';
import { PageSlotsProvider } from '../shared/page-slots';
import { spring, usePrefersReducedMotion } from '../shared/motion';
import WelcomeOverlay from '../features/onboarding/WelcomeOverlay';
import type { WelcomeRole } from '../features/onboarding/WelcomeOverlay';
import { hasPendingWelcome, clearPendingWelcome } from '../features/onboarding/onboardingMotion';
import {
  IconSettings, IconChevronDown,
  IconChartPie, IconUsers, IconBuildingSkyscraper, IconChecklist,
  IconCalendarMonth, IconCash, IconMapPin, IconHistory,
  IconDots, IconMail, IconSend2, IconAdjustmentsHorizontal, IconHelpCircle, IconLifebuoy,
  IconSearch, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconMenu2, IconX, IconLayoutGrid, IconCalendarCheck, IconSparkles, IconLayoutSidebarRightExpand, IconPencilPlus,
} from '@tabler/icons-react';
import AdminDropdown from './AdminDropdown';
import GlobalSearch from './GlobalSearch';
import CommandPalette from './CommandPalette';
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
import OrganisationDetailHost from '../features/settings/admin-panel/OrganisationDetailHost';
import NotificationBell from '../features/notifications/NotificationBell';
import Avatar from '../shared/components/Avatar';
import { useCurrentProfile } from '../shared/hooks/useCurrentProfile';
import { useRealtimeStatus } from '../shared/lib/RealtimeProvider';
import { useMyWorkspace } from '../shared/hooks/useMyWorkspace';
import { AiChatProvider, useAiChat } from '../features/ai/AiChatProvider';
import AiChatNavigation from '../features/ai/AiChatNavigation';
import AskAiPanel from '../features/ai/AskAiPanel';
import { useAiAvailability } from '../features/ai/useAiAvailability';
import SettingsSidebar from '../features/settings/layout/SettingsSidebar';
import LogoutDialog from '../features/settings/LogoutDialog';
import NavigationModes, { navigationMode, type NavigationMode } from './NavigationModes';
import { AddMenuItem, ShortcutList, useNavShortcuts } from './NavShortcuts';
import './sidebar-motion.css';
import '../features/ai/ai-chat.css';

type NavEntry = { to: string; label: string; Icon: typeof IconUsers; dot?: string };

// Crewflow reference grouping. Same destinations as before (nothing removed); every route stays enforced server-side.
const workspaceNav: NavEntry[] = [
  { to: '/',           label: 'Dashboard',  Icon: IconLayoutGrid },
  { to: '/users',      label: 'Users',       Icon: IconUsers },
  { to: '/shifts',     label: 'Shifts',      Icon: IconCalendarCheck },
  { to: '/payroll',    label: 'Payroll',     Icon: IconCash },
  { to: '/offers',     label: 'Offers',      Icon: IconMail },
];

const operationsNav: NavEntry[] = [
  { to: '/calendar',     label: 'Calendar',     Icon: IconCalendarMonth, dot: 'var(--color-brand)' },
  { to: '/venues',       label: 'Venues',       Icon: IconMapPin,        dot: 'var(--color-brand-secondary)' },
  { to: '/venue-offers', label: 'Venue Offers', Icon: IconSend2,         dot: 'var(--color-brand-yellow)' },
];

// Audit Log is manager-only server-side (PermissionGuard(AUDIT_VIEW)); listed for the roles that hold it by default.
const auditNav: NavEntry = { to: '/audit', label: 'Audit Log', Icon: IconHistory };

// Help and support for everyone in the shell (Support shows an honest "not set up" state without a configured channel).
const helpNav: NavEntry[] = [
  { to: '/help',    label: 'Help Center', Icon: IconHelpCircle },
  { to: '/support', label: 'Support',     Icon: IconLifebuoy },
];

// Breadcrumb metadata for pages that are not listed in the sidebar.
const additionalPages: NavEntry[] = [
  { to: '/settings',   label: 'Settings',    Icon: IconSettings },
];

const SECTIONS_KEY = 'crewflow.sidebar.collapsedSections';
function readCollapsed(): string[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

function SidebarLink({ item, badge }: { item: NavEntry; badge?: number }) {
  const { to, label, Icon, dot } = item;
  // Framer's MotionConfig does not stop shared-layout moves (and paints one frame at the old row), so reduced motion
  // renders a plain, non-shared highlight instead.
  const reduce = usePrefersReducedMotion();
  return (
    <NavLink to={to} end={to === '/'} title={label} aria-label={label} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
      {({ isActive }) => <>
        {/* One shared highlight that slides between items (navigation is never delayed for it). */}
        {isActive && (reduce
          ? <span className="nav-active-pill" aria-hidden="true"/>
          : <motion.span layoutId="sidebar-active-pill" className="nav-active-pill" aria-hidden="true" transition={spring}/>)}
        {dot ? <span className="nav-dot" style={{ background: dot }} aria-hidden="true"/> : <Icon size={16} stroke={1.6}/>}
        <span>{label}</span>
        {badge ? <span className="nav-count" aria-hidden="true">{badge}</span> : null}
      </>}
    </NavLink>
  );
}

function SidebarSection({ id, label, collapsed, onToggle, action, children }: { id: string; label: string; collapsed: boolean; onToggle: (id: string) => void; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={`sidebar-section sidebar-group${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar-group-head">
        <button type="button" className="sidebar-group-label" aria-expanded={!collapsed} onClick={() => onToggle(id)}>
          <IconChevronDown size={12} className="sidebar-group-caret" aria-hidden="true"/>{label}
        </button>
        {action}
      </div>
      {!collapsed && <nav className="sidebar-nav" aria-label={label}>{children}</nav>}
    </div>
  );
}

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
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const modeOrder = { home: 0, ai: 1, settings: 2 };
  const modeDirection = modeOrder[mode] >= modeOrder[previousMode.current] ? 1 : -1;
  useEffect(() => {
    if (mode === 'home') lastHome.current = location.pathname + location.search;
    if (previousMode.current === 'ai' && mode === 'home' && chat.draft.trim() && window.innerWidth > 1000) chat.setPanelOpen(true);
    previousMode.current = mode;
  }, [mode, location.pathname, location.search, chat.draft, chat.setPanelOpen]);
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
    queryFn: async () => (await api.get<{ id?: string; roles: string[]; isPlatformAdmin: boolean }>('/auth/me')).data,
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
  const [collapsedSections, setCollapsedSections] = useState<string[]>(readCollapsed);
  const toggleSection = (id: string) => setCollapsedSections(prev => {
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* preference only */ }
    return next;
  });
  const canSeeAudit = !!me?.roles.some(role => ['manager', 'ceo'].includes(role));
  const isOrgAdmin = !!(me?.isPlatformAdmin || me?.roles.includes('ceo'));
  const shortcuts = useNavShortcuts(me?.id ?? null, workspace?.id);
  // AI entry points (Ask AI, the AI mode) exist only for a user the server confirms as eligible right now
  // (GET /ai/availability → available: true, or not_configured / demo_data_only, which the server answers only to an
  // eligible user of an enabled organisation; the chat then opens with its input disabled). Loading, refused or
  // unreachable all mean: no AI chrome at all.
  const { eligible: aiEligible } = useAiAvailability(!!me && !isPlatformAdminOnly);
  // Real COUNT(*) of active offers (the same cached query the Dashboard uses); null when the caller lacks the permission.
  const { data: navSummary } = useQuery({ queryKey: ['dashboard-summary'], enabled: !!me && !isPlatformAdminOnly, queryFn: async () => (await api.get('/dashboard/summary')).data as { activeOfferCount?: number | null }, staleTime: 60_000 });
  const activePage = [...workspaceNav, ...operationsNav, auditNav, ...helpNav, ...additionalPages].find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to));
  const PageIcon = activePage?.Icon || IconUsers;
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

  // Live top-bar slot elements, published to the routed page (callback refs re-publish a re-created node).
  const [tabsSlot, setTabsSlot] = useState<HTMLElement | null>(null);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [breadcrumbSuffixSlot, setBreadcrumbSuffixSlot] = useState<HTMLElement | null>(null);
  const pageSlots = useMemo(
    () => ({ tabs: tabsSlot, title: titleSlot, actions: actionsSlot, breadcrumbSuffix: breadcrumbSuffixSlot }),
    [tabsSlot, titleSlot, actionsSlot, breadcrumbSuffixSlot],
  );

  return (
    <PageSlotsProvider value={pageSlots}>
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
        <button type="button" className="sidebar-search-field" aria-label="Search workspace" title="Search workspace (/)" onClick={openSearch}>
          <IconSearch size={15} stroke={1.7}/><span>Search</span><kbd>/</kbd>
        </button>
        <NavigationModes mode={mode} expanded={!collapsed || mobile} onSelect={selectMode} showAi={aiEligible}/>

        <motion.div className="sidebar-mode-content" key={mode} initial={reducedMotion || previousMode.current === mode ? false : { opacity: 0, x: modeDirection * (document.documentElement.dir === 'rtl' ? -8 : 8) }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reducedMotion ? 0 : .18, ease: [.2, .8, .2, 1] }}>
        {mode === 'ai' ? <AiChatNavigation /> : mode === 'settings' ? <SettingsSidebar compact isPlatformAdmin={!!me?.isPlatformAdmin} isPlatformAdminOnly={isPlatformAdminOnly} showAi={aiEligible && !!me?.roles.includes('ceo')} onLogoutClick={() => setShowLogout(true)}/> : !isPlatformAdminOnly && (
          <>
            <div className="sidebar-section sidebar-primary">
              <nav className="sidebar-nav" aria-label="Workspace">
                {workspaceNav.map(item => <SidebarLink key={item.to} item={item} badge={item.to === '/offers' ? navSummary?.activeOfferCount ?? undefined : undefined}/>)}
              </nav>
            </div>
            <SidebarSection id="operations" label="Operations" collapsed={collapsedSections.includes('operations')} onToggle={toggleSection}
              action={shortcuts.ready ? <AddMenuItem shortcuts={shortcuts.items} canSeeAudit={canSeeAudit} onAdd={shortcuts.add}/> : undefined}>
              {operationsNav.map(item => <SidebarLink key={item.to} item={item}/>)}
              <ShortcutList items={shortcuts.items} canSeeAudit={canSeeAudit} isOrgAdmin={isOrgAdmin} onRename={shortcuts.rename} onRemove={shortcuts.remove}/>
            </SidebarSection>
            <SidebarSection id="workspace" label="Workspace" collapsed={collapsedSections.includes('workspace')} onToggle={toggleSection}>
              {canSeeAudit && <SidebarLink item={auditNav}/>}
              {helpNav.map(item => <SidebarLink key={item.to} item={item}/>)}
            </SidebarSection>
          </>
        )}
        </motion.div>

        <div className="sidebar-footer">
          <button ref={accountTrigger} className="sidebar-user" aria-label="Account menu" aria-haspopup="menu" aria-expanded={showAdminMenu} onClick={() => setShowAdminMenu(v => !v)}>
            <Avatar imageKey={profile?.avatarKey} label={displayName} variant="sidebar" alt={displayName}/>
            <span className="sidebar-user-info"><span className="user-name">{displayName}</span><span className="user-role">{me?.isPlatformAdmin ? 'Platform Super Admin' : me?.roles.join(', ').replace(/_/g, ' ') || 'Account'}</span></span>
            <IconAdjustmentsHorizontal size={16} stroke={1.6} aria-hidden="true"/>
          </button>
        </div>
      </aside>

      <div className="main-content">
        <div className="topbar">
          <button ref={mobileTrigger} className="btn-icon mobile-nav-toggle" aria-label="Open navigation" onClick={() => setMobileNav(true)}><IconMenu2 size={20}/></button>
          {/\/settings\/workspace\/members\/roles\//.test(location.pathname)
            ? <div className="topbar-breadcrumb role-breadcrumb-slot" data-role-breadcrumb-slot />
            : <div className="topbar-breadcrumb">{mode === 'ai' ? <strong>AI assistant</strong> : <><PageIcon size={18} stroke={1.6}/><span>Workspace</span><span>/</span><strong>{activePage?.label || 'Workspace'}</strong><span ref={setBreadcrumbSuffixSlot} className="topbar-breadcrumb-suffix" data-breadcrumb-suffix-slot /></>}</div>}
          {/* Page tabs / title (PageHeader). The breadcrumb before it only shows when a page has none (CSS :has). */}
          <div ref={setTabsSlot} className="topbar-tabs" data-page-tabs-slot />
          {/* Page-owned slots (filled by a page through a portal, e.g. the Venue Offers pipeline); empty everywhere else. */}
          <div ref={setTitleSlot} className="topbar-center" data-page-title-slot />
          <div className="topbar-spacer"/>
          <div className="topbar-actions">
            <div ref={setActionsSlot} className="topbar-page-actions" data-page-actions-slot />
            {mode === 'ai' ? aiEligible && <>
              <button className="btn-icon" aria-label="New chat" title="New chat" onClick={chat.newChat}><IconPencilPlus size={17}/></button>
              <button className="btn-icon" aria-label="Continue chat beside workspace" title="Continue chat beside workspace" onClick={continueInPanel}><IconLayoutSidebarRightExpand size={17}/></button>
            </> : aiEligible && <button className="btn-icon ask-ai-trigger" aria-label="Ask AI" title="Ask AI" onClick={openAskAi}><IconSparkles size={17}/></button>}
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
            <button className="btn-icon" aria-label="More" title="More (Ctrl K) — search, timeline, and other commands live here" onClick={() => setShowPalette(true)}>
              <IconDots size={18} stroke={1.8}/>
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

      {mode !== 'ai' && aiEligible && <AskAiPanel onExpand={openChatPage}/>}
      <LogoutDialog open={showLogout} onClose={() => setShowLogout(false)}/>
      <AdminDropdown open={showAdminMenu} onClose={() => setShowAdminMenu(false)} onLogout={() => setShowLogout(true)} triggerRef={accountTrigger}/>
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
      <OrganisationDetailHost/>
    </div>
    </PageSlotsProvider>
  );
}

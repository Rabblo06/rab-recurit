import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { api } from '../shared/api';
import { PageSlotsProvider } from '../shared/page-slots';
import NavigationIndicator, { NavigationIndicatorScope } from '../shared/components/NavigationIndicator';
import WelcomeOverlay from '../features/onboarding/WelcomeOverlay';
import type { WelcomeRole } from '../features/onboarding/WelcomeOverlay';
import { hasPendingWelcome, clearPendingWelcome } from '../features/onboarding/onboardingMotion';
import {
  IconSettings, IconChevronDown, IconClock,
  IconChartPie, IconUsers, IconBuildingSkyscraper, IconChecklist,
  IconCalendarMonth, IconCash, IconMapPin, IconHistory,
  IconDots, IconMail, IconSend2, IconAdjustmentsHorizontal, IconHelpCircle, IconLifebuoy,
  IconSearch, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconHome, IconMenu2, IconMessageCircle, IconMessageCirclePlus, IconX, IconLayoutGrid, IconCalendarCheck, IconSparkles, IconLayoutSidebarRightExpand, IconPencilPlus,
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
import Avatar, { ImageWorkspaceContext } from '../shared/components/Avatar';
import { useCurrentProfile } from '../shared/hooks/useCurrentProfile';
import { useRealtimeStatus } from '../shared/lib/RealtimeProvider';
import { useMyWorkspace } from '../shared/hooks/useMyWorkspace';
import { AiChatProvider, useAiChat } from '../features/ai/AiChatProvider';
import AiChatNavigation from '../features/ai/AiChatNavigation';
import AskAiPanel from '../features/ai/AskAiPanel';
import { useAiAvailability } from '../features/ai/useAiAvailability';
import { askAiShortcutLabel, isApplePlatform, isAskAiShortcut } from '../features/ai/aiShortcut';
import SettingsSidebar from '../features/settings/layout/SettingsSidebar';
import LogoutDialog from '../features/settings/LogoutDialog';
import NavigationModes, { navigationMode, type NavigationMode } from './NavigationModes';
import SidebarNavigation from './SidebarNavigation';
import './sidebar-motion.css';
import './mobile-workspace.css';
import '../features/ai/ai-chat.css';

type NavEntry = { to: string; label: string; Icon: typeof IconUsers; dot?: string };

// Crewflow reference grouping. Same destinations as before (nothing removed); every route stays enforced server-side.
const workspaceNav: NavEntry[] = [
  { to: '/up-next', label: 'Up next', Icon: IconClock },
  { to: '/',           label: 'Dashboard',  Icon: IconLayoutGrid },
  { to: '/users',      label: 'Users',       Icon: IconUsers },
  { to: '/shifts',     label: 'Shifts',      Icon: IconCalendarCheck },
  { to: '/payroll',    label: 'Payroll',     Icon: IconCash },
  { to: '/offers',     label: 'Offers',      Icon: IconMail },
];

const operationsNav: NavEntry[] = [
  { to: '/calendar',     label: 'Calendar',     Icon: IconCalendarMonth, dot: 'var(--color-brand)' },
  { to: '/venues',       label: 'Venues',       Icon: IconMapPin,        dot: 'var(--color-brand-secondary)' },
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
  return (
    <NavLink to={to} end={to === '/'} title={label} aria-label={label} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
      {({ isActive }) => <>
        {/* One shared highlight that slides between items (navigation is never delayed for it). */}
        <NavigationIndicator active={isActive} priority={to.length} />
        <Icon size={16} stroke={1.6} style={dot ? { color: dot } : undefined} aria-hidden="true"/>
        <span>{label}</span>
        {badge ? <span className="nav-count" aria-hidden="true">{badge}</span> : null}
      </>}
    </NavLink>
  );
}

export default function Layout() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<{ roles: string[] }>('/auth/me')).data, staleTime: 5 * 60 * 1000 });
  const { data: workspace } = useMyWorkspace({ enabled: !!me?.roles.some(role => ['manager', 'ceo'].includes(role)) });
  // Synchronous remount fences every draft on account/session/workspace changes.
  return <ImageWorkspaceContext.Provider value={workspace?.id ?? 'default'}><AiChatProvider workspaceId={workspace?.id}><LayoutContent /></AiChatProvider></ImageWorkspaceContext.Provider>;
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
  const [mobileNavMode, setMobileNavMode] = useState<NavigationMode | null>(null);
  const sidebarMode = mobile && mobileNavMode ? mobileNavMode : mode;
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
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

  // AI entry points (Ask AI, the AI mode) exist only for a user the server confirms as eligible right now
  // (GET /ai/availability → available: true, or not_configured / demo_data_only, which the server answers only to an
  // eligible user of an enabled organisation; the chat then opens with its input disabled). Loading, refused or
  // unreachable all mean: no AI chrome at all.
  const { eligible: aiEligible } = useAiAvailability(!!me && !isPlatformAdminOnly);
  // U2 (owner decision 5): ⌘J on macOS / Ctrl+J elsewhere toggles Ask AI — only for an eligible user (otherwise the key
  // is left to the browser: no hint that AI exists). On the chat page it does nothing; a modal dialog keeps the keyboard.
  const askAiToggle = useRef<() => void>(() => undefined);
  askAiToggle.current = () => {
    if (mode === 'ai') return;
    if (chat.panelOpen) chat.setPanelOpen(false);
    else openAskAi();
  };
  const aiEligibleRef = useRef(aiEligible);
  aiEligibleRef.current = aiEligible;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!aiEligibleRef.current || !isAskAiShortcut(e)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
      e.preventDefault();
      askAiToggle.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Real COUNT(*) of active offers (the same cached query the Dashboard uses); null when the caller lacks the permission.
  const { data: navSummary } = useQuery({ queryKey: ['dashboard-summary'], enabled: !!me && !isPlatformAdminOnly, queryFn: async () => (await api.get('/dashboard/summary')).data as { activeOfferCount?: number | null }, staleTime: 60_000 });
  const activePage = [...workspaceNav, ...operationsNav, auditNav, ...helpNav, ...additionalPages].find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to));
  const PageIcon = activePage?.Icon || IconUsers;
  useEffect(() => { setMobileNav(false); setMobileNavMode(null); setWorkspaceMenu(false); }, [location.pathname]);
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
      <NavigationIndicatorScope><aside className="sidebar" ref={sidebarRef} aria-label="Main navigation" onKeyDown={event => {
        if (!mobileNav || event.key !== 'Tab') return;
        const controls = [...(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? []), ...document.querySelectorAll<HTMLElement>('.mobile-workspace-nav button:not(:disabled)')].filter(el => el.offsetParent !== null);
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

        <motion.div className="sidebar-mode-content" key={sidebarMode} initial={reducedMotion || previousMode.current === mode ? false : { opacity: 0, x: modeDirection * (document.documentElement.dir === 'rtl' ? -8 : 8) }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reducedMotion ? 0 : .18, ease: [.2, .8, .2, 1] }}>
        {sidebarMode === 'ai' ? <AiChatNavigation /> : sidebarMode === 'settings' ? <SettingsSidebar compact isPlatformAdmin={!!me?.isPlatformAdmin} isPlatformAdminOnly={isPlatformAdminOnly} showAi={aiEligible && !!me?.roles.includes('ceo')} onLogoutClick={() => setShowLogout(true)}/> : !isPlatformAdminOnly && (
          <SidebarNavigation userId={me?.id ?? null} workspaceId={workspace?.id} canSeeAudit={canSeeAudit} isOrgAdmin={isOrgAdmin} collapsed={collapsedSections} onToggle={toggleSection}
            workspace={<>{workspaceNav.map(item => <SidebarLink key={item.to} item={item} badge={item.to === '/offers' ? navSummary?.activeOfferCount ?? undefined : undefined}/>)}</>}
            operations={<>{operationsNav.map(item => <SidebarLink key={item.to} item={item}/>)}</>}
            guide={<>{canSeeAudit && <SidebarLink item={auditNav}/>} {helpNav.map(item => <SidebarLink key={item.to} item={item}/>)}</>}
          />       )}
        </motion.div>

        <div className="sidebar-footer">
          <button ref={accountTrigger} className="sidebar-user" aria-label="Account menu" aria-haspopup="menu" aria-expanded={showAdminMenu} onClick={() => setShowAdminMenu(v => !v)}>
            <Avatar imageKey={profile?.avatarKey} label={displayName} variant="sidebar" alt={displayName}/>
            <span className="sidebar-user-info"><span className="user-name">{displayName}</span><span className="user-role">{me?.isPlatformAdmin ? 'Platform Super Admin' : me?.roles.join(', ').replace(/_/g, ' ') || 'Account'}</span></span>
            <IconAdjustmentsHorizontal size={16} stroke={1.6} aria-hidden="true"/>
          </button>
        </div>
      </aside></NavigationIndicatorScope>

      <div className="main-content">
        <div className="topbar">
          {/\/settings\/workspace\/members(?:\/|$)/.test(location.pathname)
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
              <button className="sidebar-new-chat" aria-label="New chat" title="New chat" onClick={chat.newChat}><IconPencilPlus size={15}/><span>New chat</span></button>
              <button className="btn-icon" aria-label="Continue chat beside workspace" title="Continue chat beside workspace" onClick={continueInPanel}><IconLayoutSidebarRightExpand size={17}/></button>
            </> : aiEligible && <button className="btn-icon ask-ai-trigger" aria-label="Ask AI" aria-keyshortcuts={isApplePlatform() ? 'Meta+J' : 'Control+J'} title={`Ask AI (${askAiShortcutLabel()})`} onClick={openAskAi}><IconSparkles size={17}/></button>}
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
            <Outlet context={{ openSearch }}/>
          </div>
      </div>

      {mobile && <nav className="mobile-workspace-nav" aria-label="Mobile workspace">
        <button ref={mobileTrigger} className="mobile-tools-toggle" type="button" aria-label={mobileToolsOpen ? 'Close mobile menu' : 'Open mobile menu'} aria-expanded={mobileToolsOpen} aria-controls="mobile-workspace-actions" onClick={() => { setMobileToolsOpen(value => !value); if (mobileToolsOpen) setMobileNav(false); }}>{mobileToolsOpen ? <IconX size={23}/> : <IconMenu2 size={23}/>}</button>
        {mobileToolsOpen && <div id="mobile-workspace-actions" className="mobile-workspace-actions">
          <button type="button" aria-label="Home" aria-expanded={mobileNav && sidebarMode === 'home'} onClick={() => { setMobileNavMode('home'); setMobileNav(true); }}><IconHome size={21}/></button>
          <button type="button" aria-label="Settings" aria-expanded={mobileNav && sidebarMode === 'settings'} onClick={() => { if (mode === 'settings') { setMobileNavMode('settings'); setMobileNav(true); } else { setMobileNav(false); selectMode('settings'); } }}><IconSettings size={21}/></button>
          <button type="button" aria-label="Search workspace" onClick={() => { setMobileNav(false); openSearch(); }}><IconSearch size={21}/></button>
          <button type="button" aria-label="Open chat" title={aiEligible ? 'Open chat' : 'Chat is not available for this account'} disabled={!aiEligible} onClick={() => { setMobileNav(false); openChatPage(); }}><IconMessageCircle size={21}/></button>
          <button type="button" aria-label="New chat" title={aiEligible ? 'New chat' : 'Chat is not available for this account'} disabled={!aiEligible} onClick={() => { setMobileNav(false); chat.newChat(); openChatPage(); }}><IconMessageCirclePlus size={21}/></button>
        </div>}
      </nav>}

      {mode !== 'ai' && aiEligible && <AskAiPanel onExpand={openChatPage}/>}
      <LogoutDialog open={showLogout} onClose={() => setShowLogout(false)}/>
      <AdminDropdown open={showAdminMenu} onClose={() => setShowAdminMenu(false)} onLogout={() => setShowLogout(true)} triggerRef={accountTrigger}/>
      <GlobalSearch open={showSearch} onClose={() => setShowSearch(false)}/>
      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        onOpenSearch={openSearch}
        onOpenTimeline={openTimeline}
        onAskAi={aiEligible && mode !== 'ai' ? openAskAi : undefined}
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

// "Before" request schedules: what each screen requests, and when, in the client code of main 614796f0.
// Read from the code (rab-front, rab-mobile and rab-iphone at 614796f0 == b5960740 for those three packages; verified with
// `git diff --stat 614796f0 b5960740 -- packages/rab-front packages/rab-mobile packages/rab-iphone` = empty).
// The "after" run swaps this file for schedules/after-<sha>.mjs with the same screen ids; nothing else changes.
//
// basis: CODE  = schedule read from the client code; the run MEASURES its server cost.
//        DERIVED = the client cannot run here (iOS, no macOS): the schedule is read from the Swift code only.
// Paths are relative to API_URL (/rest/v1). {pipelineShiftId} etc. are per-user parameters set by the mix file.

// ---- Flutter (rab-mobile) ------------------------------------------------------------------------------------------
// lib/features/venue_manager/venue_manager_provider.dart refresh() (lines 258-355): capabilities, then 5 lists paged
// in parallel (Future.wait = all run to completion, then the first error is thrown), then counts, directory and report
// probes. Any error clears every list (no request effect).
const flutterVmRefresh = [
  { get: '/auth/capabilities', capture: 'caps' },
  {
    parallel: [
      { pageAll: '/shifts', limit: 100 },
      { pageAll: '/venues?includeArchived=true', limit: 100 },
      { pageAll: '/job-roles', limit: 100 },
      { pageAll: '/offers', limit: 100 },
      { pageAll: '/shifts/sent?view=all', limit: 100 },
    ],
    onError: 'wait-all',
  },
  { get: '/shifts/sent?view=all&limit=1' },
  { ifCap: 'staff.view', swallow: true, steps: [{ get: '/staff/venue-directory?limit=1' }] },
  {
    ifCap: 'report.view',
    swallow: true,
    steps: [{ parallel: [{ get: '/attendance/report/shifts?bucket=current&page=1&limit=1' }, { get: '/attendance/report/shifts?bucket=history&page=1&limit=1' }], onError: 'wait-all' }],
  },
];
// lib/features/notifications/notifications_provider.dart: unread count at construction + Timer.periodic(30 s), never
// cancelled on background (no lifecycle observer). Created for staff and Venue Manager presentations (app.dart:64).
const flutterBell = { name: 'notifications', intervalMs: 30_000, policy: 'fixed-allow-overlap', whenHidden: 'run', steps: [{ swallowAll: [{ get: '/notifications/unread-count' }] }] };
// lib/features/offers/offers_provider.dart load(): `if (_loading) return` -> one /offers/mine in flight per user.
const flutterOffersMine = { get: '/offers/mine', dedupe: 'offers-mine' };
const flutterActive = { get: '/attendance/me/active' };
// lib/navigation/app_shell.dart:38: Timer.periodic(30 s), runs only when lifecycleState == resumed; also on resume.
const flutterAppShell = {
  name: 'appshell-reconcile',
  intervalMs: 30_000,
  policy: 'fixed-allow-overlap',
  whenHidden: 'skip',
  steps: [{ parallel: [{ swallowAll: [flutterOffersMine] }, { swallowAll: [flutterActive] }], onError: 'wait-all' }],
};

// ---- iOS (rab-iphone, DERIVED) -------------------------------------------------------------------------------------
// Features/VenueManager/VenueManagerStore.swift refresh(): same sequence as Flutter but `/venues` without
// includeArchived, `async let` children (the first thrown error cancels the siblings), and X-Crewflow-Background on polls.
const iosVmRefresh = [
  { get: '/auth/capabilities', capture: 'caps' },
  {
    parallel: [
      { pageAll: '/shifts', limit: 100 },
      { pageAll: '/venues', limit: 100 },
      { pageAll: '/job-roles', limit: 100 },
      { pageAll: '/offers', limit: 100 },
      { pageAll: '/shifts/sent?view=all', limit: 100 },
    ],
    onError: 'cancel-others',
  },
  { get: '/shifts/sent?view=all&limit=1' },
  { ifCap: 'staff.view', swallow: true, steps: [{ get: '/staff/venue-directory?limit=1' }] },
  {
    ifCap: 'report.view',
    swallow: true,
    steps: [{ parallel: [{ get: '/attendance/report/shifts?bucket=current&page=1&limit=1' }, { get: '/attendance/report/shifts?bucket=history&page=1&limit=1' }], onError: 'cancel-others' }],
  },
];

// ---- Web (rab-front) -----------------------------------------------------------------------------------------------
// shared/api.ts:51 + shared/lib/user-activity.ts: X-Crewflow-Background once the tab had no input for 60 s.
// features/notifications/NotificationBell.tsx:34-38: refetchInterval 30 s; TanStack pauses it while the tab is hidden
// (refetchIntervalInBackground default false); App.tsx:137 refetchOnWindowFocus false -> no catch-up on visible.
// shared/lib/SessionProvider.tsx:69-80: /auth/me when the tab becomes visible; features/ai/useAiAvailability.ts:24
// refetchOnWindowFocus -> /ai/availability on focus/visible. No poll catches up on visible (refetchOnWindowFocus false).
const webResume = [{ swallowAll: [{ get: '/auth/me' }] }, { swallowAll: [{ get: '/ai/availability' }] }];
const webBell = { name: 'bell', intervalMs: 30_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/notifications/unread-count' }] };

export default {
  name: 'before-614796f0',
  description: 'Client polling schedules at main 614796f0 (before Phase C1).',
  screens: {
    // sent_shifts_screen.dart:49-54: Timer.periodic(5 s) -> refresh(silent: true) while the route is current; the
    // `!provider.loading` guard never trips for silent refreshes, so refreshes overlap when one takes > 5 s. No lifecycle
    // gate (keeps running in the background). Resume: venue_manager_screens.dart:125-128 refresh(silent: true).
    'vm-sent-shifts-flutter': {
      client: 'flutter',
      auth: 'mobile',
      basis: 'CODE',
      backgroundHeader: 'never', // Flutter never sends X-Crewflow-Background at 614796f0
      onStart: [{ swallowAll: flutterVmRefresh }, { swallowAll: [{ get: '/notifications/unread-count' }] }],
      onResume: [{ swallowAll: flutterVmRefresh }],
      timers: [
        { name: 'sent-shifts-poll', intervalMs: 5_000, policy: 'fixed-allow-overlap', whenHidden: 'run', steps: flutterVmRefresh },
        flutterBell,
      ],
    },
    // VMSentShiftsScreen.swift:165-172: loop { sleep 5 s; if visible && scenePhase == .active && !loading
    // { await refresh(silent: true, background: true) } } -> serial, period = 5 s + refresh time. No bell for VMs.
    'vm-sent-shifts-ios': {
      client: 'ios',
      auth: 'mobile',
      basis: 'DERIVED',
      backgroundHeader: 'never',
      onStart: [{ swallowAll: iosVmRefresh }],
      timers: [{ name: 'sent-shifts-poll', intervalMs: 5_000, policy: 'serial-sleep-then-run', whenHidden: 'skip', backgroundHeader: 'always', steps: [{ swallowAll: iosVmRefresh }] }],
    },
    // Staff Home (AppShell): OffersProvider + AttendanceProvider constructors load once; AppShell 30 s reconcile while
    // resumed; NotificationsProvider 30 s always. Resume: AppShell._refresh().
    'staff-home-flutter': {
      client: 'flutter',
      auth: 'mobile',
      basis: 'CODE',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: [flutterOffersMine] }, { swallowAll: [flutterActive] }, { swallowAll: [{ get: '/notifications/unread-count' }] }], onError: 'wait-all' }],
      onResume: [{ parallel: [{ swallowAll: [flutterOffersMine] }, { swallowAll: [flutterActive] }], onError: 'wait-all' }],
      timers: [flutterAppShell, flutterBell],
    },
    // Staff on Job Details: everything Staff Home does, plus shift_status_control.dart:36-49: a 1 s tick that calls
    // OffersProvider.load(silent) every 30th tick while TickerMode is on (not tied to app lifecycle), plus a load on resume.
    'staff-job-details-flutter': {
      client: 'flutter',
      auth: 'mobile',
      basis: 'CODE',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: [flutterOffersMine] }, { swallowAll: [flutterActive] }, { swallowAll: [{ get: '/notifications/unread-count' }] }], onError: 'wait-all' }],
      onResume: [{ parallel: [{ swallowAll: [flutterOffersMine] }, { swallowAll: [flutterActive] }, { swallowAll: [flutterOffersMine] }], onError: 'wait-all' }],
      timers: [
        flutterAppShell,
        flutterBell,
        { name: 'job-details-tick', intervalMs: 30_000, firstAfterMs: 13_000, policy: 'fixed-allow-overlap', whenHidden: 'run', steps: [{ swallowAll: [flutterOffersMine] }] },
      ],
    },
    // StaffRootView.swift:90-99: loop { sleep 30 s; if foreground { reconcile (offers/mine + attendance/me/active in
    // parallel); unread-count } }, all with X-Crewflow-Background.
    'staff-home-ios': {
      client: 'ios',
      auth: 'mobile',
      basis: 'DERIVED',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: [{ get: '/offers/mine' }] }, { swallowAll: [{ get: '/attendance/me/active' }] }], onError: 'wait-all' }, { swallowAll: [{ get: '/notifications/unread-count' }] }],
      timers: [
        {
          name: 'reconcile',
          intervalMs: 30_000,
          policy: 'serial-sleep-then-run',
          whenHidden: 'skip',
          backgroundHeader: 'always',
          steps: [{ parallel: [{ swallowAll: [{ get: '/offers/mine' }] }, { swallowAll: [{ get: '/attendance/me/active' }] }], onError: 'wait-all' }, { swallowAll: [{ get: '/notifications/unread-count' }] }],
        },
      ],
    },
    // features/scheduling/VenueOfferPipeline.tsx:256-305: pipeline refetchInterval 5 s (paused hidden); avatar previews
    // refetchInterval 60 s (paused hidden); capabilities/me staleTime 5 min (no polling). Plus the shell's bell.
    'web-venue-offer-pipeline': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onResume: webResume,
      onStart: [
        { parallel: [{ get: '/shifts/{pipelineShiftId}/pipeline', capture: 'pipeline' }, { get: '/auth/capabilities' }, { get: '/auth/me' }, { get: '/notifications/unread-count' }], onError: 'wait-all' },
        { derive: 'webPipelineAvatarPreviews' },
      ],
      timers: [
        { name: 'pipeline', intervalMs: 5_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/shifts/{pipelineShiftId}/pipeline', capture: 'pipeline' }] },
        { name: 'avatar-previews', intervalMs: 60_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ derive: 'webPipelineAvatarPreviews' }] },
        webBell,
      ],
    },
    // features/scheduling/VenueOffers.tsx:117-124: refetchInterval 10 s, GET /shifts/requests with no limit (server
    // default page of 500). Plus the shell's bell.
    'web-venue-offers': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onResume: webResume,
      onStart: [{ parallel: [{ get: '/shifts/requests' }, { get: '/notifications/unread-count' }], onError: 'wait-all' }],
      timers: [{ name: 'venue-offers', intervalMs: 10_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/shifts/requests' }] }, webBell],
    },
    // Notification bell alone (any other web page): NotificationBell.tsx 30 s.
    'web-bell': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onResume: webResume,
      onStart: [{ get: '/notifications/unread-count' }],
      timers: [webBell],
    },
    // Admin panel, Health tab (features/settings/admin-panel/HealthTab.tsx:49-70, HEALTH_REFETCH_MS 15 s,
    // + the AI health section; confirmed against the real client by web/measure-web.mjs),
    // METRICS_REFETCH_MS 30 s): health report, queues, failed outbox and the selected queue's failed jobs every 15 s,
    // queue metrics every 30 s. AdminPanelPage's own health observer shares the query key and mounts in the same commit,
    // so it is deduplicated (dedupe key). Plus the shell's bell.
    'web-admin-health': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onResume: webResume,
      onStart: [
        { parallel: [{ get: '/admin/health/report', dedupe: 'admin-health' }, { get: '/admin/queues', capture: 'adminQueues' }, { get: '/admin/outbox/failed?limit=50' }, { get: '/notifications/unread-count' }], onError: 'wait-all' },
        { parallel: [{ get: '/admin/queues/{adminQueue}/jobs?state=failed&limit=25' }, { get: '/admin/queues/{adminQueue}/metrics?range=1D' }, { get: '/admin/ai/overview' }, { get: '/admin/ai/usage?from={todayUtc}&to={todayUtc}&limit=200' }], onError: 'wait-all' },
      ],
      timers: [
        // One TanStack observer (own interval, own in-flight dedupe) per query; all mount in the same commit.
        { name: 'health-report', intervalMs: 15_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/admin/health/report', dedupe: 'admin-health' }] },
        { name: 'queues', intervalMs: 15_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/admin/queues', capture: 'adminQueues' }] },
        { name: 'outbox', intervalMs: 15_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/admin/outbox/failed?limit=50' }] },
        { name: 'jobs', intervalMs: 15_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/admin/queues/{adminQueue}/jobs?state=failed&limit=25' }] },
        { name: 'metrics-30s', intervalMs: 30_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/admin/queues/{adminQueue}/metrics?range=1D' }] },
        // AiHealthSection (AiAdminSections.tsx:43,64), rendered on the Health tab: AI overview 15 s, usage (range 'today') 30 s.
        { name: 'ai-overview', intervalMs: 15_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/admin/ai/overview' }] },
        { name: 'ai-usage', intervalMs: 30_000, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps: [{ get: '/admin/ai/usage?from={todayUtc}&to={todayUtc}&limit=200' }] },
        webBell,
      ],
    },
  },
};

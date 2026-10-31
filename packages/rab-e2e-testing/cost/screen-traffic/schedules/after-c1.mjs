// "After" request schedules: what each screen requests, and when, in the Phase C1 client code (C:/rab-ai-wt/c1 working
// tree, uncommitted, measured 2026-10-31 as images rab-{server,worker}:c1-wip). Same screen ids as before-614796f0.mjs;
// only this file and the code under test change between the two runs.
// Measured configuration: REALTIME_ENABLED / PUSH_ENABLED false (as production): the realtime stream answers 204 and every
// client stops it (one GET /realtime/stream at start), so no poll runs at its 120 s realtime fallback interval.
//
// The C1 polling policy, the same in all three clients (rab-front shared/lib/polling.ts, rab-mobile
// lib/core/polling/poll_scheduler.dart, rab-iphone Crewflow/Core/Polling/PollScheduler.swift):
//   ±20 % jitter; one run in flight, the next delay starts after it ends (serial); only while the app is foreground and
//   the screen visible; one run on resume/visible; 429 -> Retry-After (default 30 s) + up to 20 %; other errors ×2 up to
//   5 min; timer runs send X-Crewflow-Background: 1 (resume/visible/manual runs do not).
// basis: CODE = read from the client code, server cost MEASURED; DERIVED = iOS (cannot run here).
const C1 = { jitterPct: 0.2, policy: 'serial-sleep-then-run', whenHidden: 'skip', backgroundHeader: 'always', backoff: { defaultRetryAfterS: 30, capMs: 300_000 } };
const realtimeProbe = { swallowAll: [{ get: '/realtime/stream' }] }; // 204 while REALTIME_ENABLED=false -> client stops

// ---- Flutter (rab-mobile) ------------------------------------------------------------------------------------------
// venue_manager_provider.dart:443-560 refresh(): capabilities, then 5 lists paged at limit 100 in parallel (Sent Shifts
// All delivers the tab counts on its first page: no separate count call any more), then the directory and 2 report probes.
// Runs at start (venue_manager_screens.dart:118), on resume after a real background (:126-139), pull-to-refresh and after
// the user's own mutations; NEVER on a timer.
const flutterVmFullRefresh = [
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
  { ifCap: 'staff.view', swallow: true, steps: [{ get: '/staff/venue-directory?limit=1' }] },
  { ifCap: 'report.view', swallow: true, steps: [{ parallel: [{ get: '/attendance/report/shifts?bucket=current&page=1&limit=1' }, { get: '/attendance/report/shifts?bucket=history&page=1&limit=1' }], onError: 'wait-all' }] },
];
// notifications_provider.dart:16-25: unread count at construction, then PollScheduler 60 s (default refreshOnResume).
const flutterBell = { name: 'notifications', intervalMs: 60_000, ...C1, steps: [{ get: '/notifications/unread-count' }] };
// offers_provider.dart:38-90: /offers/mine keyset walk; first load of the session scope=all limit 200, polls/resume
// scope=current limit 50; joinInFlight shares a walk already running.
const offersAll = { keysetAll: '/offers/mine', query: 'scope=all', limit: 200, dedupe: 'offers-mine' };
const offersCurrent = { keysetAll: '/offers/mine', query: 'scope=current', limit: 50, dedupe: 'offers-mine' };
// navigation/app_shell.dart:38-75: PollScheduler 30 s -> offers (current, joinInFlight) + /attendance/me/active.
const flutterReconcile = [{ parallel: [offersCurrent, { get: '/attendance/me/active' }], onError: 'wait-all' }];

// ---- iOS (rab-iphone, DERIVED) -------------------------------------------------------------------------------------
// VenueManagerStore.swift:80-160 refresh(): as Flutter but `/venues` without includeArchived and `async let` children.
const iosVmFullRefresh = [
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
  { ifCap: 'staff.view', swallow: true, steps: [{ get: '/staff/venue-directory?limit=1' }] },
  { ifCap: 'report.view', swallow: true, steps: [{ parallel: [{ get: '/attendance/report/shifts?bucket=current&page=1&limit=1' }, { get: '/attendance/report/shifts?bucket=history&page=1&limit=1' }], onError: 'cancel-others' }] },
];

// ---- Web (rab-front) -----------------------------------------------------------------------------------------------
// shared/lib/polling.ts pollingOptions(): refetchInterval = jittered base (fixed-rate TanStack timer, a tick while in
// flight is dropped), refetchIntervalInBackground false, refetchOnWindowFocus 'always' = one catch-up fetch on visible.
// SessionProvider.tsx: /auth/me on visible; useAiAvailability: /ai/availability on focus.
const webPoll = (name, intervalMs, steps) => ({ name, intervalMs, jitterPct: 0.2, policy: 'fixed-skip-if-inflight', whenHidden: 'skip', steps });
const webShellResume = [{ swallowAll: [{ get: '/auth/me' }] }, { swallowAll: [{ get: '/ai/availability' }] }, { swallowAll: [{ get: '/notifications/unread-count' }] }];
// features/notifications/NotificationBell.tsx:12,45: UNREAD_POLL_MS 60 s.
const webBell = webPoll('bell', 60_000, [{ get: '/notifications/unread-count' }]);

export default {
  name: 'after-c1',
  description: 'Client polling schedules of the Phase C1 working tree (REALTIME/PUSH off).',
  screens: {
    // sent_shifts_screen.dart:22,65-84: PollScheduler 30 s, refreshOnResume false (the shell does the full refresh), visible
    // = TickerMode && route current; task = provider.pollSentView (venue_manager_provider.dart:198-215): ONLY
    // /shifts/sent?view=<tab>&page=1&limit=50 (sentPollLimit), skipped while a full refresh runs.
    'vm-sent-shifts-flutter': {
      client: 'flutter',
      auth: 'mobile',
      basis: 'CODE',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: flutterVmFullRefresh }, { swallowAll: [{ get: '/notifications/unread-count' }] }, realtimeProbe], onError: 'wait-all' }],
      onResume: [{ parallel: [{ swallowAll: flutterVmFullRefresh }, { swallowAll: [{ get: '/notifications/unread-count' }] }], onError: 'wait-all' }],
      timers: [{ name: 'sent-shifts-poll', intervalMs: 30_000, ...C1, steps: [{ get: '/shifts/sent?view=all&page=1&limit=50' }] }, flutterBell],
    },
    // VMSentShiftsScreen.swift:16-22,50-58,180-187: PollScheduler 30 s (refreshOnResume false), visible = on screen && tab
    // active, foreground = scenePhase != .background; task = store.pollSentView (VenueManagerStore.swift:213-260): first
    // page limit 50. VenueManagerRootView.swift:45-58: full refresh at start and after a real background. No bell for VMs.
    'vm-sent-shifts-ios': {
      client: 'ios',
      auth: 'mobile',
      basis: 'DERIVED',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: iosVmFullRefresh }, realtimeProbe], onError: 'wait-all' }],
      onResume: [{ swallowAll: iosVmFullRefresh }],
      timers: [{ name: 'sent-shifts-poll', intervalMs: 30_000, ...C1, steps: [{ get: '/shifts/sent?view=all&page=1&limit=50' }] }],
    },
    // Staff Home: OffersProvider (full walk) + AttendanceProvider + NotificationsProvider constructors, realtime probe;
    // AppShell reconcile 30 s; bell 60 s. Resume: AppShell (offers current + active) and the bell's own resume run.
    'staff-home-flutter': {
      client: 'flutter',
      auth: 'mobile',
      basis: 'CODE',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: [offersAll] }, { swallowAll: [{ get: '/attendance/me/active' }] }, { swallowAll: [{ get: '/notifications/unread-count' }] }, realtimeProbe], onError: 'wait-all' }],
      onResume: [{ parallel: [{ swallowAll: flutterReconcile }, { swallowAll: [{ get: '/notifications/unread-count' }] }], onError: 'wait-all' }],
      timers: [{ name: 'appshell-reconcile', intervalMs: 30_000, ...C1, steps: flutterReconcile }, flutterBell],
    },
    // Job Details: shift_status_control.dart:33-58: the 30 s /offers/mine tick is GONE (only the server's own transition
    // boundary reloads once); its resume load joins AppShell's walk (joinInFlight). Same traffic as Staff Home.
    'staff-job-details-flutter': {
      client: 'flutter',
      auth: 'mobile',
      basis: 'CODE',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: [offersAll] }, { swallowAll: [{ get: '/attendance/me/active' }] }, { swallowAll: [{ get: '/notifications/unread-count' }] }, realtimeProbe], onError: 'wait-all' }],
      onResume: [{ parallel: [{ swallowAll: flutterReconcile }, { swallowAll: [offersCurrent] }, { swallowAll: [{ get: '/notifications/unread-count' }] }], onError: 'wait-all' }],
      timers: [{ name: 'appshell-reconcile', intervalMs: 30_000, ...C1, steps: flutterReconcile }, flutterBell],
    },
    // StaffRootView.swift:17-22,59-80,110-130 + StaffStore.swift:131-165: start = offers scope=all (200), active, history
    // (keyset 200), unread; PollScheduler 30 s -> pollReconcile = offers scope=current (50) + active + unread, background;
    // on .active: reconcile + unread (no header).
    'staff-home-ios': {
      client: 'ios',
      auth: 'mobile',
      basis: 'DERIVED',
      backgroundHeader: 'never',
      onStart: [{ parallel: [{ swallowAll: [offersAll] }, { swallowAll: [{ get: '/attendance/me/active' }] }, { swallowAll: [{ keysetAll: '/attendance/me/history', limit: 200 }] }, { swallowAll: [{ get: '/notifications/unread-count' }] }, realtimeProbe], onError: 'wait-all' }],
      onResume: [{ parallel: [{ swallowAll: [offersCurrent] }, { swallowAll: [{ get: '/attendance/me/active' }] }, { swallowAll: [{ get: '/notifications/unread-count' }] }], onError: 'wait-all' }],
      timers: [{ name: 'reconcile', intervalMs: 30_000, ...C1, steps: [{ parallel: [{ swallowAll: [offersCurrent] }, { swallowAll: [{ get: '/attendance/me/active' }] }, { swallowAll: [{ get: '/notifications/unread-count' }] }], onError: 'wait-all' }] }],
    },
    // features/scheduling/VenueOfferPipeline.tsx:243-310: pipeline PIPELINE_POLL_MS 15 s; avatar previews read once
    // (staleTime 10 min, no refetchInterval); capabilities/me staleTime 5 min. Plus the shell's bell.
    'web-venue-offer-pipeline': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onStart: [
        { parallel: [{ get: '/shifts/{pipelineShiftId}/pipeline', capture: 'pipeline' }, { get: '/auth/capabilities' }, { get: '/auth/me' }, { get: '/notifications/unread-count' }, realtimeProbe], onError: 'wait-all' },
        { derive: 'webPipelineAvatarPreviews' },
      ],
      onResume: [...webShellResume, { swallowAll: [{ get: '/shifts/{pipelineShiftId}/pipeline', capture: 'pipeline' }] }],
      timers: [webPoll('pipeline', 15_000, [{ get: '/shifts/{pipelineShiftId}/pipeline', capture: 'pipeline' }]), webBell],
    },
    // features/scheduling/VenueOffers.tsx:33,123-133: VENUE_OFFERS_POLL_MS 30 s, /shifts/requests?page=1&limit=50
    // (LIST_PAGE_SIZE, shared/table-toolbar/pageSize.ts:7) with a real pager. Plus the shell's bell.
    'web-venue-offers': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onStart: [{ parallel: [{ get: '/shifts/requests?page=1&limit=50' }, { get: '/notifications/unread-count' }, realtimeProbe], onError: 'wait-all' }],
      onResume: [...webShellResume, { swallowAll: [{ get: '/shifts/requests?page=1&limit=50' }] }],
      timers: [webPoll('venue-offers', 30_000, [{ get: '/shifts/requests?page=1&limit=50' }]), webBell],
    },
    'web-bell': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onStart: [{ get: '/notifications/unread-count' }, realtimeProbe],
      onResume: webShellResume,
      timers: [webBell],
    },
    // Admin panel, Health tab: HealthTab.tsx:12,29,51-71 (health report, queues, failed outbox, the selected queue's failed
    // jobs at HEALTH_REFETCH_MS 15 s; queue metrics at METRICS_REFETCH_MS 30 s), AiAdminSections.tsx:47-69 (AI overview
    // 15 s only with { poll: true } = the Health tab; usage 30 s). AdminPanelPage.tsx:17,56: the health BADGE observer
    // (60 s) shares the ['admin','health'] key with the 15 s observer, whose updates keep resetting it (dedupe key).
    'web-admin-health': {
      client: 'web',
      auth: 'web',
      basis: 'CODE',
      backgroundHeader: 'after-idle-60s',
      onStart: [
        { parallel: [{ get: '/admin/health/report', dedupe: 'admin-health' }, { get: '/admin/queues', capture: 'adminQueues' }, { get: '/admin/outbox/failed?limit=50' }, { get: '/notifications/unread-count' }, realtimeProbe], onError: 'wait-all' },
        { parallel: [{ get: '/admin/queues/{adminQueue}/jobs?state=failed&limit=25' }, { get: '/admin/queues/{adminQueue}/metrics?range=1D' }, { get: '/admin/ai/overview' }, { get: '/admin/ai/usage?from={todayUtc}&to={todayUtc}&limit=200' }], onError: 'wait-all' },
      ],
      onResume: [
        ...webShellResume,
        { parallel: [{ swallowAll: [{ get: '/admin/health/report', dedupe: 'admin-health' }] }, { swallowAll: [{ get: '/admin/queues', capture: 'adminQueues' }] }, { swallowAll: [{ get: '/admin/outbox/failed?limit=50' }] }, { swallowAll: [{ get: '/admin/queues/{adminQueue}/jobs?state=failed&limit=25' }] }, { swallowAll: [{ get: '/admin/queues/{adminQueue}/metrics?range=1D' }] }, { swallowAll: [{ get: '/admin/ai/overview' }] }, { swallowAll: [{ get: '/admin/ai/usage?from={todayUtc}&to={todayUtc}&limit=200' }] }], onError: 'wait-all' },
      ],
      timers: [
        webPoll('health-report', 15_000, [{ get: '/admin/health/report', dedupe: 'admin-health' }]),
        webPoll('queues', 15_000, [{ get: '/admin/queues', capture: 'adminQueues' }]),
        webPoll('outbox', 15_000, [{ get: '/admin/outbox/failed?limit=50' }]),
        webPoll('jobs', 15_000, [{ get: '/admin/queues/{adminQueue}/jobs?state=failed&limit=25' }]),
        webPoll('metrics-30s', 30_000, [{ get: '/admin/queues/{adminQueue}/metrics?range=1D' }]),
        webPoll('ai-overview', 15_000, [{ get: '/admin/ai/overview' }]),
        webPoll('ai-usage', 30_000, [{ get: '/admin/ai/usage?from={todayUtc}&to={todayUtc}&limit=200' }]),
        webBell,
      ],
    },
  },
};

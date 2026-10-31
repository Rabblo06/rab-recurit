import SwiftUI

/// The Staff app (Flutter `AppShell`): Home / Calendar / History / Profile,
/// one NavigationStack per tab (switching tabs never reloads or loses the
/// scroll position), the shared floating tab bar, a 30 s ±20 % silent
/// reconcile while foregrounded (`PollScheduler`: single-flight, 429 /
/// backoff, background-flagged), a refresh on resume, and the realtime
/// stream (Phase C1b; 204 while `REALTIME_ENABLED=false` disables it).
///
/// Mounted by `StaffShell` (App/Shells.swift), which is keyed to the
/// signed-in identity: a new identity gets a brand-new store.
struct StaffRootView: View {
    let tabs: [ShellTab]
    @StateObject private var store: StaffStore
    @StateObject private var navigator = StaffNavigator()
    // The resume reconcile below is its own (larger) refresh.
    @StateObject private var reconcilePoll = PollScheduler(interval: StaffRootView.reconcileInterval, refreshOnResume: false)
    @StateObject private var realtime: RealtimeClient
    @EnvironmentObject private var session: SessionCoordinator
    @Environment(\.scenePhase) private var scenePhase

    static let reconcileInterval: TimeInterval = 30

    init(environment: AppEnvironment, tabs: [ShellTab]) {
        self.tabs = tabs
        _store = StateObject(wrappedValue: StaffStore(
            repository: StaffRepository(api: environment.api),
            fence: environment.session
        ))
        _realtime = StateObject(wrappedValue: RealtimeClient(transport: APIRealtimeTransport(api: environment.api)))
    }

    var body: some View {
        ZStack {
            ForEach(tabs) { tab in
                let active = tab.id == navigator.selectedTab
                NavigationStack(path: navigator.path(for: tab.id)) {
                    root(for: tab.id)
                        .toolbar(.hidden, for: .navigationBar)
                        .navigationDestination(for: StaffRoute.self) { route in
                            destination(route)
                        }
                }
                // Hidden tabs stay mounted: pollers read this (Phase C1).
                .environment(\.shellTabActive, active)
                .opacity(active ? 1 : 0)
                .allowsHitTesting(active)
                .accessibilityHidden(!active)
            }
        }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if navigator.isAtRoot {
                FloatingTabBar(tabs: tabs, selection: $navigator.selectedTab)
            }
        }
        .environmentObject(store)
        .environmentObject(navigator)
        .task { await store.start() }
        .task { await startPolling() }
        .onAppear { realtime.setVisible(true) }
        .onDisappear { realtime.setVisible(false) }
        .onChange(of: scenePhase) { phase in
            store.isForeground = phase == .active
            reconcilePoll.setForeground(phase != .background)
            realtime.setForeground(phase != .background)
            if phase == .active {
                Task { @MainActor in
                    await store.reconcile(background: false)
                    await store.refreshUnreadCount()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .crewflowPushActivity)) { note in
            // An arrival is background traffic (never slides the idle window); a tap is the user acting.
            let background = !PushActivity.isUserInitiated(note)
            Task { @MainActor in
                await store.reconcile(background: background)
                await store.refreshUnreadCount(background: background)
            }
        }
    }

    @ViewBuilder
    private func root(for tab: String) -> some View {
        switch tab {
        case StaffTab.home.rawValue: StaffHomeScreen()
        case StaffTab.calendar.rawValue: StaffCalendarScreen()
        case StaffTab.history.rawValue: StaffHistoryScreen()
        default: StaffProfileScreen()
        }
    }

    @ViewBuilder
    private func destination(_ route: StaffRoute) -> some View {
        switch route {
        case .offers: StaffOffersScreen(confirmed: false)
        case .confirmed: StaffOffersScreen(confirmed: true)
        case .upcoming: StaffUpcomingScreen()
        case .jobDetail(let offer): StaffJobDetailScreen(snapshot: offer)
        case .clock(let offer): StaffClockScreen(snapshot: offer, teams: false)
        case .teams(let offer): StaffClockScreen(snapshot: offer, teams: true)
        case .inbox: StaffInboxScreen()
        case .payslips: StaffPayslipsScreen()
        case .document(let fileId, let filename, let title): StaffDocumentScreen(fileId: fileId, filename: filename, title: title)
        case .security: StaffSecurityScreen()
        }
    }

    /// The 30 s reconcile (timer runs are background traffic, so polling
    /// alone never keeps an idle session alive), then the realtime stream:
    /// an event re-reads only what it names; a reconnect after a drop
    /// reconciles what may have been missed. Both stop for good when the
    /// API session generation changes.
    @MainActor
    private func startPolling() async {
        let store = self.store
        let api = store.repository.api
        await reconcilePoll.start(
            foreground: scenePhase != .background,
            identity: { await api.currentGeneration() },
            task: { trigger in try await store.pollReconcile(background: trigger.isBackground) }
        )
        await realtime.start(
            foreground: scenePhase != .background,
            identity: { await api.currentGeneration() },
            userId: session.user?.id,
            onEvents: { types in
                let refreshes = StaffRealtimeRefresh.refreshes(for: types)
                guard !refreshes.isEmpty else { return }
                Task { await store.applyRealtime(refreshes) }
            },
            onReconnect: {
                Task { try? await store.pollReconcile(background: true) }
            }
        )
    }
}

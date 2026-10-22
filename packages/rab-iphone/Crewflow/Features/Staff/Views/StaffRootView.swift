import SwiftUI

/// The Staff app (Flutter `AppShell`): Home / Calendar / History / Profile,
/// one NavigationStack per tab (switching tabs never reloads or loses the
/// scroll position), the shared floating tab bar, a 30 s silent reconcile
/// while foregrounded, and a refresh on resume.
///
/// Mounted by `StaffShell` (App/Shells.swift), which is keyed to the
/// signed-in identity: a new identity gets a brand-new store.
struct StaffRootView: View {
    let tabs: [ShellTab]
    @StateObject private var store: StaffStore
    @StateObject private var navigator = StaffNavigator()
    @Environment(\.scenePhase) private var scenePhase

    static let reconcileInterval: UInt64 = 30

    init(environment: AppEnvironment, tabs: [ShellTab]) {
        self.tabs = tabs
        _store = StateObject(wrappedValue: StaffStore(
            repository: StaffRepository(api: environment.api),
            fence: environment.session
        ))
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
        .task { await reconcileLoop() }
        .onChange(of: scenePhase) { phase in
            store.isForeground = phase == .active
            if phase == .active {
                Task { @MainActor in
                    await store.reconcile(background: false)
                    await store.refreshUnreadCount()
                }
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

    /// Flutter's 30 s reconcile. Marked background (`X-Crewflow-Background`)
    /// so polling alone never keeps an idle session alive (B11, flagged).
    private func reconcileLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: Self.reconcileInterval * 1_000_000_000)
            guard !Task.isCancelled else { return }
            if store.isForeground {
                await store.reconcile(background: true)
                await store.refreshUnreadCount(background: true)
            }
        }
    }
}

import SwiftUI

/// Venue Manager app content for the shell in App/Shells.swift: one
/// `VenueManagerStore` for the signed-in identity (the shell is rebuilt on
/// every identity change), the four tabs, a silent full refresh on resume
/// from the background, and the realtime stream (Phase C1b; the server
/// answers 204 while `REALTIME_ENABLED=false`, which disables it).
struct VenueManagerRootView: View {
    let tabs: [ShellTab]
    @EnvironmentObject private var environment: AppEnvironment
    @EnvironmentObject private var session: SessionCoordinator

    var body: some View {
        VenueManagerTabs(
            tabs: tabs,
            repository: VenueManagerRepository(api: environment.api),
            userId: session.user?.id ?? ""
        )
    }
}

private struct VenueManagerTabs: View {
    let tabs: [ShellTab]
    @StateObject private var store: VenueManagerStore
    @StateObject private var realtime: RealtimeClient
    @Environment(\.scenePhase) private var scenePhase
    @State private var wasBackgrounded = false

    init(tabs: [ShellTab], repository: VenueManagerRepository, userId: String) {
        self.tabs = tabs
        _store = StateObject(wrappedValue: VenueManagerStore(repository: repository, userId: userId))
        _realtime = StateObject(wrappedValue: RealtimeClient(transport: APIRealtimeTransport(api: repository.api)))
    }

    var body: some View {
        TabShell(tabs: tabs) { tab in
            switch tab.id {
            case "home": VMHomeView()
            case "calendar": VMCalendarView()
            case "history": VMReportBucketScreen(bucket: .history, isRoot: true)
            default: AccountProfileView()
            }
        }
        .environmentObject(store)
        .task { await store.refresh() }
        .task { await startRealtime() }
        .onAppear { realtime.setVisible(true) }
        .onDisappear { realtime.setVisible(false) }
        .onChange(of: scenePhase) { phase in
            realtime.setForeground(phase != .background)
            if phase == .background { wasBackgrounded = true }
            // The full refresh reads every list: only after the app was
            // really in the background, not after the notification shade or
            // a system dialog (`inactive` only).
            if phase == .active, wasBackgrounded {
                wasBackgrounded = false
                Task { await store.refresh(silent: true) }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .crewflowPushActivity)) { note in
            // An arrival is background traffic (never slides the idle window); a tap is the user acting.
            let background = !PushActivity.isUserInitiated(note)
            Task { await store.refresh(silent: true, background: background) }
        }
    }

    @MainActor
    private func startRealtime() async {
        let store = self.store
        let api = store.repository.api
        await realtime.start(
            foreground: scenePhase != .background,
            identity: { await api.currentGeneration() },
            userId: store.userId.isEmpty ? nil : store.userId,
            onEvents: { types in
                guard VMRealtimeRefresh.needsRefresh(types) else { return }
                Task { await store.refresh(silent: true, background: true) }
            },
            onReconnect: {
                Task { await store.refresh(silent: true, background: true) }
            }
        )
    }
}

import SwiftUI

/// Venue Manager app content for the shell in App/Shells.swift: one
/// `VenueManagerStore` for the signed-in identity (the shell is rebuilt on
/// every identity change), the four tabs, and a silent refresh on resume.
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
    @Environment(\.scenePhase) private var scenePhase

    init(tabs: [ShellTab], repository: VenueManagerRepository, userId: String) {
        self.tabs = tabs
        _store = StateObject(wrappedValue: VenueManagerStore(repository: repository, userId: userId))
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
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await store.refresh(silent: true) } }
        }
    }
}

import SwiftUI

/// One tab of a role shell.
struct ShellTab: Identifiable, Hashable {
    let id: String
    let title: String
    let systemImage: String
}

/// Shared shell: every tab keeps its own NavigationStack alive (switching
/// tabs never reloads or loses scroll position), and the floating tab bar
/// sits in the bottom safe-area inset so content scrolls clear of it. Each
/// tab gets `\.shellTabActive` so its pollers stop while it is hidden.
struct TabShell<Content: View>: View {
    let tabs: [ShellTab]
    let content: (ShellTab) -> Content
    @State private var selection: String

    init(tabs: [ShellTab], @ViewBuilder content: @escaping (ShellTab) -> Content) {
        self.tabs = tabs
        self.content = content
        _selection = State(initialValue: tabs.first?.id ?? "")
    }

    var body: some View {
        ZStack {
            ForEach(tabs) { tab in
                let active = tab.id == selection
                NavigationStack {
                    content(tab)
                        .toolbar(.hidden, for: .navigationBar)
                }
                // Hidden tabs stay mounted, so their screens never get
                // onDisappear: pollers read this instead (Phase C1).
                .environment(\.shellTabActive, active)
                .opacity(active ? 1 : 0)
                .allowsHitTesting(active)
                .accessibilityHidden(!active)
            }
        }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            FloatingTabBar(tabs: tabs, selection: $selection)
        }
    }
}

/// Floating capsule tab bar (Flutter `MovingTabBar`, schedule style): 90 %
/// width up to 440 pt, 72 pt tall, the active tab marked by a 54 pt black
/// circle. Labels are exposed to VoiceOver and selection is announced.
struct FloatingTabBar: View {
    let tabs: [ShellTab]
    @Binding var selection: String
    @Namespace private var indicator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(tabs: [ShellTab], selection: Binding<String>) {
        self.tabs = tabs
        self._selection = selection
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs) { tab in
                let selected = tab.id == selection
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85)) {
                        selection = tab.id
                    }
                } label: {
                    ZStack {
                        if selected {
                            Circle()
                                .fill(ScheduleTokens.accent)
                                .frame(width: ScheduleTokens.navigationActiveSize, height: ScheduleTokens.navigationActiveSize)
                                .matchedGeometryEffect(id: "active-tab", in: indicator)
                        }
                        Image(systemName: tab.systemImage)
                            .font(.system(size: 21, weight: .regular))
                            .foregroundStyle(selected ? Color.white : ScheduleTokens.muted)
                    }
                    .frame(maxWidth: .infinity, minHeight: ScheduleTokens.navigationActiveSize)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("tab.\(tab.id)")
            }
        }
        .padding(ScheduleTokens.navigationPadding)
        .frame(height: ScheduleTokens.navigationHeight)
        .background(
            Capsule()
                .fill(Color.white)
                .shadow(color: RGBA(argb: 0x1427213C).color, radius: 14, x: 0, y: 6)
        )
        .frame(maxWidth: ScheduleTokens.navigationMaxWidth)
        .padding(.horizontal, 20)
        .padding(.bottom, ScheduleTokens.navigationBottom)
        .padding(.top, 4)
    }
}

// MARK: - Staff

/// Staff app: Home / Calendar / History / Profile (Flutter `AppShell`).
struct StaffShell: View {
    static let tabs = [
        ShellTab(id: "home", title: "Home", systemImage: "house"),
        ShellTab(id: "calendar", title: "Calendar", systemImage: "calendar"),
        ShellTab(id: "history", title: "History", systemImage: "doc.text"),
        ShellTab(id: "profile", title: "Profile", systemImage: "person"),
    ]

    @EnvironmentObject private var environment: AppEnvironment

    /// Hook into Features/Staff (StaffRootView owns the Staff tabs, store
    /// and navigation; the tab ids above are reused unchanged).
    var body: some View {
        StaffRootView(environment: environment, tabs: Self.tabs)
            // A container keeps its children's own identifiers (tabs, rows).
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("shell.staff")
    }
}

// MARK: - Venue Manager

/// Venue Manager app: Home / Calendar / History (reports) / Profile.
struct VenueManagerShell: View {
    static let tabs = [
        ShellTab(id: "home", title: "Home", systemImage: "briefcase"),
        ShellTab(id: "calendar", title: "Calendar", systemImage: "calendar"),
        ShellTab(id: "history", title: "History", systemImage: "doc.text"),
        ShellTab(id: "profile", title: "Profile", systemImage: "person"),
    ]

    var body: some View {
        // Features/VenueManager: one store per identity + the four tabs
        // (Home, Calendar, History = report history, shared Profile).
        VenueManagerRootView(tabs: Self.tabs)
            // A container keeps its children's own identifiers (tabs, rows).
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("shell.venueManager")
    }
}

// MARK: - Profile (shared, real data only)

/// Shows the server-verified identity, a Security row (two-factor
/// authentication and the biometric preference, `AccountSecurityScreen`)
/// and Sign out. Profile details, documents and notifications are later
/// features; nothing here is sample data.
struct AccountProfileView: View {
    @EnvironmentObject private var session: SessionCoordinator
    @State private var signingOut = false

    init() {}

    private var roleLabel: String {
        switch session.presentation {
        case .staff: return "Staff"
        case .venueManager: return "Venue Manager"
        case .manager: return "Manager"
        case .admin: return "Administrator"
        case .unsupported: return "Account"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ScheduleTokens.homeSectionGap) {
                Text("Profile")
                    .scheduleType(ScheduleType.pageTitle)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 12)

                if let user = session.user {
                    HStack(spacing: 14) {
                        InitialsAvatar(name: user.fullName, size: 56)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(user.fullName).scheduleType(ScheduleType.cardTitle)
                            Text(user.email).scheduleType(ScheduleType.secondary)
                            StatusBadge(roleLabel, style: nil)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }

                NavigationLink {
                    AccountSecurityScreen()
                        .toolbar(.hidden, for: .navigationBar)
                        .navigationBarBackButtonHidden(true)
                } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "shield")
                            .font(.system(size: 18))
                            .foregroundStyle(ScheduleTokens.ink)
                            .frame(width: 22)
                            .accessibilityHidden(true)
                        Text("Security").scheduleType(ScheduleType.bodyStrong)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .foregroundStyle(ScheduleTokens.muted)
                            .accessibilityHidden(true)
                    }
                    .padding(16)
                    .frame(minHeight: 56)
                    .background(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).fill(Color.white))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("profile.security")

                MessageCard(
                    title: FeaturePlaceholderView.notImplementedMessage,
                    message: "Profile details, documents and notifications will appear here."
                )

                PrimaryButton("Sign out", systemImage: "rectangle.portrait.and.arrow.right", variant: .light, isBusy: signingOut) {
                    signingOut = true
                    Task { @MainActor in await session.logout() }
                }
                .accessibilityIdentifier("profile.signOut")
            }
            .padding(.horizontal, ScheduleTokens.homeInset)
            .padding(.bottom, 24)
        }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
    }
}

// MARK: - Manager / Admin / unsupported

/// Manager/Admin operations stay in the web console (Flutter
/// `ConsoleEntryScreen`). No mobile data is loaded for these accounts.
struct ConsoleEntryView: View {
    let unsupported: Bool
    @EnvironmentObject private var environment: AppEnvironment
    @EnvironmentObject private var session: SessionCoordinator
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.openURL) private var openURL

    init(unsupported: Bool) {
        self.unsupported = unsupported
    }

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text(unsupported ? "Account access" : "Management console")
                .scheduleType(ScheduleType.heading)
                .accessibilityAddTraits(.isHeader)
            Text(unsupported
                 ? "This account has no supported mobile role. Contact your administrator."
                 : "Your Manager/Admin workspace is available in the existing web console.")
                .scheduleType(ScheduleType.body)
                .multilineTextAlignment(.center)
            if !unsupported {
                PrimaryButton("Open management console", systemImage: "safari") { openConsole() }
                    .padding(.top, 8)
            }
            PrimaryButton("Sign out", variant: .light) {
                Task { @MainActor in await session.logout() }
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: ScheduleTokens.contentMaxWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        // A container keeps its children's own identifiers (tabs, rows).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("shell.console")
    }

    private func openConsole() {
        let failure = "Unable to open the management console. Contact your administrator."
        guard let url = environment.configuration.consoleURL else {
            toasts.show(failure, kind: .error)
            return
        }
        openURL(url) { accepted in
            if !accepted { toasts.show(failure, kind: .error) }
        }
    }
}

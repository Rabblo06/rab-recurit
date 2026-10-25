import SwiftUI

/// Which top-level screen to show. A pure function of server-verified
/// session state so it can be unit-tested; never derived from JWT claims.
enum AppRoute: Equatable {
    case loading
    case signIn(reauth: Bool)
    case secondFactor
    case biometricUnlock
    case biometricSetup
    case setPassword
    case staff
    case venueManager
    case console(unsupported: Bool)

    static func resolve(
        phase: SessionCoordinator.Phase,
        presentation: AppPresentation?,
        canAccessAuthenticatedUI: Bool
    ) -> AppRoute {
        switch phase {
        case .loading: return .loading
        case .unauthenticated: return .signIn(reauth: false)
        case .reauthRequired: return .signIn(reauth: true)
        case .secondFactor: return .secondFactor
        case .biometricLocked: return .biometricUnlock
        case .offeringBiometricSetup: return .biometricSetup
        case .mustResetPassword: return .setPassword
        case .authenticated:
            guard canAccessAuthenticatedUI, let presentation else { return .signIn(reauth: false) }
            switch presentation {
            case .staff: return .staff
            case .venueManager: return .venueManager
            case .manager, .admin: return .console(unsupported: false)
            case .unsupported: return .console(unsupported: true)
            }
        }
    }
}

/// Auth-gated root (Flutter `_RootGate`). Bootstraps the session, routes on
/// its phase, keys each shell to the signed-in identity so nothing survives
/// an account switch, and hosts toasts, deep links and lifecycle hooks.
struct RootView: View {
    let environment: AppEnvironment
    @ObservedObject private var session: SessionCoordinator
    @Environment(\.scenePhase) private var scenePhase

    init(environment: AppEnvironment) {
        self.environment = environment
        _session = ObservedObject(wrappedValue: environment.session)
    }

    private var route: AppRoute {
        AppRoute.resolve(
            phase: session.phase,
            presentation: session.user?.presentation,
            canAccessAuthenticatedUI: session.canAccessAuthenticatedUI
        )
    }

    /// Changes on every sign-in/out and account switch → fresh view state.
    private var identityKey: String {
        "\(session.user?.id ?? "none"):\(session.presentation.rawValue):\(session.epoch)"
    }

    var body: some View {
        content
            .environmentObject(environment)
            .environmentObject(session)
            .environmentObject(environment.toasts)
            .toastHost(environment.toastPresenter)
            .preferredColorScheme(.light)
            .tint(ScheduleTokens.accent)
            .task { await session.start() }
            .onChange(of: scenePhase) { phase in
                if phase == .active { session.sceneDidBecomeActive() }
            }
            .onOpenURL { url in session.handleOpenURL(url) }
    }

    @ViewBuilder
    private var content: some View {
        switch route {
        case .loading:
            LoadingView("Loading")
                .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        case .signIn(let reauth):
            LoginView(reauth: reauth)
        case .secondFactor:
            SecondFactorView()
        case .biometricUnlock:
            BiometricUnlockView()
        case .biometricSetup:
            BiometricSetupView()
        case .setPassword:
            SetPasswordView()
        case .staff:
            StaffShell().id(identityKey)
        case .venueManager:
            VenueManagerShell().id(identityKey)
        case .console(let unsupported):
            ConsoleEntryView(unsupported: unsupported).id(identityKey)
        }
    }
}

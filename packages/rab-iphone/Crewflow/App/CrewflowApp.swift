import SwiftUI

@main
struct CrewflowApp: App {
    /// Push hooks only (token callbacks, notification presentation/taps).
    @UIApplicationDelegateAdaptor(CrewflowAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            switch model.boot {
            case .ready(let environment):
                RootView(environment: environment)
            case .misconfigured(let problem):
                ConfigurationErrorView(problem: problem)
            }
        }
    }
}

/// Holds the one boot result for the process lifetime.
@MainActor
final class AppModel: ObservableObject {
    let boot: AppBoot

    init() {
        boot = AppEnvironment.boot()
        if case .ready = boot {
            ShiftColourStore.attach(ShiftVisualStyle.registry)
        }
    }
}

/// Shown instead of the app when the build has no usable backend address.
/// Makes no network call.
struct ConfigurationErrorView: View {
    let problem: AppConfiguration.Problem

    var body: some View {
        EmptyStateView(
            systemImage: "wrench.and.screwdriver",
            title: "This build is not configured",
            message: problem.message
        )
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .preferredColorScheme(.light)
        .accessibilityIdentifier("configuration.error")
    }
}

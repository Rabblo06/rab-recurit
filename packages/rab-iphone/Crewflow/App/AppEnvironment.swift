import Foundation
import SwiftUI

/// Build-time configuration read from Info.plist (filled from
/// Config/*.xcconfig). Validated once at launch; the app refuses to run
/// against a missing, placeholder or (in Release) non-HTTPS backend rather
/// than guessing a host — there is never an implicit production endpoint.
public struct AppConfiguration: Equatable, Sendable {
    public let apiBaseURL: URL
    public let consoleURL: URL?
    public let isDebugBuild: Bool

    public enum Problem: Error, Equatable, Sendable {
        case missing
        case invalid
        case placeholder
        case insecure
        case wrongPath

        public var message: String {
            switch self {
            case .missing:
                return "No API address is configured for this build. Set API_BASE_URL in Config/Local.xcconfig (Debug) or Config/Release.local.xcconfig / CI (Release)."
            case .invalid:
                return "The configured API address is not a valid URL."
            case .placeholder:
                return "This build still uses the placeholder API host (dev-host.invalid). Point API_BASE_URL at a real backend. A phone's \"localhost\" is the phone itself, not your development computer."
            case .insecure:
                return "Release builds require an HTTPS API address."
            case .wrongPath:
                return "API_BASE_URL must include the /rest/v1 prefix (for example https://api.example.com/rest/v1)."
            }
        }
    }

    public static func resolve(
        apiBaseURL rawAPI: String?,
        consoleURL rawConsole: String?,
        isDebugBuild: Bool,
        allowPlaceholderHost: Bool = false
    ) -> Result<AppConfiguration, Problem> {
        guard var text = rawAPI?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty, !text.contains("$(")
        else { return .failure(.missing) }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), let host = url.host, !host.isEmpty else {
            return .failure(.invalid)
        }
        if host.lowercased().hasSuffix(".invalid"), !allowPlaceholderHost { return .failure(.placeholder) }
        guard scheme == "https" || (scheme == "http" && isDebugBuild) else { return .failure(.insecure) }
        guard url.path.hasSuffix("/rest/v1") else { return .failure(.wrongPath) }
        return .success(AppConfiguration(
            apiBaseURL: url,
            consoleURL: consoleURL(rawConsole, isDebugBuild: isDebugBuild),
            isDebugBuild: isDebugBuild
        ))
    }

    /// An unusable console URL is simply "not available" (the console entry
    /// screen then says so); it never blocks the mobile app.
    static func consoleURL(_ raw: String?, isDebugBuild: Bool) -> URL? {
        guard let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, !text.contains("$("),
              let url = URL(string: text), let scheme = url.scheme?.lowercased(), url.host != nil
        else { return nil }
        guard scheme == "https" || (scheme == "http" && isDebugBuild) else { return nil }
        return url
    }
}

/// How the app booted.
public enum AppBoot {
    case ready(AppEnvironment)
    case misconfigured(AppConfiguration.Problem)
}

/// The dependency container. One instance per process; features receive
/// what they need from it (never construct their own API client).
@MainActor
public final class AppEnvironment: ObservableObject {
    public let configuration: AppConfiguration
    public let api: APIClient
    public let session: SessionCoordinator
    public let toasts: ToastCenter
    public let toastPresenter: ToastPresenter
    public let temporaryFiles: TemporaryFiles
    public let pushDevice: PushDeviceIdentity
    /// APNs registration path (prepared, not activated: see PushRegistrar).
    let push: PushRegistrar

    public init(
        configuration: AppConfiguration,
        sessionStore: any SecureStore,
        deviceStore: any SecureStore,
        authenticator: any BiometricAuthenticating,
        urlSessionConfiguration: URLSessionConfiguration = APIClient.defaultConfiguration()
    ) {
        let tokens = TokenStore(store: sessionStore)
        let temporaryFiles = TemporaryFiles()
        let api = APIClient(
            baseURL: configuration.apiBaseURL,
            tokens: tokens,
            temporaryFiles: temporaryFiles,
            configuration: urlSessionConfiguration,
            allowsInsecureStorageRedirects: configuration.isDebugBuild
        )
        let pushDevice = PushDeviceIdentity(store: deviceStore)
        let session = SessionCoordinator(
            api: api,
            tokens: tokens,
            biometricStore: BiometricStore(store: deviceStore),
            pushDevice: pushDevice,
            authenticator: authenticator
        )
        let toasts = ToastCenter(policy: .errorsOnly)
        self.configuration = configuration
        self.api = api
        self.session = session
        self.toasts = toasts
        self.toastPresenter = ToastPresenter(center: toasts)
        self.temporaryFiles = temporaryFiles
        self.pushDevice = pushDevice
        let push = PushRegistrar(
            api: api,
            identity: pushDevice,
            authorizer: SystemPushAuthorizer(),
            currentUserId: { [weak session] in session?.user?.id }
        )
        self.push = push
        PushTokenRelay.registrar = push
        session.onSignedOut = { [weak toasts] in
            // Nothing from the previous identity stays on screen.
            toasts?.dismissAll()
        }
    }

    /// Production boot (and, in Debug only, the UI-test boot).
    public static func boot(bundle: Bundle = .main, processInfo: ProcessInfo = .processInfo) -> AppBoot {
        #if DEBUG
        let isDebugBuild = true
        if processInfo.arguments.contains(UITestSupport.launchArgument) {
            return UITestSupport.boot(processInfo: processInfo)
        }
        #else
        let isDebugBuild = false
        #endif

        let result = AppConfiguration.resolve(
            apiBaseURL: bundle.object(forInfoDictionaryKey: "CrewflowAPIBaseURL") as? String,
            consoleURL: bundle.object(forInfoDictionaryKey: "CrewflowConsoleURL") as? String,
            isDebugBuild: isDebugBuild
        )
        switch result {
        case .failure(let problem):
            return .misconfigured(problem)
        case .success(let configuration):
            let service = bundle.bundleIdentifier ?? "crewflow"
            let sessionStore = KeychainStore(service: service + ".session")
            let deviceStore = KeychainStore(service: service + ".device")
            // Keychain items survive uninstall; a fresh install starts clean.
            FreshInstallGuard.run(stores: [sessionStore, deviceStore])
            return .ready(AppEnvironment(
                configuration: configuration,
                sessionStore: sessionStore,
                deviceStore: deviceStore,
                authenticator: LocalBiometricAuthenticator()
            ))
        }
    }
}

#if DEBUG
/// UI-test launches: in-memory secrets, no biometrics, a placeholder host
/// that is never contacted before sign-in. Compiled out of Release builds.
enum UITestSupport {
    static let launchArgument = "-CrewflowUITesting"

    @MainActor
    static func boot(processInfo: ProcessInfo = .processInfo) -> AppBoot {
        guard case .success(let configuration) = AppConfiguration.resolve(
            apiBaseURL: "https://ui-test.invalid/rest/v1",
            consoleURL: nil,
            isDebugBuild: true,
            allowPlaceholderHost: true
        ) else { return .misconfigured(.invalid) }
        return .ready(AppEnvironment(
            configuration: configuration,
            sessionStore: InMemorySecureStore(),
            deviceStore: InMemorySecureStore(),
            authenticator: UnavailableBiometricAuthenticator(),
            urlSessionConfiguration: stubConfiguration(processInfo.arguments)
        ))
    }

    /// The canned backend a UI test asked for, if any. Without a stub
    /// argument the placeholder host is never reachable, so sign-in fails
    /// closed rather than contacting a real server.
    static func stubConfiguration(_ arguments: [String]) -> URLSessionConfiguration {
        // The 2FA stub answers the auth/2FA routes and delegates the rest to
        // the Staff stub, so it is checked first.
        if arguments.contains(TwoFactorUITestStub.launchArgument) { return TwoFactorUITestStub.configuration() }
        if arguments.contains(StaffUITestStub.launchArgument) { return StaffUITestStub.configuration() }
        if arguments.contains(VMUITestStub.launchArgument) { return VMUITestStub.configuration() }
        return APIClient.defaultConfiguration()
    }
}

struct UnavailableBiometricAuthenticator: BiometricAuthenticating {
    func capability() async -> BiometricCapability { .unavailable }
    func authenticate(reason: String) async -> BiometricOutcome { .notAvailable }
}
#endif

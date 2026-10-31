import Foundation
import UIKit
import UserNotifications

/// The OS side of push (tests inject a fake).
@MainActor
protocol PushAuthorizing: AnyObject {
    /// Shows the system permission prompt. Called ONLY from an explicit user
    /// action, never on launch or sign-in.
    func requestAuthorization() async -> Bool
    func registerForRemoteNotifications()
}

@MainActor
final class SystemPushAuthorizer: PushAuthorizing {
    init() {}

    func requestAuthorization() async -> Bool {
        do {
            return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            return false
        }
    }

    func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }
}

/// `POST /push/devices` body. No user, organisation or workspace field: the
/// server binds the device to the authenticated identity.
struct PushDeviceRegistrationBody: Encodable, Equatable {
    let deviceId: String
    let platform: String
    let pushToken: String
    let appVersion: String?
}

/// APNs registration path, PREPARED BUT NOT ACTIVATED (Phase C1b): the
/// `aps-environment` entitlement is still a TODO
/// (`Resources/Crewflow.entitlements`) and no screen calls `enable` yet, so
/// nothing here runs in a shipped build until the owner adds the entitlement,
/// the APNs key on the server and the "Turn on notifications" entry point.
///
/// - `enable(for:)` asks permission (explicit user action only), then asks
///   the OS for an APNs token.
/// - `didReceive(deviceToken:)` registers `{deviceId: <Keychain UUID>,
///   platform: "ios", pushToken: <hex APNs token>, appVersion}` for the user
///   who asked, if that user is still the one signed in, then calls
///   `PushDeviceIdentity.markRegistered`, which is what makes sign-out
///   deactivate this device (explicit call + `pushDeviceId` in
///   `/auth/logout`, see `SessionCoordinator.logout`).
/// - The direct APNs sender is server-side; never an FCM token for iOS.
@MainActor
final class PushRegistrar: ObservableObject {
    enum State: Equatable {
        case idle
        case requesting
        case denied
        case waitingForToken
        case registered
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private let api: APIClient
    private let identity: PushDeviceIdentity
    private let authorizer: PushAuthorizing
    private let currentUserId: @MainActor () -> String?
    private let appVersion: String?
    private var pendingUserId: String?

    init(
        api: APIClient,
        identity: PushDeviceIdentity,
        authorizer: PushAuthorizing,
        currentUserId: @escaping @MainActor () -> String?,
        appVersion: String? = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    ) {
        self.api = api
        self.identity = identity
        self.authorizer = authorizer
        self.currentUserId = currentUserId
        self.appVersion = appVersion
    }

    /// Explicit user action only ("Turn on notifications").
    func enable(for userId: String) async {
        guard currentUserId() == userId else { return }
        state = .requesting
        let granted = await authorizer.requestAuthorization()
        guard granted else {
            state = .denied
            return
        }
        guard currentUserId() == userId else {
            state = .idle
            return
        }
        pendingUserId = userId
        state = .waitingForToken
        authorizer.registerForRemoteNotifications()
    }

    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    /// Registers only for the person who asked and is still signed in, or
    /// re-registers (token rotation) for the person this device is already
    /// registered to.
    func didReceive(deviceToken: Data) async {
        guard let userId = currentUserId(),
              pendingUserId == userId || identity.registeredUserId() == userId
        else { return }
        let body = PushDeviceRegistrationBody(
            deviceId: identity.deviceId(),
            platform: "ios",
            pushToken: Self.hex(deviceToken),
            appVersion: appVersion
        )
        do {
            // An upsert keyed by deviceId, but a mutation: never auto-retried.
            try await api.post("/push/devices", body: body, options: RequestOptions(retry: .never))
            // Signed out while the request was on the wire: the APIClient
            // already dropped the answer; never mark the next identity.
            guard currentUserId() == userId else { return }
            try identity.markRegistered(userId: userId)
            pendingUserId = nil
            state = .registered
        } catch {
            state = .failed(userMessage(for: error))
        }
    }

    /// `application(_:didFailToRegisterForRemoteNotificationsWithError:)`
    /// (always the case while the entitlement is missing).
    func registrationFailed() {
        pendingUserId = nil
        state = .failed("Notifications are not available in this build.")
    }

    /// The raw APNs token as lowercase hex, which is what the server's APNs
    /// sender puts in `/3/device/<token>`.
    nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}

/// Carries the AppDelegate's token callbacks to the registrar of the running
/// environment (weak: nothing is kept alive by the relay).
@MainActor
enum PushTokenRelay {
    static weak var registrar: PushRegistrar?

    static func deliver(_ token: Data) {
        guard let registrar else { return }
        Task { await registrar.didReceive(deviceToken: token) }
    }

    static func failed() {
        registrar?.registrationFailed()
    }
}

extension Notification.Name {
    /// A push notification arrived in the foreground or was opened: the
    /// open shell reconciles from the API (the payload is generic and is
    /// never read for data).
    static let crewflowPushActivity = Notification.Name("crewflow.push.activity")
}

/// Who caused a `.crewflowPushActivity`: a foreground ARRIVAL is not user
/// activity, so its reconcile is background-flagged and cannot slide the
/// session idle window of an unattended phone (C1 security review F3); a TAP
/// is the person acting and stays a foreground read.
enum PushActivity {
    static let userInitiatedKey = "userInitiated"

    static func post(userInitiated: Bool) {
        NotificationCenter.default.post(name: .crewflowPushActivity, object: nil, userInfo: [userInitiatedKey: userInitiated])
    }

    /// Missing or malformed → not user-initiated (the stricter reading).
    static func isUserInitiated(_ note: Notification) -> Bool {
        (note.userInfo?[userInitiatedKey] as? Bool) ?? false
    }
}

/// `UNUserNotificationCenterDelegate`. Presentation stays generic: the
/// server sends only a generic title/body ("You have a new notification"),
/// and the app never adds payroll or personal data to what the lock screen
/// shows. A tap only asks the open shell to reconcile from the API.
final class PushNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = PushNotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
        DispatchQueue.main.async {
            PushActivity.post(userInitiated: false)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async {
            PushActivity.post(userInitiated: true)
        }
        completionHandler()
    }
}

/// App delegate: only the push hooks. Remote notifications never register
/// on their own (see `PushRegistrar`).
final class CrewflowAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = PushNotificationDelegate.shared
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushTokenRelay.deliver(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushTokenRelay.failed() }
    }
}

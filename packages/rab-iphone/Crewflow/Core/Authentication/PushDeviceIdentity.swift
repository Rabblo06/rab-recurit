import Foundation

/// Per-install push identity (no push registration is implemented in this
/// build; this is the shared seam the push feature uses).
///
/// - `deviceId` is a `UUID().uuidString` persisted in the Keychain for the
///   life of the install. It MUST be a UUID: `/push/devices/:deviceId/...`
///   answers 404 for any non-UUID path id (Flutter's 32-hex id is a known
///   bug there).
/// - The push feature registers with `POST /push/devices`
///   `{deviceId, platform: "ios", pushToken: <raw APNs token, hex>, appVersion?}`
///   (never an FCM token; the server has a direct APNs sender) and then
///   calls `markRegistered(userId:)`.
/// - `SessionCoordinator.logout()` deactivates the device BEFORE
///   `/auth/logout` (logout does not deactivate push server-side).
public final class PushDeviceIdentity: Sendable {
    static let deviceIdKey = "rab.push.deviceId"
    static let registeredUserIdKey = "rab.push.registeredUserId"

    private let backing: any SecureStore

    public init(store: any SecureStore) {
        self.backing = store
    }

    /// Stable for this install; created on first use.
    public func deviceId() -> String {
        if let existing = backing.string(for: Self.deviceIdKey), UUID(uuidString: existing) != nil {
            return existing
        }
        let created = UUID().uuidString
        try? backing.set(created, for: Self.deviceIdKey)
        return created
    }

    public func registeredUserId() -> String? {
        backing.string(for: Self.registeredUserIdKey)
    }

    public func markRegistered(userId: String) throws {
        try backing.set(userId, for: Self.registeredUserIdKey)
    }

    public func clearRegistration() {
        backing.remove(Self.registeredUserIdKey)
    }
}

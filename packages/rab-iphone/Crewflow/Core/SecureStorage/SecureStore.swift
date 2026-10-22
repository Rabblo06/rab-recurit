import Foundation
import Security

/// Small string key/value store for secrets. The production implementation
/// is the Keychain; tests and UI-test launches use `InMemorySecureStore`.
/// Never back this with UserDefaults: UserDefaults is a plain plist inside
/// the app container, included in unencrypted backups.
public protocol SecureStore: AnyObject, Sendable {
    func string(for key: String) -> String?
    func set(_ value: String, for key: String) throws
    func remove(_ key: String)
    func removeAll()
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

/// Generic-password Keychain items under one service name.
///
/// - Accessibility `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
///   readable by background work after the first unlock following a reboot
///   (needed for refresh while a push/background task runs), never
///   migrated to another device. Device-to-device transfer and restores to a
///   different device do NOT carry these items; an encrypted backup restored
///   to the SAME device does.
/// - `kSecAttrSynchronizable = false`: never synced through iCloud Keychain.
/// - No access group: the app's default group only (no keychain sharing).
public final class KeychainStore: SecureStore, @unchecked Sendable {
    public let service: String

    public init(service: String) {
        self.service = service
    }

    private func baseQuery(_ key: String? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if let key { query[kSecAttrAccount as String] = key }
        return query
    }

    public func string(for key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        // Any failure (including errSecInteractionNotAllowed before first
        // unlock) reads as "absent": the caller then treats the session as
        // missing, which fails closed (sign-in required).
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func set(_ value: String, for key: String) throws {
        let data = Data(value.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery(key) as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw KeychainError(status: updateStatus) }
        var insert = baseQuery(key)
        insert.merge(attributes) { _, new in new }
        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
    }

    public func remove(_ key: String) {
        SecItemDelete(baseQuery(key) as CFDictionary)
    }

    public func removeAll() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}

/// Process-memory store for unit tests and UI-test launches. Never used by
/// a Release build's live environment.
public final class InMemorySecureStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    public init(_ initial: [String: String] = [:]) {
        values = initial
    }

    public func string(for key: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return values[key]
    }

    public func set(_ value: String, for key: String) throws {
        lock.lock(); defer { lock.unlock() }
        values[key] = value
    }

    public func remove(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        values[key] = nil
    }

    public func removeAll() {
        lock.lock(); defer { lock.unlock() }
        values.removeAll()
    }

    public var snapshot: [String: String] {
        lock.lock(); defer { lock.unlock() }
        return values
    }
}

/// Session credentials. Key names match the Flutter app's for reviewers'
/// convenience only — the two apps never share storage.
public final class TokenStore: Sendable {
    static let accessTokenKey = "rab.accessToken"
    static let refreshTokenKey = "rab.refreshToken"
    static let sessionUserIdKey = "rab.sessionUserId"

    private let backing: any SecureStore

    public init(store: any SecureStore) {
        self.backing = store
    }

    public func accessToken() -> String? { backing.string(for: Self.accessTokenKey) }
    public func refreshToken() -> String? { backing.string(for: Self.refreshTokenKey) }
    public func sessionUserId() -> String? { backing.string(for: Self.sessionUserIdKey) }
    public var hasSession: Bool { accessToken() != nil || refreshToken() != nil }

    /// CF-19: the rotated refresh token is persisted FIRST. If the app dies
    /// between the two writes, the stored refresh token is still the live one
    /// (a stale access token only costs one more refresh). The opposite order
    /// could leave an already-rotated refresh token behind; presenting it
    /// again is reuse and revokes the whole session family.
    public func store(accessToken: String, refreshToken: String) throws {
        try backing.set(refreshToken, for: Self.refreshTokenKey)
        try backing.set(accessToken, for: Self.accessTokenKey)
    }

    public func setSessionUserId(_ id: String) throws {
        try backing.set(id, for: Self.sessionUserIdKey)
    }

    public func clear() {
        backing.remove(Self.sessionUserIdKey)
        backing.remove(Self.accessTokenKey)
        backing.remove(Self.refreshTokenKey)
    }
}

/// The Keychain survives an app uninstall; UserDefaults does not. On the
/// first launch of a fresh install, wipe any Keychain items left by a
/// previous install so an old session can never resume silently.
public enum FreshInstallGuard {
    static let markerKey = "crewflow.installMarker.v1"

    public static func run(defaults: UserDefaults = .standard, stores: [any SecureStore]) {
        guard !defaults.bool(forKey: markerKey) else { return }
        stores.forEach { $0.removeAll() }
        defaults.set(true, forKey: markerKey)
    }
}

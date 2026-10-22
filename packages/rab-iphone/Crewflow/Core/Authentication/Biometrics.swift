import Foundation
import LocalAuthentication

/// Maximum biometric trust lifetime, measured from the last PASSWORD
/// authentication (Flutter `biometricFullReauthDays`, MOB-01/MOB-02).
public let biometricFullReauthDays = 90

public enum BiometricKind: Equatable, Sendable {
    case faceID
    case touchID
    case opticID
    case none
}

public struct BiometricCapability: Equatable, Sendable {
    public let hasHardware: Bool
    public let isEnrolled: Bool
    public let kind: BiometricKind

    /// Hardware AND enrolment are both required before any biometric UI is
    /// offered (a sensor with nothing enrolled must never surface it).
    public var isAvailable: Bool { hasHardware && isEnrolled }

    public static let unavailable = BiometricCapability(hasHardware: false, isEnrolled: false, kind: .none)

    /// The one place the product decides what to call the biometric.
    public var label: String {
        switch kind {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        case .none: return "Biometric Login"
        }
    }

    public var systemImage: String {
        switch kind {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        case .none: return "lock.shield"
        }
    }
}

public enum BiometricOutcome: Equatable, Sendable {
    case success
    case cancelled
    case failed
    case lockedOut
    case notAvailable
    case error
}

/// Injectable seam over LocalAuthentication.
public protocol BiometricAuthenticating: Sendable {
    func capability() async -> BiometricCapability
    func authenticate(reason: String) async -> BiometricOutcome
}

/// Biometric-only (no device-passcode fallback, Flutter `biometricOnly: true`).
/// A LOCAL presence gate only: it never produces or unlocks a credential.
/// The server's answer to `/auth/me` is what actually decides access.
public struct LocalBiometricAuthenticator: BiometricAuthenticating {
    public init() {}

    public func capability() async -> BiometricCapability {
        let context = LAContext()
        var error: NSError?
        let canEvaluate = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let kind = Self.kind(of: context)
        if canEvaluate {
            return BiometricCapability(hasHardware: true, isEnrolled: true, kind: kind)
        }
        guard let nsError = error, let code = LAError.Code(rawValue: nsError.code) else {
            return .unavailable
        }
        switch code {
        case .biometryNotEnrolled:
            return BiometricCapability(hasHardware: true, isEnrolled: false, kind: kind)
        case .biometryLockout:
            // Enrolled hardware, temporarily locked: still "available" so the
            // lock screen can explain the lockout instead of hiding.
            return BiometricCapability(hasHardware: true, isEnrolled: true, kind: kind)
        default:
            return BiometricCapability(hasHardware: false, isEnrolled: false, kind: kind)
        }
    }

    public func authenticate(reason: String) async -> BiometricOutcome {
        let context = LAContext()
        context.localizedFallbackTitle = "" // hide "Enter Password": biometric only
        do {
            let success = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            return success ? .success : .failed
        } catch let error as LAError {
            switch error.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback:
                return .cancelled
            case .biometryLockout:
                return .lockedOut
            case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet:
                return .notAvailable
            case .authenticationFailed:
                return .failed
            default:
                return .error
            }
        } catch {
            return .error
        }
    }

    private static func kind(of context: LAContext) -> BiometricKind {
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .none: return .none
        @unknown default:
            // Newer SDK cases (e.g. Optic ID on visionOS) fall back to the
            // generic label; the system prompt still names the real sensor.
            return .none
        }
    }
}

/// Remembered identity and the account-owned biometric preference. Not a
/// session: tokens and session ownership live in `TokenStore`. No biometric
/// data and no password is ever stored. Port of Flutter `BiometricStore`.
public final class BiometricStore: Sendable {
    static let enabledUserIdKey = "rab.biometric.enabledUserId"
    static let lastFullAuthenticationAtKey = "rab.biometric.lastFullAuthenticationAt"
    static let rememberedAccountKey = "rab.biometric.rememberedAccount"
    static let confirmedAtKey = "rab.biometric.confirmedAt"

    public struct RememberedAccount: Codable, Equatable, Sendable {
        public let userId: String
        public let email: String
    }

    private let backing: any SecureStore

    public init(store: any SecureStore) {
        self.backing = store
    }

    public func rememberedAccount() -> RememberedAccount? {
        guard let raw = backing.string(for: Self.rememberedAccountKey),
              let account = try? JSONDecoder().decode(RememberedAccount.self, from: Data(raw.utf8)),
              !account.userId.isEmpty, !account.email.isEmpty
        else { return nil }
        return account
    }

    public func setRememberedAccount(userId: String, email: String) throws {
        let data = try JSONEncoder().encode(RememberedAccount(userId: userId, email: email))
        try backing.set(String(decoding: data, as: UTF8.self), for: Self.rememberedAccountKey)
    }

    public func clearRememberedAccount() {
        backing.remove(Self.rememberedAccountKey)
    }

    public func confirmedAt() -> Date? {
        backing.string(for: Self.confirmedAtKey).flatMap(ISO8601.date(from:))
    }

    /// Removes the previous owner's binding before assigning a new owner.
    public func confirmBiometric(userId: String, at date: Date) throws {
        clearEnabledUserId()
        try backing.set(ISO8601.string(from: date), for: Self.confirmedAtKey)
        try backing.set(userId, for: Self.enabledUserIdKey)
    }

    public func enabledUserId() -> String? {
        backing.string(for: Self.enabledUserIdKey)
    }

    public func clearEnabledUserId() {
        backing.remove(Self.enabledUserIdKey)
        backing.remove(Self.confirmedAtKey)
    }

    public func lastFullAuthenticationAt() -> Date? {
        backing.string(for: Self.lastFullAuthenticationAtKey).flatMap(ISO8601.date(from:))
    }

    public func setLastFullAuthenticationAt(_ date: Date) throws {
        try backing.set(ISO8601.string(from: date), for: Self.lastFullAuthenticationAtKey)
    }
}

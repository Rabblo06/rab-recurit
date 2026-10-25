import Foundation

/// Account security step 1: the second-factor sign-in contract
/// (docs/account-security/STEP1_REPORT.md, server `AuthService.completeLogin`
/// and `MfaLoginService`). The one place the app reads its codes.
///
/// - `POST /auth/login` (or any sign-in) for an enrolled account answers
///   `409 {code: SECOND_FACTOR_REQUIRED, requirement, challengeToken,
///   challengeExpiresAt, message}`. NOTHING is issued: no token, no session.
/// - `POST /auth/mfa/challenge/verify {challengeToken, code}` (code = the
///   6-digit TOTP or a recovery code) answers the normal mobile login body.
/// - Failures: 401 `MFA_CODE_INVALID {attemptsRemaining}` (the server's true
///   count; 0 = the next attempt is refused), 401 `MFA_CHALLENGE_EXPIRED`
///   (one body for unknown, lapsed, used or other-transport tokens), 401
///   `MFA_CHALLENGE_EXHAUSTED`, 429 `MFA_RATE_LIMITED` (+ Retry-After).
/// - A mobile sign-in WITHOUT `X-Client-Capabilities: mfa-verify` gets
///   `409 CLIENT_UPDATE_REQUIRED {message}` instead of a challenge.
public enum SecondFactorContract {
    public static let challengeRequiredCode = "SECOND_FACTOR_REQUIRED"
    public static let clientUpdateRequiredCode = "CLIENT_UPDATE_REQUIRED"
    public static let codeInvalidCode = "MFA_CODE_INVALID"
    public static let challengeExpiredCode = "MFA_CHALLENGE_EXPIRED"
    public static let challengeExhaustedCode = "MFA_CHALLENGE_EXHAUSTED"
    public static let rateLimitedCode = "MFA_RATE_LIMITED"
    /// The only requirement this build completes. `enroll` (an enforced role
    /// without a factor; dormant while every AUTH_MFA_ENFORCE_* flag is off)
    /// is set up on the web.
    public static let verifyRequirement = "verify"

    static let verifyPath = "/auth/mfa/challenge/verify"
    static let cancelPath = "/auth/mfa/challenge/cancel"
}

/// A pending sign-in that needs the second factor. Lives in memory only and
/// is never written to the Keychain, UserDefaults or a log: the token is a
/// short-lived, single-use bearer for THIS sign-in.
public struct SecondFactorChallenge: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let token: String
    public let expiresAt: Date?
    /// What the person typed on the sign-in screen (the account chip). Not
    /// sent anywhere by this type.
    public let email: String

    init(token: String, expiresAt: Date?, email: String) {
        self.token = token
        self.expiresAt = expiresAt
        self.email = email
    }

    public var description: String { "SecondFactorChallenge(token: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["token": "<redacted>", "expiresAt": expiresAt as Any], displayStyle: .struct)
    }
}

/// `409 CLIENT_UPDATE_REQUIRED`. The store button only exists for an
/// allowlisted HTTPS App Store URL the server sends (none today: there is no
/// store listing yet), never a guessed one.
public struct ClientUpdateRequired: Equatable, Sendable, Identifiable {
    public static let defaultMessage = "Your account uses two-factor authentication. Update Crewflow to enter your verification code and continue."
    static let allowlistedStoreHosts: Set<String> = ["apps.apple.com"]

    public let message: String
    public let updateURL: URL?
    public var id: String { message + "|" + (updateURL?.absoluteString ?? "") }

    public init(message: String, updateURL: URL?) {
        self.message = message
        self.updateURL = updateURL
    }

    init(payload: ServerErrorPayload) {
        self.message = payload.userFacingMessage ?? Self.defaultMessage
        self.updateURL = Self.allowlistedStoreURL(payload.body?["updateUrl"]?.stringValue)
    }

    /// HTTPS, an Apple App Store host, no credentials in the URL. Anything
    /// else is dropped (an error body must never be able to send the person
    /// to an arbitrary site).
    static func allowlistedStoreURL(_ raw: String?) -> URL? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "https",
              let host = components.host?.lowercased(), allowlistedStoreHosts.contains(host),
              components.user == nil, components.password == nil, components.port == nil,
              let url = components.url
        else { return nil }
        return url
    }
}

/// What `SessionCoordinator.login` ended with when it did not throw.
public enum SignInOutcome: Equatable, Sendable {
    /// Tokens stored, `/auth/me` loaded, phase moved on.
    case signedIn
    /// Phase is now `.secondFactor`; nothing was stored.
    case secondFactorRequired
    /// This build cannot finish the sign-in; nothing was stored.
    case updateRequired(ClientUpdateRequired)
    /// The account must SET UP 2FA before signing in (an enforcement flag).
    /// Not completed in this build; the challenge was cancelled.
    case enrolmentRequired(message: String)
    /// A logout or another sign-in replaced this one while it was in flight.
    case superseded
}

/// Which kind of code the person entered.
public enum SecondFactorMethod: Equatable, Sendable {
    case authenticatorCode
    case recoveryCode
}

/// Why a verification did not sign the person in. Every case is mapped from
/// a server answer; nothing is counted or timed on the client.
public enum SecondFactorFailure: Equatable, Sendable {
    /// `MFA_CODE_INVALID`. `attemptsRemaining` only when the server sent it.
    case invalidCode(attemptsRemaining: Int?)
    /// `MFA_CHALLENGE_EXPIRED` (or any 401 the challenge cannot survive).
    case expired
    /// `MFA_CHALLENGE_EXHAUSTED`, or `attemptsRemaining == 0`.
    case locked
    /// 429 (`MFA_RATE_LIMITED` or the IP throttle): a cooldown, not a restart.
    case rateLimited(message: String)
    /// Offline, timeout or 5xx: the outcome is unknown. Nothing is resent;
    /// the person may try again (a used challenge then reads as expired).
    case connection(message: String)
    /// Any other refusal (validation, wrong step).
    case rejected(message: String)
    /// The code was accepted and the session issued, but loading the account
    /// failed, so the local session was wiped. The challenge is used up.
    case signInIncomplete(message: String)

    /// The challenge can no longer be used: the person must start again.
    public var endsChallenge: Bool {
        switch self {
        case .expired, .locked, .signInIncomplete: return true
        case .invalidCode, .rateLimited, .connection, .rejected: return false
        }
    }

    static let connectionMessage = "We couldn’t confirm your code. Check your connection and try again."

    static func from(_ error: Error) -> SecondFactorFailure {
        guard let apiError = error as? APIError else { return .connection(message: connectionMessage) }
        switch apiError {
        case .rateLimited(_, let message):
            return .rateLimited(message: message)
        case .offline, .timeout, .server, .cancelled, .sessionChanged:
            return .connection(message: connectionMessage)
        default:
            break
        }
        switch apiError.code {
        case SecondFactorContract.codeInvalidCode:
            let remaining = apiError.payload?.body?["attemptsRemaining"]?.intValue.map { max(0, $0) }
            if remaining == 0 { return .locked }
            return .invalidCode(attemptsRemaining: remaining)
        case SecondFactorContract.challengeExpiredCode:
            return .expired
        case SecondFactorContract.challengeExhaustedCode:
            return .locked
        default:
            // A 401 the client cannot attribute: the challenge is unusable.
            if case .unauthorized = apiError { return .expired }
            return .rejected(message: apiError.userMessage)
        }
    }
}

public enum SecondFactorVerifyResult: Equatable, Sendable {
    case signedIn
    case failed(SecondFactorFailure)
    /// Not attempted (no live challenge, a check already in flight) or
    /// superseded while in flight. Nothing to show.
    case ignored
}

/// A 409 from a sign-in call that is not an error but the next step.
enum SignInInterruption: Equatable {
    case secondFactor(requirement: String, token: String, expiresAt: Date?, message: String?)
    case updateRequired(ClientUpdateRequired)

    /// nil when `error` is not one of the two 409s. Throws when the server
    /// asked for a second factor without a usable challenge token.
    static func from(_ error: Error) throws -> SignInInterruption? {
        guard case .conflict(let payload)? = error as? APIError else { return nil }
        switch payload.code {
        case SecondFactorContract.challengeRequiredCode:
            guard let token = payload.body?["challengeToken"]?.stringValue, !token.isEmpty, token.count <= 128 else {
                throw APIError.decoding("SecondFactorChallenge")
            }
            let requirement = payload.body?["requirement"]?.stringValue ?? SecondFactorContract.verifyRequirement
            let expiresAt = payload.body?["challengeExpiresAt"]?.stringValue.flatMap(ISO8601.date(from:))
            return .secondFactor(requirement: requirement, token: token, expiresAt: expiresAt, message: payload.userFacingMessage)
        case SecondFactorContract.clientUpdateRequiredCode:
            return .updateRequired(ClientUpdateRequired(payload: payload))
        default:
            return nil
        }
    }
}

struct SecondFactorVerifyBody: Encodable {
    let challengeToken: String
    let code: String
}

struct SecondFactorChallengeBody: Encodable {
    let challengeToken: String
}

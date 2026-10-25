import Foundation

/// `GET /auth/mfa` (`MfaManagementService.status`). Fields added by account
/// security step 1 decode tolerantly so an older server still loads; every
/// default fails closed (no "Turn on" offered when availability is unknown).
struct TwoFactorStatus: Decodable, Equatable {
    /// Client constant, as in the Flutter and web clients (UI_PLAN §2):
    /// "low" at this many remaining codes or fewer.
    static let lowRecoveryCodesThreshold = 3

    let enabled: Bool
    let enabledAt: Date?
    let recoveryCodesRemaining: Int
    /// Size of a full set (10) while enabled, 0 while off; nil from a server
    /// that predates the field (then the UI shows "N left" without "of T").
    let recoveryCodesTotal: Int?
    /// An enforcement flag applies: 2FA cannot be turned off.
    let enforced: Bool
    /// New enrolments are allowed by this deployment.
    let enrolmentAvailable: Bool
    /// Whether "Current password" can be asked. False = SSO-only account.
    let hasPassword: Bool
    let ssoReauthProviders: [String]

    enum CodingKeys: String, CodingKey {
        case enabled, enabledAt, recoveryCodesRemaining, recoveryCodesTotal, enforced
        case enrolmentAvailable, hasPassword, ssoReauthProviders
    }

    init(
        enabled: Bool,
        enabledAt: Date? = nil,
        recoveryCodesRemaining: Int = 0,
        recoveryCodesTotal: Int? = nil,
        enforced: Bool = false,
        enrolmentAvailable: Bool = false,
        hasPassword: Bool = true,
        ssoReauthProviders: [String] = []
    ) {
        self.enabled = enabled
        self.enabledAt = enabledAt
        self.recoveryCodesRemaining = recoveryCodesRemaining
        self.recoveryCodesTotal = recoveryCodesTotal
        self.enforced = enforced
        self.enrolmentAvailable = enrolmentAvailable
        self.hasPassword = hasPassword
        self.ssoReauthProviders = ssoReauthProviders
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        enabledAt = try? c.decodeIfPresent(Date.self, forKey: .enabledAt)
        let remaining = try c.decodeIfPresent(Int.self, forKey: .recoveryCodesRemaining) ?? 0
        recoveryCodesRemaining = max(0, remaining)
        recoveryCodesTotal = try c.decodeIfPresent(Int.self, forKey: .recoveryCodesTotal)
        enforced = try c.decodeIfPresent(Bool.self, forKey: .enforced) ?? false
        enrolmentAvailable = try c.decodeIfPresent(Bool.self, forKey: .enrolmentAvailable) ?? false
        // Unknown → ask for the password: the server still decides.
        hasPassword = try c.decodeIfPresent(Bool.self, forKey: .hasPassword) ?? true
        ssoReauthProviders = (try? c.decodeIfPresent([String].self, forKey: .ssoReauthProviders)) ?? []
    }

    var recoveryCodesLow: Bool {
        enabled && recoveryCodesRemaining <= Self.lowRecoveryCodesThreshold
    }

    /// "8 of 10 left" (or "8 left" without a server total).
    var recoveryCodesSummary: String {
        if let total = recoveryCodesTotal, total > 0 {
            return "\(recoveryCodesRemaining) of \(total) left"
        }
        return "\(recoveryCodesRemaining) left"
    }

    /// The low-codes warning, with the real count.
    var lowCodesWarning: String {
        switch recoveryCodesRemaining {
        case 0: return "No recovery codes left. Save a new set to keep access to your account."
        case 1: return "Only 1 recovery code left. Save a new set to keep access to your account."
        default: return "Only \(recoveryCodesRemaining) recovery codes left. Save a new set to keep access to your account."
        }
    }
}

/// `POST /auth/mfa/enrolment`. `qrDataUrl` is not decoded: the phone hands
/// the `otpauth://` link to an authenticator on the same device (design).
struct TwoFactorEnrolmentMaterial: Decodable, Equatable {
    let otpauthUri: String
    let manualKey: String
}

struct RecoveryCodesResponse: Decodable, Equatable {
    let recoveryCodes: [String]
}

/// What the setup screen shows from the enrolment material.
struct TwoFactorEnrolmentDetails: Equatable {
    let manualKey: String
    /// Only a well-formed `otpauth://totp/…` link is ever opened.
    let otpauthURL: URL?
    let accountName: String?

    init(_ material: TwoFactorEnrolmentMaterial) {
        manualKey = material.manualKey
        let parsed = OTPAuthURI.parse(material.otpauthUri)
        otpauthURL = parsed?.url
        accountName = parsed?.accountName
    }
}

/// `otpauth://totp/<issuer>:<account>?secret=…&issuer=…` (server
/// `totpProvisioningUri`). Never logged: it contains the secret.
enum OTPAuthURI {
    struct Parsed: Equatable {
        let url: URL
        let issuer: String?
        let accountName: String?
    }

    static func parse(_ raw: String) -> Parsed? {
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "otpauth",
              components.host?.lowercased() == "totp",
              let secret = components.queryItems?.first(where: { $0.name == "secret" })?.value, !secret.isEmpty,
              let url = components.url
        else { return nil }
        // `path` is percent-decoded: "/Crewflow:sam@example.com".
        let label = String(components.path.drop(while: { $0 == "/" }))
        let queryIssuer = components.queryItems?.first(where: { $0.name == "issuer" })?.value
        var issuer = queryIssuer
        var account: String? = label.isEmpty ? nil : label
        if let colon = label.firstIndex(of: ":") {
            let prefix = String(label[..<colon]).trimmingCharacters(in: .whitespaces)
            let rest = String(label[label.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            issuer = issuer ?? (prefix.isEmpty ? nil : prefix)
            account = rest.isEmpty ? nil : rest
        }
        return Parsed(url: url, issuer: issuer, accountName: account)
    }
}

private struct CurrentPasswordBody: Encodable {
    let currentPassword: String?
}

private struct CodeBody: Encodable {
    let code: String
}

private struct ProofBody: Encodable {
    let currentPassword: String?
    let code: String
}

/// The signed-in account's own 2FA routes (`MfaController`, reachable from
/// both mobile apps since account security step 1). Every mutation uses the
/// default `RetryPolicy.never`: a code is single-use and the server counts
/// every attempt; an uncertain outcome reloads the status instead.
struct TwoFactorAPI {
    let api: APIClient

    func status() async throws -> TwoFactorStatus {
        try await api.get("/auth/mfa", as: TwoFactorStatus.self)
    }

    /// Stages a fresh server-generated secret. Proof = the current password
    /// (an SSO-only account cannot prove itself from the phone).
    func startEnrolment(currentPassword: String?) async throws -> TwoFactorEnrolmentMaterial {
        try await api.post("/auth/mfa/enrolment", body: CurrentPasswordBody(currentPassword: currentPassword), as: TwoFactorEnrolmentMaterial.self)
    }

    /// The first authenticator code. The clear recovery codes come back once.
    func confirmEnrolment(code: String) async throws -> [String] {
        try await api.post("/auth/mfa/enrolment/confirm", body: CodeBody(code: code), as: RecoveryCodesResponse.self).recoveryCodes
    }

    func regenerateRecoveryCodes(currentPassword: String?, code: String) async throws -> [String] {
        try await api.post("/auth/mfa/recovery-codes", body: ProofBody(currentPassword: currentPassword, code: code), as: RecoveryCodesResponse.self).recoveryCodes
    }

    /// 204.
    func disable(currentPassword: String?, code: String) async throws {
        try await api.post("/auth/mfa/disable", body: ProofBody(currentPassword: currentPassword, code: code))
    }
}

/// Words for the self-service failures (server codes from
/// `MfaManagementService` / `StepUpReauthService`).
enum TwoFactorErrorText {
    static let wrongPassword = "That password didn’t work. Check it and try again."
    static let wrongCode = "That code didn’t work. Check your authenticator app and try again."
    static let wrongProofCode = "That code didn’t work. Enter the current code from your authenticator app, or a recovery code."
    static let uncertain = "We couldn’t confirm this with Crewflow. Check your connection and try again."
    static let ssoOnly = "Your account signs in with Google or Microsoft. Confirming it’s you that way is only available in Crewflow on the web, so manage two-factor authentication there."

    static func message(for error: Error) -> String {
        guard let apiError = error as? APIError else { return uncertain }
        if apiError.isUncertainOutcome { return uncertain }
        switch apiError.code {
        case "MFA_CODE_INVALID":
            // 401 today; the owner-approved server change answers 400 with the
            // same code. Matched by `code`, never by status, and never a
            // session expiry (no refresh, no replay either way).
            return wrongCode
        case "STEP_UP_MFA_INVALID":
            return wrongProofCode
        case "STEP_UP_REQUIRED":
            return "Enter your current password to continue."
        default:
            break
        }
        // A wrong password is a 403 with no code ("Re-enter your current
        // password to continue.").
        if case .forbidden(let payload) = apiError, payload.code == nil {
            return wrongPassword
        }
        return apiError.userMessage
    }
}

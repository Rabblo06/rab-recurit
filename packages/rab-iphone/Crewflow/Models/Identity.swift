import Foundation

/// Which shell the app shows. Presentation only: every API still enforces
/// authorisation independently, server-side, on every request.
public enum AppPresentation: String, Sendable, Equatable, CaseIterable {
    case staff
    case venueManager
    case manager
    case admin
    case unsupported
}

/// The session's application target as the server recorded it. Unknown
/// future values are kept verbatim rather than failing the decode.
public enum ApplicationTarget: Equatable, Sendable, Codable {
    case staffApp
    case venueManagerApp
    case managerWeb
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "staff_app": self = .staffApp
        case "venue_manager_app": self = .venueManagerApp
        case "manager_web": self = .managerWeb
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .staffApp: return "staff_app"
        case .venueManagerApp: return "venue_manager_app"
        case .managerWeb: return "manager_web"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `GET /auth/me` — mirrors `AuthService.me()`
/// (packages/rab-server/src/engine/core-modules/auth/services/auth.service.ts).
/// Routing derives from THIS server-verified identity, never from JWT claims.
public struct CurrentUser: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let email: String
    public let firstName: String
    public let lastName: String
    public let organisationId: String
    public let roles: [String]
    public let mustResetPassword: Bool
    public let isPlatformAdmin: Bool
    /// Present on current servers; optional so an older server still decodes.
    public let sessionId: String?
    public let applicationTarget: ApplicationTarget?
    public let sessionExpiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, email, firstName, lastName, organisationId, roles
        case mustResetPassword, isPlatformAdmin, sessionId, applicationTarget, sessionExpiresAt
    }

    public init(
        id: String,
        email: String,
        firstName: String,
        lastName: String,
        organisationId: String,
        roles: [String],
        mustResetPassword: Bool = false,
        isPlatformAdmin: Bool = false,
        sessionId: String? = nil,
        applicationTarget: ApplicationTarget? = nil,
        sessionExpiresAt: Date? = nil
    ) {
        self.id = id
        self.email = email
        self.firstName = firstName
        self.lastName = lastName
        self.organisationId = organisationId
        self.roles = roles
        self.mustResetPassword = mustResetPassword
        self.isPlatformAdmin = isPlatformAdmin
        self.sessionId = sessionId
        self.applicationTarget = applicationTarget
        self.sessionExpiresAt = sessionExpiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = try c.decode(String.self, forKey: .email)
        firstName = try c.decode(String.self, forKey: .firstName)
        lastName = try c.decode(String.self, forKey: .lastName)
        organisationId = try c.decode(String.self, forKey: .organisationId)
        roles = try c.decode([String].self, forKey: .roles)
        // Same defaults as Flutter's CurrentUser.fromJson.
        mustResetPassword = try c.decodeIfPresent(Bool.self, forKey: .mustResetPassword) ?? false
        isPlatformAdmin = try c.decodeIfPresent(Bool.self, forKey: .isPlatformAdmin) ?? false
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        applicationTarget = try c.decodeIfPresent(ApplicationTarget.self, forKey: .applicationTarget)
        // Display metadata only (never authority): tolerate an unparseable value.
        sessionExpiresAt = try? c.decodeIfPresent(Date.self, forKey: .sessionExpiresAt)
    }

    public var fullName: String { "\(firstName) \(lastName)" }

    /// Identical rules to Flutter's `CurrentUser.presentation`: platform
    /// admin first; venue_manager wins over every other role (matches the
    /// backend's more restrictive mixed-role resource scope); then
    /// manager/ceo; then staff; anything else (including roles this build
    /// does not know) is unsupported.
    public var presentation: AppPresentation {
        if isPlatformAdmin { return .admin }
        if roles.contains("venue_manager") { return .venueManager }
        if roles.contains("manager") || roles.contains("ceo") { return .manager }
        if roles.contains("staff") { return .staff }
        return .unsupported
    }
}

/// A permission flag name as the server spells it
/// (packages/rab-shared/src/constants/permission-flags.ts).
public struct PermissionFlag: RawRepresentable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }

    public static let staffView: PermissionFlag = "staff.view"
    public static let staffCreate: PermissionFlag = "staff.create"
    public static let staffDeactivate: PermissionFlag = "staff.deactivate"
    public static let scheduleView: PermissionFlag = "schedule.view"
    public static let venueView: PermissionFlag = "venue.view"
    public static let venueManagerCreate: PermissionFlag = "venue_manager.create"
    public static let offerSend: PermissionFlag = "offer.send"
    public static let reportView: PermissionFlag = "report.view"
    public static let reportExport: PermissionFlag = "report.export"
    public static let staffingRequestCreate: PermissionFlag = "staffing_request.create"
    public static let attendanceView: PermissionFlag = "attendance.view"
    public static let attendanceEdit: PermissionFlag = "attendance.edit"
    public static let reviewCreate: PermissionFlag = "review.create"
    public static let payrollView: PermissionFlag = "payroll.view"
    public static let payrollApprove: PermissionFlag = "payroll.approve"
    public static let payrollCalculate: PermissionFlag = "payroll.calculate"
    public static let payrollMarkPaid: PermissionFlag = "payroll.mark_paid"
}

/// `GET /auth/capabilities` — `{ "<flag>": true|false, ... }`.
///
/// DISPLAY HINTS ONLY (which buttons to show). Every action is enforced
/// server-side by its own route guard, service check and RLS. Unknown or
/// non-boolean entries read as false; a failed load is `.none` (fail closed:
/// show nothing the server has not confirmed).
public struct Capabilities: Decodable, Equatable, Sendable {
    public let flags: [String: Bool]

    public static let none = Capabilities(flags: [:])

    public init(flags: [String: Bool]) {
        self.flags = flags
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicCodingKey.self)
        var flags: [String: Bool] = [:]
        for key in container.allKeys {
            flags[key.stringValue] = (try? container.decode(Bool.self, forKey: key)) ?? false
        }
        self.flags = flags
    }

    public func allows(_ flag: PermissionFlag) -> Bool {
        flags[flag.rawValue] == true
    }
}

/// `POST /auth/refresh` (mobile shape: tokens in the JSON body).
public struct AuthTokensResponse: Decodable, Equatable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let refreshExpiresAt: Date?
    public let sessionExpiresAt: Date?
}

/// `POST /auth/login` (mobile shape). `mustResetPassword` is re-read from
/// `/auth/me` anyway, which `MustResetPasswordGuard` always exempts.
public struct LoginResponse: Decodable, Equatable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let refreshExpiresAt: Date?
    public let sessionExpiresAt: Date?
    public let mustResetPassword: Bool?
}

/// `POST /auth/login` body. No `applicationTarget` and no
/// `X-Application-Target` header — exactly like the Flutter app: for a
/// mobile caller the server derives the target from the account's real
/// roles (`venue_manager_app` when the user holds `venue_manager`, else
/// `staff_app`). No `organisationId` either: the server resolves it.
struct LoginRequestBody: Encodable {
    let email: String
    let password: String
}

struct EmailBody: Encodable {
    let email: String
}

struct NewPasswordBody: Encodable {
    let newPassword: String
}

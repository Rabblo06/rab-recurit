import Foundation

/// User-facing failure texts. The ONE place API failures become words on
/// screen; identical to the Flutter app's `ApiMessages`
/// (packages/rab-mobile/lib/core/api/api_client.dart).
public enum APIMessages {
    public static let offline = "Connection lost. Check your internet connection."
    public static let timeout = "The connection timed out. Check your connection and try again."
    public static let sessionExpired = "Your session has expired. Please sign in again."
    public static let sessionChanged = "Your session changed while this was loading. Please try again."
    public static let forbidden = "You don't have permission to do that."
    public static let notFound = "This item could not be found. It may have been removed."
    public static let conflict = "This has changed since it was loaded. Refresh and try again."
    public static let tooManyRequests = "Too many requests. Please wait a moment and try again."
    public static let serverError = "Something went wrong. Please try again."
    /// `_extractMessage`'s fallback when an error body carries no message.
    static let genericBody = "Something went wrong. Please try again."
}

/// What the server said about a failed request: NestJS's
/// `{message, error, statusCode}` body (message may be a string or a
/// class-validator string array), a structured `{code, message, ...}` body,
/// or a bare JSON string (the throttler).
public struct ServerErrorPayload: Equatable, Sendable {
    /// The single message Flutter's `_extractMessage` would pick.
    public let message: String
    /// Structured error `code` (e.g. `CLOCK_IN_TOO_EARLY`), when sent.
    public let code: String?
    /// Every message for a validation (array) body; `[message]` otherwise.
    public let messages: [String]
    /// The decoded JSON object, when the body was one (lets a feature read
    /// fields such as `availableAt` next to `code`).
    public let body: [String: JSONValue]?

    public init(message: String, code: String? = nil, messages: [String]? = nil, body: [String: JSONValue]? = nil) {
        self.message = message
        self.code = code
        self.messages = messages ?? [message]
        self.body = body
    }

    /// The server's own text when it reads as user-facing, else nil.
    public var userFacingMessage: String? {
        UserFacingText.isUserFacing(message) ? message.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    /// Parses a raw error body exactly like Flutter's `_extractMessage` +
    /// `_tryDecodeBody`.
    public static func parse(_ data: Data) -> ServerErrorPayload {
        guard !data.isEmpty, let value = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            return ServerErrorPayload(message: APIMessages.genericBody)
        }
        switch value {
        case .object(let object):
            let code = object["code"]?.stringValue
            switch object["message"] {
            case .array(let items) where !items.isEmpty:
                let texts = items.map(\.displayText)
                return ServerErrorPayload(message: texts[0], code: code, messages: texts, body: object)
            case .some(let message) where message != .null:
                return ServerErrorPayload(message: message.displayText, code: code, body: object)
            default:
                return ServerErrorPayload(message: APIMessages.genericBody, code: code, body: object)
            }
        case .string(let text) where !text.isEmpty:
            return ServerErrorPayload(message: text)
        default:
            return ServerErrorPayload(message: APIMessages.genericBody)
        }
    }
}

/// Every failure the networking layer surfaces. Transport errors
/// (`URLError`) are converted at the boundary, so features only ever handle
/// this type (plus their own domain errors).
public enum APIError: Error, Equatable, Sendable {
    /// 401. `message` is client-authored when the session ended.
    case unauthorized(message: String)
    /// 403 — exists, but the caller categorically lacks the permission.
    case forbidden(ServerErrorPayload)
    /// 404 — also what the server answers for another tenant's record.
    case notFound(ServerErrorPayload)
    /// 409 — `code` carries the domain reason (e.g. `INVALID_TRANSITION`).
    case conflict(ServerErrorPayload)
    /// 400 / 422 — class-validator rejections; `messages` lists every field error.
    case validation(status: Int, ServerErrorPayload)
    /// 429 — `message` is client-authored from `Retry-After`.
    case rateLimited(retryAfterSeconds: Int, message: String)
    /// 5xx — server text is never shown.
    case server(status: Int)
    /// Any other 3xx/4xx status.
    case http(status: Int, ServerErrorPayload)
    /// No connectivity, DNS, TLS or socket failure.
    case offline
    /// Request exceeded its deadline. Never ends the session.
    case timeout(message: String)
    /// The response could not be decoded into the expected type.
    case decoding(String)
    /// The identity this request was sent under was signed out (or replaced)
    /// before the response arrived: the response was dropped.
    case sessionChanged
    /// The request was cancelled (logout, view disappeared). Never shown.
    case cancelled
    /// A programming error building the request (e.g. a path without a
    /// leading slash). Never sent.
    case invalidRequest(String)

    public static var defaultTimeout: APIError { .timeout(message: APIMessages.timeout) }

    /// The HTTP status, or 0 for transport-level failures.
    public var statusCode: Int {
        switch self {
        case .unauthorized, .sessionChanged: return 401
        case .forbidden: return 403
        case .notFound: return 404
        case .conflict: return 409
        case .validation(let status, _): return status
        case .rateLimited: return 429
        case .server(let status): return status
        case .http(let status, _): return status
        case .timeout: return 408
        case .offline, .decoding, .cancelled, .invalidRequest: return 0
        }
    }

    public var payload: ServerErrorPayload? {
        switch self {
        case .forbidden(let p), .notFound(let p), .conflict(let p), .validation(_, let p), .http(_, let p): return p
        default: return nil
        }
    }

    /// Structured server error code, when one was sent.
    public var code: String? { payload?.code }

    /// Field messages for a validation failure; empty otherwise.
    public var fieldErrors: [String] {
        if case .validation(_, let payload) = self { return payload.messages }
        return []
    }

    public var isCancellation: Bool { self == .cancelled }

    /// A transport or gateway failure that may succeed if repeated. Only
    /// `RetryPolicy.safeToRepeat` calls are ever retried on it.
    public var isTransient: Bool {
        switch self {
        case .offline, .timeout: return true
        case .server(let status): return status == 502 || status == 503 || status == 504
        default: return false
        }
    }

    /// The server MAY have applied a mutation even though no success was
    /// seen (timeout, connection lost mid-request, 5xx). Never resend a
    /// non-idempotent action on this; reload the state and let the person
    /// decide (Flutter's "uncertain result" handling).
    public var isUncertainOutcome: Bool {
        switch self {
        case .offline, .timeout, .server: return true
        default: return false
        }
    }

    /// True only when the SERVER rejected the session itself. 403
    /// (APPLICATION_ROUTE_DENIED / APPLICATION_ACCESS_DENIED, permissions)
    /// and 503 (AUTH_UNAVAILABLE, maintenance) are never sign-outs.
    public var endsSession: Bool {
        if case .unauthorized = self { return true }
        return false
    }

    /// The raw (unfiltered) message — for branching and logs of non-secret
    /// text only. Show `userMessage` instead.
    public var rawMessage: String {
        switch self {
        case .unauthorized(let message), .timeout(let message), .rateLimited(_, let message): return message
        case .sessionChanged: return APIMessages.sessionChanged
        default: return payload?.message ?? userMessage
        }
    }

    /// Friendly text; identical rules to Flutter's `ApiException.userMessage`.
    public var userMessage: String {
        switch self {
        case .offline:
            return APIMessages.offline
        case .unauthorized(let message):
            return message.hasPrefix("Your session") ? message : APIMessages.sessionExpired
        case .sessionChanged:
            return APIMessages.sessionChanged
        case .forbidden(let payload):
            return payload.userFacingMessage ?? APIMessages.forbidden
        case .notFound(let payload):
            return payload.userFacingMessage ?? APIMessages.notFound
        case .timeout(let message):
            return UserFacingText.isUserFacing(message) ? message : APIMessages.timeout
        case .conflict(let payload):
            return payload.userFacingMessage ?? APIMessages.conflict
        case .rateLimited(_, let message):
            return UserFacingText.isUserFacing(message) ? message : APIMessages.tooManyRequests
        case .server:
            return APIMessages.serverError
        case .validation(_, let payload), .http(_, let payload):
            return payload.userFacingMessage ?? APIMessages.serverError
        case .decoding, .cancelled, .invalidRequest:
            return APIMessages.serverError
        }
    }

    /// Maps a failed HTTP response. `retryAfter` is the raw header value.
    public static func from(status: Int, payload: ServerErrorPayload, retryAfter: String? = nil, now: Date = Date()) -> APIError {
        switch status {
        case 401: return .unauthorized(message: payload.message)
        case 403: return .forbidden(payload)
        case 404: return .notFound(payload)
        case 408: return .timeout(message: payload.message)
        case 409: return .conflict(payload)
        case 400, 422: return .validation(status: status, payload)
        case 429:
            let seconds = RetryAfter.seconds(from: retryAfter, now: now)
            return .rateLimited(retryAfterSeconds: seconds, message: RetryAfter.message(seconds: seconds))
        case 500...: return .server(status: status)
        default: return .http(status: status, payload)
        }
    }

    /// Transport failures. Mirrors Flutter: Socket/TLS/client errors are
    /// "offline", a timeout is a timeout, nothing here ends the session.
    public static func from(urlError: URLError) -> APIError {
        switch urlError.code {
        case .timedOut: return .defaultTimeout
        case .cancelled: return .cancelled
        case .cannotDecodeContentData, .cannotDecodeRawData, .cannotParseResponse: return .decoding("Malformed response")
        default: return .offline
        }
    }
}

/// `Retry-After` handling for 429: seconds or an HTTP-date, default 60.
enum RetryAfter {
    private static let httpDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter
    }()

    static func seconds(from header: String?, now: Date) -> Int {
        guard let header = header?.trimmingCharacters(in: .whitespaces), !header.isEmpty else { return 60 }
        if let seconds = Int(header) { return seconds }
        if let date = httpDate.date(from: header) {
            return max(0, Int((date.timeIntervalSince(now)).rounded(.up)))
        }
        return 60
    }

    /// Same wording as Flutter's ApiClient 429 branch.
    static func message(seconds: Int) -> String {
        let minutes = min(max((seconds + 59) / 60, 1), 100_000)
        return "Too many requests. Please try again in \(minutes) \(minutes == 1 ? "minute" : "minutes")."
    }
}

/// Port of Flutter's `isUserFacingMessage`: true when a server message is
/// plain domain text a person can act on. Identifiers, SQL, stack text,
/// HTTP reason phrases and JSON fragments are never shown.
public enum UserFacingText {
    private static let technical = try! NSRegularExpression(
        pattern: #"exception|error:|stack|\bat [\w$.<>]+ ?\(|\bsql\b|relation "|column "|"#
            + #"violates|constraint|syntax|econn|undefined|\bnull\b|\bnan\b|<html|"#
            + #"<!doctype|cannot (get|post|put|patch|delete) /|should not exist|"#
            + #"\buuid\b|\bjwt\b|iso-8601|[{}\[\]]|"#
            + #"^(internal server error|bad request|not found|forbidden( resource)?|"#
            + #"unauthorized|conflict|too many requests|unprocessable entity|"#
            + #"service unavailable|bad gateway|gateway timeout|not acceptable)\.?$"#,
        options: [.caseInsensitive]
    )

    // camelCase / snake_case identifiers leak from validators and internal codes.
    private static let identifier = try! NSRegularExpression(pattern: #"\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b"#)

    public static func isUserFacing(_ message: String) -> Bool {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        // Dart's String.length counts UTF-16 code units.
        let length = text.utf16.count
        guard length >= 4, length <= 240 else { return false }
        let range = NSRange(text.startIndex..., in: text)
        return technical.firstMatch(in: text, range: range) == nil
            && identifier.firstMatch(in: text, range: range) == nil
    }
}

/// Friendly text for ANY error caught around an API call (Flutter's
/// `userMessageFor`).
public func userMessage(for error: Error, fallback: String? = nil) -> String {
    if let apiError = error as? APIError { return apiError.userMessage }
    if let urlError = error as? URLError { return APIError.from(urlError: urlError).userMessage }
    return fallback ?? APIMessages.serverError
}

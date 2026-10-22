import Foundation

public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

/// Whether a call may be re-sent automatically after a transient failure
/// (offline, timeout, 502/503/504). There is NO Idempotency-Key anywhere in
/// the API: repeat-safety comes from server state, per route
/// (docs/API_CONTRACT_MAP.md). The default for every mutation is `.never`.
public enum RetryPolicy: Sendable, Equatable {
    /// Never auto-retry. Use for clock-in, clock-out, offer accept/decline,
    /// `/shifts/request` and any route not proven repeat-safe. A timeout or
    /// 5xx is an UNCERTAIN outcome: reload state, never resend blindly.
    case never
    /// Repeat-safe by server state (GETs; check-in, finalise,
    /// attendance-review, confirm-no-show, push deactivate): retried at most
    /// once after a transient failure.
    case safeToRepeat
}

/// Per-call transport options.
public struct RequestOptions: Sendable, Equatable {
    public var retry: RetryPolicy
    public var timeout: TimeInterval
    /// Sends `X-Crewflow-Background: 1` — use for automatic polling and
    /// background refresh so they do not keep an idle session alive.
    public var background: Bool

    public init(retry: RetryPolicy, timeout: TimeInterval = APIClient.requestTimeout, background: Bool = false) {
        self.retry = retry
        self.timeout = timeout
        self.background = background
    }

    /// GET is repeat-safe; every mutation defaults to no automatic retry.
    public static func `default`(for method: HTTPMethod) -> RequestOptions {
        RequestOptions(retry: method == .get ? .safeToRepeat : .never)
    }

    /// A mutation the server treats as repeat-safe (see RetryPolicy).
    public static let repeatSafeMutation = RequestOptions(retry: .safeToRepeat)
    /// Automatic polling: repeat-safe and does not slide the idle window.
    public static let backgroundPoll = RequestOptions(retry: .safeToRepeat, background: true)
}

/// Bytes of a downloaded document plus what the server said about them.
public struct DownloadedFile: Sendable, Equatable {
    public let data: Data
    public let filename: String?
    public let mimeType: String?

    /// `%PDF-` magic: never show or save something that is not actually a PDF.
    public var isPDF: Bool {
        let magic: [UInt8] = [0x25, 0x50, 0x44, 0x46, 0x2D]
        return data.count > 4 && Array(data.prefix(5)) == magic
    }
}

struct HTTPResult: @unchecked Sendable {
    let data: Data
    let response: HTTPURLResponse
}

/// The one REST client every feature uses. Port of the Flutter
/// `ApiClient` (packages/rab-mobile/lib/core/api/api_client.dart):
///
/// - Base URL includes `/rest/v1`; paths add `/auth/me`, `/offers`, ...
/// - Every request carries `X-Client-Platform: mobile` (the server then
///   returns the refresh token in the JSON body instead of a web cookie)
///   and `Authorization: Bearer <access>` when a token is stored.
/// - 401 on a non-auth path (or `/auth/me`, `/auth/logout`) triggers ONE
///   shared refresh, then ONE retry under the same identity generation.
///   A request dispatched before a logout/account switch is never replayed
///   with the new identity's token, and its response is dropped.
/// - Redirects are never followed automatically (an `Authorization` header
///   must never reach another host). `downloadFile` follows a storage
///   redirect itself, WITHOUT any credential.
/// - The session is ephemeral: no URL cache, no cookies, no credential store.
public final class APIClient: @unchecked Sendable {
    /// CF-19: upper bounds for one API request and for one token refresh.
    public static let requestTimeout: TimeInterval = 30
    public static let refreshTimeout: TimeInterval = 20
    public static let platformHeaderName = "X-Client-Platform"
    public static let platformHeaderValue = "mobile"

    public let baseURL: URL
    private let baseString: String
    private let session: URLSession
    private let tokens: TokenStore
    private let gate: SessionGate
    private let temporaryFiles: TemporaryFiles
    private let allowsInsecureStorageRedirects: Bool

    /// - Parameters:
    ///   - baseURL: e.g. `https://api.example.com/rest/v1` (trailing slashes removed).
    ///   - configuration: tests inject a configuration with `protocolClasses`.
    ///   - allowsInsecureStorageRedirects: Debug-only LAN storage; Release passes false.
    public init(
        baseURL: URL,
        tokens: TokenStore,
        temporaryFiles: TemporaryFiles = TemporaryFiles(),
        configuration: URLSessionConfiguration = APIClient.defaultConfiguration(),
        allowsInsecureStorageRedirects: Bool = false
    ) {
        var trimmed = baseURL.absoluteString
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        self.baseString = trimmed
        self.baseURL = URL(string: trimmed) ?? baseURL
        self.tokens = tokens
        self.gate = SessionGate(tokens: tokens)
        self.temporaryFiles = temporaryFiles
        self.allowsInsecureStorageRedirects = allowsInsecureStorageRedirects
        self.session = URLSession(configuration: configuration, delegate: RedirectBlocker(), delegateQueue: nil)
    }

    deinit {
        session.invalidateAndCancel()
    }

    public static func defaultConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.waitsForConnectivity = false
        return configuration
    }

    // MARK: - Public API

    /// Decodes a JSON response.
    public func request<T: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        body: (any Encodable)? = nil,
        options: RequestOptions? = nil,
        as type: T.Type
    ) async throws -> T {
        let data = try await send(method, path, body: body, options: options)
        return try decode(type, from: data)
    }

    /// Like `request`, but an EMPTY 2xx body (or JSON `null`) decodes as nil.
    /// A handler that returns `null` answers 200 with no body, e.g.
    /// "no attendance recorded yet".
    public func requestOptional<T: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        body: (any Encodable)? = nil,
        options: RequestOptions? = nil,
        as type: T.Type
    ) async throws -> T? {
        let data = try await send(method, path, body: body, options: options)
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text == "null" { return nil }
        return try decode(type, from: data)
    }

    /// Ignores the response body (204 routes; any 2xx is success).
    public func requestVoid(
        _ method: HTTPMethod,
        _ path: String,
        body: (any Encodable)? = nil,
        options: RequestOptions? = nil
    ) async throws {
        _ = try await send(method, path, body: body, options: options)
    }

    public func get<T: Decodable>(_ path: String, options: RequestOptions? = nil, as type: T.Type) async throws -> T {
        try await request(.get, path, options: options, as: type)
    }

    public func getOptional<T: Decodable>(_ path: String, options: RequestOptions? = nil, as type: T.Type) async throws -> T? {
        try await requestOptional(.get, path, options: options, as: type)
    }

    public func post<T: Decodable>(_ path: String, body: (any Encodable)? = nil, options: RequestOptions? = nil, as type: T.Type) async throws -> T {
        try await request(.post, path, body: body, options: options, as: type)
    }

    public func post(_ path: String, body: (any Encodable)? = nil, options: RequestOptions? = nil) async throws {
        try await requestVoid(.post, path, body: body, options: options)
    }

    public func patch<T: Decodable>(_ path: String, body: (any Encodable)? = nil, options: RequestOptions? = nil, as type: T.Type) async throws -> T {
        try await request(.patch, path, body: body, options: options, as: type)
    }

    public func put<T: Decodable>(_ path: String, body: (any Encodable)? = nil, options: RequestOptions? = nil, as type: T.Type) async throws -> T {
        try await request(.put, path, body: body, options: options, as: type)
    }

    /// Raw bytes (e.g. an image via `GET /files/:id`, which always streams
    /// through the API and never redirects). Same token/refresh/error rules.
    public func getBytes(_ path: String, options: RequestOptions? = nil) async throws -> Data {
        try await send(.get, path, body: nil, options: options)
    }

    /// A document from `GET /files/:id/download`. The API either streams the
    /// bytes (LOCAL storage) or answers 302 with a short-lived presigned URL
    /// (S3). The redirect is followed here WITHOUT the bearer token, so the
    /// credential never reaches the storage host and is never put in a URL.
    public func downloadFile(_ path: String) async throws -> DownloadedFile {
        let generation = await gate.generation
        return try await download(path, retried: false, dispatchGeneration: generation)
    }

    /// `GET /healthz` — NOT under `/rest/v1`, no auth. True only for 2xx.
    public func healthCheck() async -> Bool {
        var root = baseString
        if root.hasSuffix("/rest/v1") { root.removeLast("/rest/v1".count) }
        guard let url = URL(string: root + "/healthz") else { return false }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = "GET"
        request.setValue(Self.platformHeaderValue, forHTTPHeaderField: Self.platformHeaderName)
        guard let result = try? await transport(request, timeout: 10) else { return false }
        return (200..<300).contains(result.response.statusCode)
    }

    /// The identity generation a feature can capture before an await and
    /// compare after it (`isCurrent(generation:)`).
    public func currentGeneration() async -> UInt64 {
        await gate.generation
    }

    public func isCurrent(generation: UInt64) async -> Bool {
        await gate.isCurrent(generation)
    }

    /// Called (on the main actor) when a refresh fails for the CURRENT
    /// identity: the stored session has already been wiped.
    public func setSessionExpiredHandler(_ handler: (@MainActor @Sendable () -> Void)?) async {
        await gate.setExpiryHandler(handler)
    }

    /// Persists tokens from a fresh login (refresh token first, CF-19).
    public func storeTokens(accessToken: String, refreshToken: String) throws {
        try tokens.store(accessToken: accessToken, refreshToken: refreshToken)
    }

    /// Cancels every request currently on the wire (their callers receive
    /// `APIError.cancelled`).
    public func cancelAllRequests() async {
        let tasks = await session.allTasks
        tasks.forEach { $0.cancel() }
    }

    /// Ends the local session: new generation (late responses and a late
    /// refresh are discarded), tokens wiped, in-flight requests cancelled,
    /// session caches reset, per-session temporary files deleted.
    public func endSession() async {
        await gate.invalidate()
        await cancelAllRequests()
        await session.reset()
        temporaryFiles.purge()
    }

    // MARK: - Core

    static func refreshEligible(_ path: String) -> Bool {
        let bare = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return !bare.hasPrefix("/auth/") || bare == "/auth/me" || bare == "/auth/logout"
    }

    /// Applies the per-call retry policy around `execute`. Only
    /// `.safeToRepeat` calls are ever re-sent after a transient failure, and
    /// at most once. Everything else surfaces the failure; callers treat
    /// `APIError.isUncertainOutcome` as "reload the state, then decide".
    private func send(_ method: HTTPMethod, _ path: String, body: (any Encodable)?, options: RequestOptions?) async throws -> Data {
        let resolved = options ?? RequestOptions.default(for: method)
        let encoded = try encode(body)
        let generation = await gate.generation
        do {
            return try await execute(method, path, body: encoded, options: resolved, dispatchGeneration: generation)
        } catch let error as APIError where resolved.retry == .safeToRepeat && error.isTransient {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard await gate.isCurrent(generation) else { throw APIError.sessionChanged }
            Log.network.info("Retrying a repeat-safe request once after a transient failure")
            return try await execute(method, path, body: encoded, options: resolved, dispatchGeneration: generation)
        }
    }

    private func execute(
        _ method: HTTPMethod,
        _ path: String,
        body: Data?,
        options: RequestOptions,
        retried: Bool = false,
        dispatchGeneration generation: UInt64
    ) async throws -> Data {
        // `generation` is captured once per call; the 401 replay reuses it so
        // it can never run under an identity that replaced this one meanwhile.
        let bearer = tokens.accessToken()
        var request = try makeRequest(method, path, body: body, bearer: bearer, timeout: options.timeout)
        if options.background {
            // Fully validated, but does not slide the 7-day idle window.
            request.setValue("1", forHTTPHeaderField: "X-Crewflow-Background")
        }
        let started = Date()
        let result = try await transport(request, timeout: options.timeout)
        let status = result.response.statusCode
        let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
        Log.network.debug("\(method.rawValue, privacy: .public) \(path, privacy: .private) -> \(status, privacy: .public) in \(elapsedMs, privacy: .public)ms")

        if status == 401, !retried, Self.refreshEligible(path) {
            // CF-36: sent under an identity that has since been signed out.
            // Its 401 says nothing about the CURRENT session: never refresh
            // (rotate) the current account's token for it, never clear it.
            guard await gate.isCurrent(generation) else { throw APIError.sessionChanged }
            let refreshed = try await refreshAccessToken(presented: bearer)
            guard await gate.isCurrent(generation) else { throw APIError.sessionChanged }
            if refreshed {
                // A 401 comes from the auth guard BEFORE the handler runs, so
                // this single replay is safe even for a non-idempotent POST.
                var retryBody = body
                if path == "/auth/logout" {
                    // The refresh just rotated the token the original body named.
                    retryBody = try encode(RefreshTokenBody(refreshToken: tokens.refreshToken()))
                }
                return try await execute(method, path, body: retryBody, options: options, retried: true, dispatchGeneration: generation)
            }
            await expire(ifCurrent: generation)
            throw APIError.unauthorized(message: APIMessages.sessionExpired)
        }

        // Account-switch safety: a response (success OR failure) that
        // arrives after the identity changed belongs to nobody on screen.
        guard await gate.isCurrent(generation) else { throw APIError.sessionChanged }
        if status >= 300 { throw failure(for: result) }
        return result.data
    }

    private func download(_ path: String, retried: Bool, dispatchGeneration: UInt64?) async throws -> DownloadedFile {
        let generation: UInt64
        if let dispatchGeneration {
            generation = dispatchGeneration
        } else {
            generation = await gate.generation
        }
        let bearer = tokens.accessToken()
        var request = try makeRequest(.get, path, body: nil, bearer: bearer, timeout: Self.requestTimeout)
        request.setValue(nil, forHTTPHeaderField: "Content-Type")
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        let first = try await transport(request, timeout: Self.requestTimeout)
        let status = first.response.statusCode

        if status == 401, !retried {
            let current = await gate.isCurrent(generation)
            var refreshed = false
            if current {
                refreshed = try await refreshAccessToken(presented: bearer)
            }
            if refreshed, await gate.isCurrent(generation) {
                return try await download(path, retried: true, dispatchGeneration: generation)
            }
            guard current else { throw APIError.sessionChanged }
            await expire(ifCurrent: generation)
            throw APIError.unauthorized(message: APIMessages.sessionExpired)
        }
        guard await gate.isCurrent(generation) else { throw APIError.sessionChanged }

        if (300..<400).contains(status) {
            guard let location = first.response.value(forHTTPHeaderField: "Location"),
                  let target = URL(string: location, relativeTo: baseURL)?.absoluteURL
            else {
                // "The download link was missing." (5xx: generic text on screen)
                throw APIError.server(status: 502)
            }
            let scheme = target.scheme?.lowercased()
            guard scheme == "https" || (allowsInsecureStorageRedirects && scheme == "http") else {
                throw APIError.server(status: 502)
            }
            // Deliberately NO headers: the presigned URL is its own short-lived
            // authorisation. Never log `target` (its query is a credential).
            var storageRequest = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Self.requestTimeout)
            storageRequest.httpMethod = "GET"
            storageRequest.httpShouldHandleCookies = false
            let stored = try await transport(
                storageRequest,
                timeout: Self.requestTimeout,
                timeoutMessage: "The download timed out. Check your connection and try again."
            )
            let storedStatus = stored.response.statusCode
            guard storedStatus == 200 else {
                if storedStatus >= 500 { throw APIError.server(status: storedStatus) }
                throw APIError.http(
                    status: storedStatus,
                    ServerErrorPayload(message: "The file could not be fetched from storage. Please try again.")
                )
            }
            guard await gate.isCurrent(generation) else { throw APIError.sessionChanged }
            return DownloadedFile(
                data: stored.data,
                filename: ContentDisposition.filename(from: stored.response.value(forHTTPHeaderField: "Content-Disposition"))
                    ?? ContentDisposition.filename(from: first.response.value(forHTTPHeaderField: "Content-Disposition")),
                mimeType: stored.response.value(forHTTPHeaderField: "Content-Type")
            )
        }
        if status >= 400 { throw failure(for: first) }
        return DownloadedFile(
            data: first.data,
            filename: ContentDisposition.filename(from: first.response.value(forHTTPHeaderField: "Content-Disposition")),
            mimeType: first.response.value(forHTTPHeaderField: "Content-Type")
        )
    }

    private func refreshAccessToken(presented: String?) async throws -> Bool {
        try await gate.refresh(presentedAccessToken: presented) { [weak self] refreshToken in
            guard let self else { return nil }
            return try await self.fetchRefreshedTokens(refreshToken)
        }
    }

    /// POST /auth/refresh with the body token. 401/403 = rejected (nil);
    /// timeouts and other failures throw and leave the session untouched
    /// (an unanswered refresh is a network problem, not an ended session).
    private func fetchRefreshedTokens(_ refreshToken: String) async throws -> TokenPair? {
        let body = try encode(RefreshTokenBody(refreshToken: refreshToken))
        // X-Client-Platform: mobile (set by makeRequest) is mandatory here:
        // without it the server assumes manager_web and refuses a mobile
        // session family with 403 APPLICATION_ACCESS_DENIED.
        let request = try makeRequest(.post, "/auth/refresh", body: body, bearer: nil, timeout: Self.refreshTimeout)
        let result = try await transport(request, timeout: Self.refreshTimeout)
        let status = result.response.statusCode
        if status == 401 || status == 403 { return nil }
        if status >= 300 { throw failure(for: result) }
        let tokens = try decode(AuthTokensResponse.self, from: result.data)
        return TokenPair(accessToken: tokens.accessToken, refreshToken: tokens.refreshToken)
    }

    private func expire(ifCurrent generation: UInt64) async {
        if let handler = await gate.expireIfCurrent(generation) {
            Log.session.info("Session expired after a rejected refresh")
            await handler()
        }
    }

    // MARK: - Plumbing

    func makeRequest(_ method: HTTPMethod, _ path: String, body: Data?, bearer: String?, timeout: TimeInterval) throws -> URLRequest {
        guard path.hasPrefix("/"), let url = URL(string: baseString + path) else {
            assertionFailure("API paths must start with '/': \(path)")
            throw APIError.invalidRequest("Invalid request path")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method.rawValue
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Self.platformHeaderValue, forHTTPHeaderField: Self.platformHeaderName)
        if let bearer {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body
        return request
    }

    private func transport(_ request: URLRequest, timeout: TimeInterval, timeoutMessage: String = APIMessages.timeout) async throws -> HTTPResult {
        let session = self.session
        do {
            return try await Deadline.run(seconds: timeout, timeoutError: .timeout(message: timeoutMessage)) {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw APIError.decoding("Non-HTTP response")
                }
                return HTTPResult(data: data, response: http)
            }
        } catch let error as APIError {
            throw error
        } catch let error as URLError {
            throw APIError.from(urlError: error)
        } catch is CancellationError {
            throw APIError.cancelled
        } catch {
            throw APIError.offline
        }
    }

    private func failure(for result: HTTPResult) -> APIError {
        APIError.from(
            status: result.response.statusCode,
            payload: ServerErrorPayload.parse(result.data),
            retryAfter: result.response.value(forHTTPHeaderField: "Retry-After")
        )
    }

    private func encode(_ body: (any Encodable)?) throws -> Data? {
        guard let body else { return nil }
        do {
            return try CrewflowJSON.makeEncoder().encode(body)
        } catch {
            throw APIError.invalidRequest("Body could not be encoded")
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try CrewflowJSON.makeDecoder().decode(type, from: data)
        } catch {
            // Never include the payload itself: it may hold personal data.
            Log.network.error("Decoding \(String(describing: type), privacy: .public) failed")
            throw APIError.decoding(String(describing: type))
        }
    }
}

struct RefreshTokenBody: Encodable {
    let refreshToken: String?
}

/// Refuses every automatic redirect so an `Authorization` header can never
/// be replayed to another host. The 3xx response is returned to the caller.
final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

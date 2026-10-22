import XCTest
@testable import Crewflow

/// Pure error mapping: identical rules to Flutter's ApiException.userMessage.
final class APIErrorMappingTests: XCTestCase {
    private func payload(_ message: String, code: String? = nil) -> ServerErrorPayload {
        ServerErrorPayload(message: message, code: code)
    }

    func testUnauthorizedAlwaysReadsAsSessionExpiredUnlessClientAuthored() {
        XCTAssertEqual(APIError.from(status: 401, payload: payload("Invalid or expired access token")).userMessage, APIMessages.sessionExpired)
        XCTAssertEqual(APIError.unauthorized(message: "Your session changed while this was loading. Please try again.").userMessage,
                       "Your session changed while this was loading. Please try again.")
        XCTAssertEqual(APIError.sessionChanged.userMessage, APIMessages.sessionChanged)
    }

    func testForbiddenKeepsDomainTextButHidesTechnicalText() {
        XCTAssertEqual(APIError.from(status: 403, payload: payload("This action is not available in this app.", code: "APPLICATION_ROUTE_DENIED")).userMessage,
                       "This action is not available in this app.")
        XCTAssertEqual(APIError.from(status: 403, payload: payload("Forbidden resource")).userMessage, APIMessages.forbidden)
    }

    func testNotFound() {
        XCTAssertEqual(APIError.from(status: 404, payload: payload("Not found.")).userMessage, APIMessages.notFound)
        XCTAssertEqual(APIError.from(status: 404, payload: payload("Offer not found.")).userMessage, "Offer not found.")
    }

    func testConflictCarriesCode() {
        let error = APIError.from(status: 409, payload: payload("You can clock in from 08:45.", code: "CLOCK_IN_TOO_EARLY"))
        XCTAssertEqual(error.code, "CLOCK_IN_TOO_EARLY")
        XCTAssertEqual(error.userMessage, "You can clock in from 08:45.")
        XCTAssertEqual(APIError.from(status: 409, payload: payload("Invalid transition: staff_accepted -> staff_accepted")).userMessage, APIMessages.conflict)
    }

    func testRateLimitedUsesRetryAfterSecondsAndHTTPDate() {
        let seconds = APIError.from(status: 429, payload: payload("x"), retryAfter: "900")
        XCTAssertEqual(seconds, .rateLimited(retryAfterSeconds: 900, message: "Too many requests. Please try again in 15 minutes."))
        XCTAssertEqual(seconds.userMessage, "Too many requests. Please try again in 15 minutes.")

        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        let header = formatter.string(from: now.addingTimeInterval(30))
        XCTAssertEqual(APIError.from(status: 429, payload: payload("x"), retryAfter: header, now: now),
                       .rateLimited(retryAfterSeconds: 30, message: "Too many requests. Please try again in 1 minute."))

        XCTAssertEqual(APIError.from(status: 429, payload: payload("x"), retryAfter: nil),
                       .rateLimited(retryAfterSeconds: 60, message: "Too many requests. Please try again in 1 minute."))
    }

    func testServerErrorsNeverShowServerText() {
        let error = APIError.from(status: 500, payload: payload("relation \"core.user\" does not exist"))
        XCTAssertEqual(error, .server(status: 500))
        XCTAssertEqual(error.userMessage, APIMessages.serverError)
        XCTAssertEqual(APIError.from(status: 503, payload: payload("Sign-in could not be checked right now.", code: "AUTH_UNAVAILABLE")).userMessage, APIMessages.serverError)
    }

    func testValidationKeepsFieldMessages() {
        let error = APIError.from(status: 400, payload: ServerErrorPayload(message: "email must be an email", messages: ["email must be an email", "password should not be empty"]))
        XCTAssertEqual(error.fieldErrors.count, 2)
        XCTAssertEqual(error.userMessage, "email must be an email")
        // Identifier leaks are hidden.
        XCTAssertEqual(APIError.from(status: 400, payload: payload("property organisationId should not exist")).userMessage, APIMessages.serverError)
    }

    func testTransportMapping() {
        XCTAssertEqual(APIError.from(urlError: URLError(.notConnectedToInternet)).userMessage, APIMessages.offline)
        XCTAssertEqual(APIError.from(urlError: URLError(.secureConnectionFailed)).userMessage, APIMessages.offline)
        XCTAssertEqual(APIError.from(urlError: URLError(.timedOut)).userMessage, APIMessages.timeout)
        XCTAssertEqual(APIError.from(urlError: URLError(.cancelled)), .cancelled)
        XCTAssertEqual(userMessage(for: URLError(.networkConnectionLost)), APIMessages.offline)
        XCTAssertEqual(userMessage(for: NSError(domain: "x", code: 1), fallback: "Fallback text"), "Fallback text")
    }

    func testClassifiers() {
        XCTAssertTrue(APIError.offline.isTransient)
        XCTAssertTrue(APIError.server(status: 503).isTransient)
        XCTAssertFalse(APIError.server(status: 500).isTransient)
        XCTAssertTrue(APIError.server(status: 500).isUncertainOutcome)
        XCTAssertTrue(APIError.defaultTimeout.isUncertainOutcome)
        XCTAssertFalse(APIError.conflict(payload("x")).isUncertainOutcome)
        XCTAssertTrue(APIError.unauthorized(message: "x").endsSession)
        XCTAssertFalse(APIError.forbidden(payload("x", code: "APPLICATION_ACCESS_DENIED")).endsSession)
        XCTAssertFalse(APIError.server(status: 503).endsSession)
    }

    func testUserFacingFilter() {
        XCTAssertTrue(UserFacingText.isUserFacing("This shift is not confirmed for you."))
        XCTAssertFalse(UserFacingText.isUserFacing("Internal server error"))
        XCTAssertFalse(UserFacingText.isUserFacing("TypeError: cannot read undefined"))
        XCTAssertFalse(UserFacingText.isUserFacing("shiftId must be a UUID"))
        XCTAssertFalse(UserFacingText.isUserFacing("bad"))
        XCTAssertFalse(UserFacingText.isUserFacing(String(repeating: "a ", count: 130)))
        XCTAssertFalse(UserFacingText.isUserFacing("Cannot POST /rest/v1/nope"))
    }
}

/// APIClient behaviour against the URLProtocol stub server.
final class APIClientTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }

    override func setUp() {
        super.setUp()
        server.reset()
    }

    func testEveryRequestCarriesMobilePlatformHeaderAndBearerOnlyWhenHeld() async throws {
        let (client, tokens) = makeClient()
        server.setHandler { _ in .json(200, #"{"ok":true}"#) }

        _ = try await client.get("/things", as: Probe.self)
        XCTAssertEqual(server.requests.last?.value(forHTTPHeaderField: "X-Client-Platform"), "mobile")
        XCTAssertNil(server.requests.last?.bearer)
        XCTAssertEqual(server.requests.last?.url?.absoluteString, "https://api.test/rest/v1/things")

        try tokens.store(accessToken: "A", refreshToken: "R")
        _ = try await client.get("/things", as: Probe.self)
        XCTAssertEqual(server.requests.last?.bearer, "Bearer A")
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "X-Application-Target"))
    }

    func testHealthCheckHasNoRestPrefixAndNoAuth() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "A", refreshToken: "R")
        server.setHandler { _ in .json(200, #"{"status":"ok"}"#) }
        let healthy = await client.healthCheck()
        XCTAssertTrue(healthy)
        XCTAssertEqual(server.requests.last?.url?.absoluteString, "https://api.test/healthz")
        XCTAssertNil(server.requests.last?.bearer)
    }

    func testEmptyBodyDecodesAsNil() async throws {
        let (client, _) = makeClient()
        server.setHandler { _ in .empty(200) }
        let value = try await client.getOptional("/attendance/me/shift/x", as: Probe.self)
        XCTAssertNil(value)
    }

    func testConcurrent401sShareOneRefreshAndReplayOnce() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "old", refreshToken: "r1")
        server.setHandler { request in
            if request.url!.path.hasSuffix("/auth/refresh") {
                Thread.sleep(forTimeInterval: 0.3)
                return .fixture("auth_refresh")
            }
            return request.bearer == "Bearer access-token-2" ? .json(200, #"{"ok":true}"#) : .json(401, #"{"message":"Invalid or expired access token"}"#)
        }

        let results = try await withThrowingTaskGroup(of: Probe.self) { group -> [Probe] in
            for _ in 0..<5 {
                group.addTask { try await client.get("/things", as: Probe.self) }
            }
            var all: [Probe] = []
            for try await probe in group { all.append(probe) }
            return all
        }

        XCTAssertEqual(results.count, 5)
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 1, "single-flight: one rotation for all callers")
        let refresh = try XCTUnwrap(server.requests(to: "/auth/refresh").first)
        XCTAssertEqual(refresh.jsonBody?["refreshToken"] as? String, "r1")
        XCTAssertEqual(refresh.value(forHTTPHeaderField: "X-Client-Platform"), "mobile", "without it /auth/refresh refuses mobile families")
        XCTAssertNil(refresh.bearer)
        XCTAssertEqual(tokens.accessToken(), "access-token-2")
        XCTAssertEqual(tokens.refreshToken(), "refresh-token-2")
    }

    func testRotatedRefreshTokenIsPersistedBeforeAccessToken() async throws {
        let store = RecordingSecureStore()
        let (client, tokens) = makeClient(store: store)
        try tokens.store(accessToken: "old", refreshToken: "r1")
        server.setHandler { request in
            if request.url!.path.hasSuffix("/auth/refresh") { return .fixture("auth_refresh") }
            return request.bearer == "Bearer access-token-2" ? .json(200, #"{"ok":true}"#) : .json(401, "{}")
        }
        _ = try await client.get("/things", as: Probe.self)
        XCTAssertEqual(Array(store.writes.suffix(2)), [TokenStore.refreshTokenKey, TokenStore.accessTokenKey])
    }

    func testSecond401AfterReplayDoesNotLoop() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "old", refreshToken: "r1")
        server.setHandler { request in
            request.url!.path.hasSuffix("/auth/refresh") ? .fixture("auth_refresh") : .json(401, #"{"message":"Please sign in again."}"#)
        }
        do {
            _ = try await client.get("/things", as: Probe.self)
            XCTFail("expected 401")
        } catch {
            XCTAssertEqual((error as? APIError)?.statusCode, 401)
        }
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 1)
        XCTAssertEqual(server.requests(to: "/things").count, 2, "original + exactly one replay")
    }

    func testRejectedRefreshWipesSessionAndNotifies() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "old", refreshToken: "r1")
        let expired = expectation(description: "session expired handler")
        await client.setSessionExpiredHandler { expired.fulfill() }
        server.setHandler { request in
            request.url!.path.hasSuffix("/auth/refresh") ? .json(401, #"{"message":"Invalid refresh token"}"#) : .json(401, "{}")
        }
        do {
            _ = try await client.get("/things", as: Probe.self)
            XCTFail("expected 401")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized(message: APIMessages.sessionExpired))
        }
        await fulfillment(of: [expired], timeout: 2)
        XCTAssertNil(tokens.accessToken())
        XCTAssertNil(tokens.refreshToken())
    }

    func testRefreshTimeoutOr5xxKeepsTheSession() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "old", refreshToken: "r1")
        server.setHandler { request in
            request.url!.path.hasSuffix("/auth/refresh") ? .json(503, #"{"code":"AUTH_UNAVAILABLE","message":"x"}"#) : .json(401, "{}")
        }
        do {
            _ = try await client.request(.post, "/attendance/clock-in", body: ["shiftId": "s"], as: Probe.self)
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 503))
        }
        XCTAssertEqual(tokens.refreshToken(), "r1", "AUTH_UNAVAILABLE must never log anyone out")
    }

    func test503OnARequestNeverLogsOut() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "A", refreshToken: "R")
        server.setHandler { _ in .json(503, #"{"code":"AUTH_UNAVAILABLE","message":"Sign-in could not be checked right now."}"#) }
        do {
            _ = try await client.get("/offers/mine", options: RequestOptions(retry: .never), as: Probe.self)
            XCTFail("expected 503")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 503))
        }
        XCTAssertEqual(tokens.accessToken(), "A")
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 0)
    }

    func testForbiddenApplicationRouteIsNotALogout() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "A", refreshToken: "R")
        server.setHandler { _ in .json(403, #"{"code":"APPLICATION_ROUTE_DENIED","message":"This action is not available in this app."}"#) }
        do {
            _ = try await client.get("/payroll/runs", as: Probe.self)
            XCTFail("expected 403")
        } catch {
            XCTAssertEqual((error as? APIError)?.code, "APPLICATION_ROUTE_DENIED")
        }
        XCTAssertEqual(tokens.accessToken(), "A")
    }

    func testNonIdempotentMutationIsNeverAutoRetried() async throws {
        let (client, _) = makeClient()
        server.setHandler { _ in .json(503, #"{"message":"Service Unavailable"}"#) }
        do {
            try await client.post("/attendance/clock-in", body: ["shiftId": "s", "qrToken": "q"])
            XCTFail("expected failure")
        } catch let error as APIError {
            XCTAssertTrue(error.isUncertainOutcome, "caller must reload, not resend")
        }
        XCTAssertEqual(server.requests(to: "/attendance/clock-in").count, 1)
    }

    func testOfflineMutationIsNotRetriedButRepeatSafeGetIsRetriedOnce() async throws {
        let (client, _) = makeClient()
        server.setHandler { _ in .failure(.notConnectedToInternet) }
        do {
            try await client.post("/offers/o1/accept")
            XCTFail("expected offline")
        } catch {
            XCTAssertEqual(error as? APIError, .offline)
        }
        XCTAssertEqual(server.requests(to: "/offers/o1/accept").count, 1)

        do {
            _ = try await client.get("/offers/mine", as: Probe.self)
            XCTFail("expected offline")
        } catch {
            XCTAssertEqual((error as? APIError)?.userMessage, APIMessages.offline)
        }
        XCTAssertEqual(server.requests(to: "/offers/mine").count, 2, "repeat-safe GET: one automatic retry")
    }

    func testBackgroundPollHeader() async throws {
        let (client, _) = makeClient()
        server.setHandler { _ in .json(200, #"{"ok":true}"#) }
        _ = try await client.get("/offers/mine", options: .backgroundPoll, as: Probe.self)
        XCTAssertEqual(server.requests.last?.value(forHTTPHeaderField: "X-Crewflow-Background"), "1")
    }

    func testDownloadFollowsRedirectWithoutBearer() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "SECRET", refreshToken: "R")
        let pdf = Data("%PDF-1.7 test".utf8)
        server.setHandler { request in
            if request.url!.host == "storage.test" {
                return StubResponse(status: 200, headers: ["Content-Type": "application/pdf", "Content-Disposition": "attachment; filename*=UTF-8''Payslip%20Oct.pdf"], body: pdf)
            }
            return StubResponse(status: 302, headers: ["Location": "https://storage.test/bucket/doc.pdf?X-Amz-Signature=abc"], body: Data())
        }
        let file = try await client.downloadFile("/files/f1/download")
        XCTAssertEqual(file.data, pdf)
        XCTAssertTrue(file.isPDF)
        XCTAssertEqual(file.filename, "Payslip Oct.pdf")
        let apiCall = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(apiCall.bearer, "Bearer SECRET")
        let storageCall = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(storageCall.url?.host, "storage.test")
        XCTAssertNil(storageCall.bearer, "the bearer must never reach the storage host")
        XCTAssertNil(storageCall.value(forHTTPHeaderField: "X-Client-Platform"))
    }

    func testDownloadRefusesInsecureRedirectInRelease() async throws {
        let (client, _) = makeClient()
        server.setHandler { _ in StubResponse(status: 302, headers: ["Location": "http://storage.test/doc.pdf"], body: Data()) }
        do {
            _ = try await client.downloadFile("/files/f1/download")
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 502))
        }
        XCTAssertEqual(server.requests.count, 1)
    }

    func testResponseArrivingAfterSignOutIsDropped() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "A", refreshToken: "R")
        let arrived = expectation(description: "request reached server")
        let release = DispatchSemaphore(value: 0)
        server.setHandler { request in
            if request.url!.path.hasSuffix("/things") {
                arrived.fulfill()
                _ = release.wait(timeout: .now() + 5)
            }
            return .json(200, #"{"ok":true}"#)
        }
        let call = Task { try await client.get("/things", as: Probe.self) }
        await fulfillment(of: [arrived], timeout: 2)
        await client.endSession()
        release.signal()
        do {
            _ = try await call.value
            XCTFail("a response from the old identity must not be delivered")
        } catch {
            let apiError = error as? APIError
            XCTAssertTrue(apiError == .sessionChanged || apiError == .cancelled)
        }
        XCTAssertNil(tokens.accessToken())
    }
}

/// The refresh gate in isolation (deterministic interleavings).
final class SessionGateTests: XCTestCase {
    func testLateRefreshAfterLogoutIsDiscarded() async throws {
        let tokens = TokenStore(store: InMemorySecureStore())
        try tokens.store(accessToken: "old", refreshToken: "r1")
        let gate = SessionGate(tokens: tokens)
        let entered = Latch()
        let release = Latch()

        let refresh = Task {
            try await gate.refresh { _ in
                await entered.open()
                await release.wait()
                return TokenPair(accessToken: "late-access", refreshToken: "late-refresh")
            }
        }
        await entered.wait()
        await gate.invalidate() // logout / account switch while the refresh is on the wire
        await release.open()

        do {
            _ = try await refresh.value
            XCTFail("late refresh must be discarded")
        } catch {
            XCTAssertEqual(error as? APIError, .sessionChanged)
        }
        XCTAssertNil(tokens.accessToken())
        XCTAssertNil(tokens.refreshToken(), "the late tokens were never written")
    }

    func testConcurrentCallersShareOneFetch() async throws {
        let tokens = TokenStore(store: InMemorySecureStore())
        try tokens.store(accessToken: "old", refreshToken: "r1")
        let gate = SessionGate(tokens: tokens)
        let counter = Counter()
        let release = Latch()

        let tasks = (0..<5).map { _ in
            Task {
                try await gate.refresh { _ in
                    await counter.increment()
                    await release.wait()
                    return TokenPair(accessToken: "new", refreshToken: "r2")
                }
            }
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        await release.open()
        for task in tasks {
            let refreshed = try await task.value
            XCTAssertTrue(refreshed)
        }
        let count = await counter.value
        XCTAssertEqual(count, 1)
        XCTAssertEqual(tokens.refreshToken(), "r2")
    }

    func testRejectedRefreshReturnsFalseAndKeepsTokensForCaller() async throws {
        let tokens = TokenStore(store: InMemorySecureStore())
        try tokens.store(accessToken: "old", refreshToken: "r1")
        let gate = SessionGate(tokens: tokens)
        let refreshed = try await gate.refresh { _ in nil }
        XCTAssertFalse(refreshed)
    }

    func testExpireOnlyForCurrentGeneration() async {
        let tokens = TokenStore(store: InMemorySecureStore())
        try? tokens.store(accessToken: "A", refreshToken: "R")
        let gate = SessionGate(tokens: tokens)
        let stale = await gate.generation
        await gate.invalidate()
        try? tokens.store(accessToken: "B", refreshToken: "R2") // the next account signs in
        let handler = await gate.expireIfCurrent(stale)
        XCTAssertNil(handler)
        XCTAssertEqual(tokens.accessToken(), "B", "a stale 401 never signs out the new identity")
    }
}

actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}

import XCTest
@testable import Crewflow

// Server-shaped bodies from MfaLoginService / AuthService.completeLogin
// (docs/account-security/STEP1_REPORT.md).
private let challengeBody = #"{"statusCode":409,"code":"SECOND_FACTOR_REQUIRED","requirement":"verify","challengeToken":"challenge-secret-1","challengeExpiresAt":"2026-10-24T10:05:00.000Z","message":"Enter the code from your authenticator app to finish signing in."}"#
private let enrolChallengeBody = #"{"statusCode":409,"code":"SECOND_FACTOR_REQUIRED","requirement":"enroll","challengeToken":"challenge-enrol-1","challengeExpiresAt":"2026-10-24T10:05:00.000Z","message":"Set up two-factor authentication to finish signing in."}"#
private let updateRequiredBody = #"{"statusCode":409,"code":"CLIENT_UPDATE_REQUIRED","message":"Update Crewflow to sign in. Your account uses two-factor authentication, and this version of the app can’t ask for your code."}"#
private func codeInvalidBody(_ remaining: Int?) -> String {
    let extra = remaining.map { #","attemptsRemaining":\#($0)"# } ?? ""
    return #"{"statusCode":401,"code":"MFA_CODE_INVALID","state":"invalid_code","message":"That code didn’t work. Check your authenticator app and try again."\#(extra)}"#
}
private let expiredBody = #"{"statusCode":401,"code":"MFA_CHALLENGE_EXPIRED","state":"expired","message":"Your sign-in expired. Please sign in again."}"#
private let exhaustedBody = #"{"statusCode":401,"code":"MFA_CHALLENGE_EXHAUSTED","state":"locked","message":"Too many incorrect codes. Please sign in again."}"#
private let rateLimitedBody = #"{"statusCode":429,"code":"MFA_RATE_LIMITED","state":"locked","message":"Too many verification attempts. Please try again in 2 minutes.","retryAfter":120}"#

/// The SessionCoordinator side of the 2FA sign-in against the URLProtocol stub.
@MainActor
final class SecondFactorSignInTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }
    private var deviceStore: InMemorySecureStore!
    private var sessionStore: InMemorySecureStore!
    private let clock = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUp() async throws {
        server.reset()
        deviceStore = InMemorySecureStore()
        sessionStore = InMemorySecureStore()
    }

    private func makeSession() -> (SessionCoordinator, TokenStore, BiometricStore) {
        let (client, tokens) = makeClient(store: sessionStore)
        let biometricStore = BiometricStore(store: deviceStore)
        let fixed = clock
        let session = SessionCoordinator(
            api: client,
            tokens: tokens,
            biometricStore: biometricStore,
            pushDevice: PushDeviceIdentity(store: deviceStore),
            authenticator: FakeBiometrics(),
            now: { fixed }
        )
        return (session, tokens, biometricStore)
    }

    /// `/auth/login` answers `login`; verify answers through `verify`.
    private func backend(login: String = challengeBody, me: StubResponse = .fixture("auth_me_staff"), verify: @escaping (URLRequest) -> StubResponse) {
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/login": return .json(409, login)
            case "/rest/v1/auth/mfa/challenge/verify": return verify(request)
            case "/rest/v1/auth/mfa/challenge/cancel": return .empty(204)
            case "/rest/v1/auth/me": return me
            case "/rest/v1/auth/capabilities": return .fixture("auth_capabilities")
            case "/rest/v1/auth/refresh": return .fixture("auth_refresh")
            default: return .json(404, #"{"message":"Not found."}"#)
            }
        }
    }

    private func signInToChallenge(_ session: SessionCoordinator) async throws {
        await session.start()
        let outcome = try await session.login(email: "sam.staff@example.com", password: "correct horse")
        XCTAssertEqual(outcome, .secondFactorRequired)
    }

    private func assertNothingStored(_ tokens: TokenStore, _ biometricStore: BiometricStore, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(tokens.accessToken(), file: file, line: line)
        XCTAssertNil(tokens.refreshToken(), file: file, line: line)
        XCTAssertNil(tokens.sessionUserId(), file: file, line: line)
        XCTAssertNil(biometricStore.rememberedAccount(), "no remembered account before the session exists", file: file, line: line)
        XCTAssertNil(biometricStore.lastFullAuthenticationAt(), "the 90-day anchor waits for the session", file: file, line: line)
    }

    // MARK: Challenge

    func testEnrolledSignInStopsAtTheCodeScreenAndStoresNothing() async throws {
        backend { _ in .fixture("auth_login") }
        let (session, tokens, biometricStore) = makeSession()
        try await signInToChallenge(session)

        XCTAssertEqual(session.phase, .secondFactor)
        XCTAssertFalse(session.canAccessAuthenticatedUI)
        XCTAssertEqual(AppRoute.resolve(phase: session.phase, presentation: session.user?.presentation, canAccessAuthenticatedUI: session.canAccessAuthenticatedUI), .secondFactor)
        XCTAssertEqual(session.secondFactorChallenge?.email, "sam.staff@example.com")
        XCTAssertEqual(session.lastSignInEmail, "sam.staff@example.com")
        assertNothingStored(tokens, biometricStore)
        XCTAssertEqual(server.requests(to: "/auth/me").count, 0, "no identity call without a session")
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 0)
    }

    func testChallengeTokenNeverAppearsInDescriptions() async throws {
        backend { _ in .fixture("auth_login") }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)
        let challenge = try XCTUnwrap(session.secondFactorChallenge)
        XCTAssertFalse(String(describing: challenge).contains("challenge-secret-1"))
        XCTAssertFalse(String(reflecting: challenge).contains("challenge-secret-1"))
        var dumped = ""
        dump(challenge, to: &dumped)
        XCTAssertFalse(dumped.contains("challenge-secret-1"))
    }

    // MARK: Verify

    func testAuthenticatorCodeIssuesTheSessionThenLoadsIdentity() async throws {
        backend { _ in .fixture("auth_login") }
        let (session, tokens, biometricStore) = makeSession()
        try await signInToChallenge(session)

        let result = await session.verifySecondFactor(code: "482 913", method: .authenticatorCode)

        XCTAssertEqual(result, .signedIn)
        let verify = try XCTUnwrap(server.requests(to: "/auth/mfa/challenge/verify").first)
        XCTAssertEqual(verify.httpMethod, "POST")
        XCTAssertEqual(verify.jsonBody?["challengeToken"] as? String, "challenge-secret-1")
        XCTAssertEqual(verify.jsonBody?["code"] as? String, "482913", "spaces from a pasted code are removed")
        XCTAssertEqual(Set(verify.jsonBody?.keys.map { $0 } ?? []), ["challengeToken", "code"])
        XCTAssertNil(verify.bearer, "the challenge is not a session")
        XCTAssertEqual(verify.value(forHTTPHeaderField: "X-Client-Platform"), "mobile")
        XCTAssertEqual(verify.value(forHTTPHeaderField: "X-Client-Capabilities"), "mfa-verify")

        XCTAssertEqual(tokens.accessToken(), "access-token-1")
        XCTAssertEqual(tokens.refreshToken(), "refresh-token-1")
        XCTAssertEqual(session.phase, .authenticated)
        XCTAssertTrue(session.canAccessAuthenticatedUI)
        XCTAssertNil(session.secondFactorChallenge)
        XCTAssertEqual(biometricStore.rememberedAccount()?.email, "sam.staff@example.com")
        XCTAssertEqual(biometricStore.lastFullAuthenticationAt(), clock)
    }

    func testRecoveryCodeIsSentTrimmed() async throws {
        backend { _ in .fixture("auth_login") }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)

        let result = await session.verifySecondFactor(code: "  7k2m-9qxr-4tzb-8hwe \n", method: .recoveryCode)

        XCTAssertEqual(result, .signedIn)
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/verify").first?.jsonBody?["code"] as? String, "7k2m-9qxr-4tzb-8hwe",
                       "the server normalises case and dashes")
    }

    func testInvalidCodeCarriesTheServersAttemptsAndNeverRefreshes() async throws {
        backend { _ in .json(401, codeInvalidBody(3)) }
        let (session, tokens, biometricStore) = makeSession()
        try await signInToChallenge(session)

        let first = await session.verifySecondFactor(code: "000000", method: .authenticatorCode)

        XCTAssertEqual(first, .failed(.invalidCode(attemptsRemaining: 3)))
        XCTAssertEqual(session.phase, .secondFactor, "the challenge is still usable")
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 0, "a wrong code is not a session failure")
        assertNothingStored(tokens, biometricStore)

        _ = await session.verifySecondFactor(code: "111222", method: .authenticatorCode)
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/verify").count, 2, "the person may try again")
    }

    func testInvalidCodeWithoutAttemptsShowsNoNumber() async throws {
        backend { _ in .json(401, codeInvalidBody(nil)) }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)
        let result = await session.verifySecondFactor(code: "000000", method: .authenticatorCode)
        XCTAssertEqual(result, .failed(.invalidCode(attemptsRemaining: nil)))
    }

    func testZeroAttemptsRemainingMeansStartAgain() async throws {
        backend { _ in .json(401, codeInvalidBody(0)) }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)

        let result = await session.verifySecondFactor(code: "000000", method: .authenticatorCode)
        XCTAssertEqual(result, .failed(.locked))

        let after = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)
        XCTAssertEqual(after, .ignored, "a spent challenge is never sent again")
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/verify").count, 1)
    }

    func testExpiredChallenge() async throws {
        backend { _ in .json(401, expiredBody) }
        let (session, tokens, biometricStore) = makeSession()
        try await signInToChallenge(session)

        let result = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)

        XCTAssertEqual(result, .failed(.expired))
        XCTAssertTrue(SecondFactorFailure.expired.endsChallenge)
        let again = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)
        XCTAssertEqual(again, .ignored)
        assertNothingStored(tokens, biometricStore)
    }

    func testExhaustedChallengeIsLocked() async throws {
        backend { _ in .json(401, exhaustedBody) }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)
        let result = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)
        XCTAssertEqual(result, .failed(.locked))
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 0)
    }

    func testRateLimitIsACooldownNotARestart() async throws {
        backend { _ in .json(429, rateLimitedBody, headers: ["Retry-After": "120"]) }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)

        let result = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)

        guard case .failed(.rateLimited(let message)) = result else {
            return XCTFail("expected a rate limit, got \(result)")
        }
        XCTAssertTrue(message.contains("2 minutes"), message)
        XCTAssertFalse(SecondFactorFailure.rateLimited(message: message).endsChallenge)
        _ = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/verify").count, 2, "still usable after the cooldown")
    }

    func testTimeoutIsNeverResentAutomatically() async throws {
        backend { _ in .failure(.timedOut) }
        let (session, tokens, biometricStore) = makeSession()
        try await signInToChallenge(session)

        let result = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)

        XCTAssertEqual(result, .failed(.connection(message: SecondFactorFailure.connectionMessage)))
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/verify").count, 1, "a code is single-use: no automatic retry")
        XCTAssertEqual(session.phase, .secondFactor)
        assertNothingStored(tokens, biometricStore)
    }

    func testIdentityFailureAfterVerifyWipesTheIssuedSession() async throws {
        backend(me: .json(500, #"{"message":"Internal server error"}"#)) { _ in .fixture("auth_login") }
        let (session, tokens, _) = makeSession()
        try await signInToChallenge(session)

        let result = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)

        guard case .failed(.signInIncomplete) = result else {
            return XCTFail("expected signInIncomplete, got \(result)")
        }
        XCTAssertNil(tokens.accessToken(), "an incomplete sign-in leaves no session behind")
        XCTAssertNil(tokens.refreshToken())
        XCTAssertFalse(session.canAccessAuthenticatedUI)
    }

    // MARK: Cancel

    func testBackToSignInCancelsTheChallengeOnce() async throws {
        backend { _ in .fixture("auth_login") }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)

        await session.cancelSecondFactor()

        let cancel = try XCTUnwrap(server.requests(to: "/auth/mfa/challenge/cancel").first)
        XCTAssertEqual(cancel.jsonBody?["challengeToken"] as? String, "challenge-secret-1")
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/cancel").count, 1)
        XCTAssertEqual(session.phase, .unauthenticated)
        XCTAssertNil(session.secondFactorChallenge)
        XCTAssertEqual(session.lastSignInEmail, "sam.staff@example.com", "the sign-in screen can prefill the email")
    }

    func testSpentChallengeIsNotCancelledAgain() async throws {
        backend { _ in .json(401, expiredBody) }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)
        _ = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)
        await session.cancelSecondFactor()
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/cancel").count, 0)
        XCTAssertEqual(session.phase, .unauthenticated)
    }

    func testReauthSignInReturnsToReauthAfterCancel() async throws {
        backend { _ in .fixture("auth_login") }
        let (session, tokens, _) = makeSession()
        try tokens.store(accessToken: "stored-access", refreshToken: "stored-refresh")
        await session.start()
        XCTAssertEqual(session.phase, .reauthRequired)

        let outcome = try await session.login(email: "sam.staff@example.com", password: "correct horse")
        XCTAssertEqual(outcome, .secondFactorRequired)
        await session.cancelSecondFactor()

        XCTAssertEqual(session.phase, .reauthRequired)
    }

    // MARK: Other 409s

    func testClientUpdateRequiredIsReturnedAndStoresNothing() async throws {
        backend(login: updateRequiredBody) { _ in .fixture("auth_login") }
        let (session, tokens, biometricStore) = makeSession()
        await session.start()

        let outcome = try await session.login(email: "sam.staff@example.com", password: "correct horse")

        guard case .updateRequired(let notice) = outcome else { return XCTFail("expected updateRequired, got \(outcome)") }
        XCTAssertTrue(notice.message.hasPrefix("Update Crewflow to sign in."), "the server's own message")
        XCTAssertNil(notice.updateURL, "no store button without an allowlisted URL")
        XCTAssertEqual(session.phase, .unauthenticated)
        assertNothingStored(tokens, biometricStore)
    }

    func testEnrolRequirementIsCancelledAndExplained() async throws {
        backend(login: enrolChallengeBody) { _ in .fixture("auth_login") }
        let (session, tokens, biometricStore) = makeSession()
        await session.start()

        let outcome = try await session.login(email: "sam.staff@example.com", password: "correct horse")

        guard case .enrolmentRequired(let message) = outcome else { return XCTFail("expected enrolmentRequired, got \(outcome)") }
        XCTAssertTrue(message.contains("on the web"))
        XCTAssertEqual(server.requests(to: "/auth/mfa/challenge/cancel").first?.jsonBody?["challengeToken"] as? String, "challenge-enrol-1")
        XCTAssertEqual(session.phase, .unauthenticated)
        assertNothingStored(tokens, biometricStore)
    }

    func testChallengeWithoutTokenIsAnError() async throws {
        backend(login: #"{"statusCode":409,"code":"SECOND_FACTOR_REQUIRED","requirement":"verify"}"#) { _ in .fixture("auth_login") }
        let (session, tokens, biometricStore) = makeSession()
        await session.start()
        do {
            try await session.login(email: "sam.staff@example.com", password: "x")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? APIError, .decoding("SecondFactorChallenge"))
        }
        XCTAssertEqual(session.phase, .unauthenticated)
        assertNothingStored(tokens, biometricStore)
    }

    // MARK: Header

    func testEveryRequestDeclaresTheMfaVerifyCapability() async throws {
        backend { _ in .fixture("auth_login") }
        let (session, _, _) = makeSession()
        try await signInToChallenge(session)
        _ = await session.verifySecondFactor(code: "123456", method: .authenticatorCode)

        let calls = server.requests
        XCTAssertFalse(calls.isEmpty)
        for request in calls {
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Capabilities"), "mfa-verify", request.url?.path ?? "")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Platform"), "mobile", request.url?.path ?? "")
        }
        XCTAssertEqual(server.requests(to: "/auth/login").count, 1)
    }
}

/// Pure mapping of server answers to the screen's failure states.
final class SecondFactorFailureMappingTests: XCTestCase {
    private func error(_ status: Int, _ json: String, retryAfter: String? = nil) -> APIError {
        APIError.from(status: status, payload: ServerErrorPayload.parse(Data(json.utf8)), retryAfter: retryAfter)
    }

    func testHandlerUnauthorizedCodesAreNotSessionRejections() {
        for body in [codeInvalidBody(2), expiredBody, exhaustedBody] {
            let mapped = error(401, body)
            XCTAssertFalse(mapped.endsSession, body)
            XCTAssertEqual(mapped.statusCode, 401)
            XCTAssertNotNil(mapped.code)
        }
        XCTAssertTrue(error(401, #"{"message":"Invalid or expired access token"}"#).endsSession, "a guard 401 still ends the session")
    }

    func testEveryFailureCode() {
        XCTAssertEqual(SecondFactorFailure.from(error(401, codeInvalidBody(4))), .invalidCode(attemptsRemaining: 4))
        XCTAssertEqual(SecondFactorFailure.from(error(401, codeInvalidBody(1))), .invalidCode(attemptsRemaining: 1))
        XCTAssertEqual(SecondFactorFailure.from(error(401, codeInvalidBody(nil))), .invalidCode(attemptsRemaining: nil))
        XCTAssertEqual(SecondFactorFailure.from(error(401, codeInvalidBody(0))), .locked)
        XCTAssertEqual(SecondFactorFailure.from(error(401, expiredBody)), .expired)
        XCTAssertEqual(SecondFactorFailure.from(error(401, exhaustedBody)), .locked)
        if case .rateLimited(let message) = SecondFactorFailure.from(error(429, rateLimitedBody, retryAfter: "120")) {
            XCTAssertTrue(message.contains("2 minutes"))
        } else {
            XCTFail("429 MFA_RATE_LIMITED is a cooldown")
        }
        XCTAssertEqual(SecondFactorFailure.from(APIError.offline), .connection(message: SecondFactorFailure.connectionMessage))
        XCTAssertEqual(SecondFactorFailure.from(APIError.server(status: 503)), .connection(message: SecondFactorFailure.connectionMessage))
        XCTAssertEqual(SecondFactorFailure.from(error(401, #"{"message":"Please sign in again."}"#)), .expired)
        XCTAssertEqual(SecondFactorFailure.from(error(403, #"{"code":"MFA_WRONG_STEP","message":"This sign-in needs two-factor setup first."}"#)),
                       .rejected(message: "This sign-in needs two-factor setup first."))
    }

    func testNegativeOrFractionalAttemptsAreIgnored() {
        XCTAssertEqual(SecondFactorFailure.from(error(401, #"{"code":"MFA_CODE_INVALID","message":"x","attemptsRemaining":2.5}"#)), .invalidCode(attemptsRemaining: nil))
        XCTAssertEqual(SecondFactorFailure.from(error(401, #"{"code":"MFA_CODE_INVALID","message":"x","attemptsRemaining":"3"}"#)), .invalidCode(attemptsRemaining: nil))
    }

    func testUpdateURLOnlyWhenAllowlisted() {
        XCTAssertEqual(ClientUpdateRequired.allowlistedStoreURL("https://apps.apple.com/app/id123")?.absoluteString, "https://apps.apple.com/app/id123")
        XCTAssertNil(ClientUpdateRequired.allowlistedStoreURL("http://apps.apple.com/app/id123"))
        XCTAssertNil(ClientUpdateRequired.allowlistedStoreURL("https://apps.apple.com.evil.example/app"))
        XCTAssertNil(ClientUpdateRequired.allowlistedStoreURL("https://evil.example/apps.apple.com"))
        XCTAssertNil(ClientUpdateRequired.allowlistedStoreURL("https://user:pw@apps.apple.com/app"))
        XCTAssertNil(ClientUpdateRequired.allowlistedStoreURL("itms-apps://apps.apple.com/app"))
        XCTAssertNil(ClientUpdateRequired.allowlistedStoreURL(nil))
    }

    func testUpdateRequiredFallsBackToDesignCopy() {
        let payload = ServerErrorPayload.parse(Data(#"{"code":"CLIENT_UPDATE_REQUIRED","message":"x"}"#.utf8))
        XCTAssertEqual(ClientUpdateRequired(payload: payload).message, ClientUpdateRequired.defaultMessage)
    }

    func testInputNormalisation() {
        XCTAssertEqual(SessionCoordinator.normalisedSecondFactorInput(" 482 913 ", method: .authenticatorCode), "482913")
        XCTAssertEqual(SessionCoordinator.normalisedSecondFactorInput("4８2913", method: .authenticatorCode), "42913", "only ASCII digits")
        XCTAssertEqual(SessionCoordinator.normalisedSecondFactorInput("  abcd-efgh ", method: .recoveryCode), "abcd-efgh")
    }

    func testOnlySelfServiceTwoFactorRoutesRefresh() {
        XCTAssertTrue(APIClient.refreshEligible("/auth/mfa"))
        XCTAssertTrue(APIClient.refreshEligible("/auth/mfa/enrolment"))
        XCTAssertTrue(APIClient.refreshEligible("/auth/mfa/enrolment/confirm"))
        XCTAssertTrue(APIClient.refreshEligible("/auth/mfa/recovery-codes"))
        XCTAssertTrue(APIClient.refreshEligible("/auth/mfa/disable"))
        XCTAssertFalse(APIClient.refreshEligible("/auth/mfa/challenge/verify"))
        XCTAssertFalse(APIClient.refreshEligible("/auth/mfa/challenge/cancel"))
        XCTAssertFalse(APIClient.refreshEligible("/auth/login"))
        XCTAssertFalse(APIClient.refreshEligible("/auth/refresh"))
        XCTAssertFalse(APIClient.refreshEligible("/auth/mfaX"))
    }
}

import XCTest
@testable import Crewflow

@MainActor
final class SessionCoordinatorTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }
    private var deviceStore: InMemorySecureStore!
    private var sessionStore: InMemorySecureStore!
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUp() async throws {
        server.reset()
        deviceStore = InMemorySecureStore()
        sessionStore = InMemorySecureStore()
    }

    private func makeSession(biometrics: FakeBiometrics = FakeBiometrics()) -> (SessionCoordinator, TokenStore, BiometricStore) {
        let (client, tokens) = makeClient(store: sessionStore)
        let biometricStore = BiometricStore(store: deviceStore)
        let session = SessionCoordinator(
            api: client,
            tokens: tokens,
            biometricStore: biometricStore,
            pushDevice: PushDeviceIdentity(store: deviceStore),
            authenticator: biometrics,
            now: { [unowned self] in self.clock }
        )
        return (session, tokens, biometricStore)
    }

    /// Standard backend: login → tokens, /auth/me → staff, capabilities, logout 204.
    private func standardBackend(me: String = "auth_me_staff") {
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/login": return .fixture("auth_login")
            case "/rest/v1/auth/me": return .fixture(me)
            case "/rest/v1/auth/capabilities": return .fixture("auth_capabilities")
            case "/rest/v1/auth/logout": return .empty(204)
            default: return .json(404, #"{"message":"Not found."}"#)
            }
        }
    }

    func testLoginSendsOnlyEmailAndPasswordThenLoadsIdentity() async throws {
        standardBackend()
        let (session, tokens, biometricStore) = makeSession()
        await session.start()
        XCTAssertEqual(session.phase, .unauthenticated)

        try await session.login(email: "sam.staff@example.com", password: "correct horse")

        let login = try XCTUnwrap(server.requests(to: "/auth/login").first)
        XCTAssertEqual(login.httpMethod, "POST")
        XCTAssertEqual(Set(login.jsonBody?.keys.map { $0 } ?? []), ["email", "password"], "no applicationTarget, no organisationId")
        XCTAssertEqual(login.value(forHTTPHeaderField: "X-Client-Platform"), "mobile")
        XCTAssertNil(login.bearer)

        let me = try XCTUnwrap(server.requests(to: "/auth/me").first)
        XCTAssertEqual(me.bearer, "Bearer access-token-1")

        XCTAssertEqual(session.phase, .authenticated, "no biometrics available → straight in")
        XCTAssertTrue(session.canAccessAuthenticatedUI)
        XCTAssertEqual(session.presentation, .staff)
        XCTAssertEqual(tokens.refreshToken(), "refresh-token-1")
        XCTAssertEqual(tokens.sessionUserId(), "6f1c1c3e-2c8e-4b4e-9d4f-0a1b2c3d4e5f")
        XCTAssertEqual(biometricStore.rememberedAccount()?.email, "sam.staff@example.com")
        XCTAssertEqual(biometricStore.lastFullAuthenticationAt(), clock)

        // Capabilities are loaded after authentication (display hints only).
        try await waitUntil { session.capabilities != .none }
        XCTAssertTrue(session.capabilities.allows(.reportView))
    }

    func testMustResetPasswordRoutesToSetPassword() async throws {
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/login": return .fixture("auth_login")
            case "/rest/v1/auth/me":
                return .json(200, #"{"id":"u1","email":"a@b.c","firstName":"A","lastName":"B","organisationId":"o1","roles":["staff"],"mustResetPassword":true}"#)
            default: return .empty(204)
            }
        }
        let (session, _, _) = makeSession(biometrics: FakeBiometrics(available: BiometricCapability(hasHardware: true, isEnrolled: true, kind: .faceID), result: .success))
        await session.start()
        try await session.login(email: "a@b.c", password: "temporary")
        XCTAssertEqual(session.phase, .mustResetPassword)
        XCTAssertEqual(AppRoute.resolve(phase: session.phase, presentation: session.user?.presentation, canAccessAuthenticatedUI: session.canAccessAuthenticatedUI), .setPassword)
    }

    func testWrongPasswordLeavesNoSession() async throws {
        server.setHandler { _ in .json(401, #"{"message":"Invalid email or password."}"#) }
        let (session, tokens, _) = makeSession()
        await session.start()
        do {
            try await session.login(email: "a@b.c", password: "wrong")
            XCTFail("expected 401")
        } catch {
            XCTAssertEqual(LoginErrorText.message(for: error), LoginErrorText.invalidCredentials)
        }
        XCTAssertEqual(session.phase, .unauthenticated)
        XCTAssertNil(tokens.accessToken())
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 0, "/auth/login never triggers a refresh")
    }

    func testLoginLockoutStartsLocalCooldown() async throws {
        server.setHandler { _ in
            .json(429, #"{"message":"Too many sign-in attempts. Please try again in 15 minutes.","retryAfter":900}"#, headers: ["Retry-After": "900"])
        }
        let (session, _, _) = makeSession()
        await session.start()
        do { try await session.login(email: "a@b.c", password: "x") } catch {}
        XCTAssertEqual(session.loginCooldownUntil, clock.addingTimeInterval(900))
        do {
            try await session.login(email: "a@b.c", password: "x")
            XCTFail("cooling down")
        } catch {
            if case .rateLimited = error as? APIError {} else { XCTFail("expected local rate limit") }
        }
        XCTAssertEqual(server.requests(to: "/auth/login").count, 1, "no request while cooling down")
    }

    func testLogoutRevokesServerSideThenWipesLocalSession() async throws {
        standardBackend()
        let (session, tokens, biometricStore) = makeSession()
        await session.start()
        try await session.login(email: "sam.staff@example.com", password: "pw")
        let epochBefore = session.epoch

        await session.logout()

        let logout = try XCTUnwrap(server.requests(to: "/auth/logout").first)
        XCTAssertEqual(logout.jsonBody?["refreshToken"] as? String, "refresh-token-1")
        XCTAssertEqual(logout.bearer, "Bearer access-token-1")
        XCTAssertNil(tokens.accessToken())
        XCTAssertNil(tokens.refreshToken())
        XCTAssertNil(session.user)
        XCTAssertEqual(session.phase, .unauthenticated)
        XCTAssertGreaterThan(session.epoch, epochBefore)
        // Normal logout keeps the remembered account (Flutter parity).
        XCTAssertEqual(biometricStore.rememberedAccount()?.email, "sam.staff@example.com")
    }

    func testLogoutDeactivatesRegisteredPushDeviceFirst() async throws {
        standardBackend()
        let (session, _, _) = makeSession()
        await session.start()
        try await session.login(email: "sam.staff@example.com", password: "pw")
        let push = PushDeviceIdentity(store: deviceStore)
        let deviceId = push.deviceId()
        XCTAssertNotNil(UUID(uuidString: deviceId), "deviceId must be a UUID or deactivate 404s")
        try push.markRegistered(userId: "6f1c1c3e-2c8e-4b4e-9d4f-0a1b2c3d4e5f")

        await session.logout()

        let paths = server.requests.map { $0.url!.path }
        let deactivate = try XCTUnwrap(paths.firstIndex(of: "/rest/v1/push/devices/\(deviceId)/deactivate"))
        let logout = try XCTUnwrap(paths.firstIndex(of: "/rest/v1/auth/logout"))
        XCTAssertLessThan(deactivate, logout)
        XCTAssertNil(push.registeredUserId())
    }

    func testResponseFromPreviousIdentityIsDropped() async throws {
        let arrived = expectation(description: "/auth/me reached the server")
        let release = DispatchSemaphore(value: 0)
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/login": return .fixture("auth_login")
            case "/rest/v1/auth/me":
                arrived.fulfill()
                _ = release.wait(timeout: .now() + 5)
                return .fixture("auth_me_staff")
            default: return .empty(204)
            }
        }
        let (session, tokens, _) = makeSession()
        await session.start()
        let login = Task { try? await session.login(email: "sam.staff@example.com", password: "pw") }
        await fulfillment(of: [arrived], timeout: 2)
        await session.logout() // identity changes while /auth/me is in flight
        release.signal()
        _ = await login.value

        XCTAssertNil(session.user, "a response from the old epoch must never install a user")
        XCTAssertEqual(session.phase, .unauthenticated)
        XCTAssertNil(tokens.accessToken())
    }

    func testColdLaunchWithStoredSessionStillRequiresPresence() async throws {
        standardBackend()
        try TokenStore(store: sessionStore).store(accessToken: "A", refreshToken: "R")
        let (session, tokens, _) = makeSession()
        await session.start()
        XCTAssertEqual(session.phase, .reauthRequired, "a restored server identity is not proof of local presence")
        XCTAssertFalse(session.canAccessAuthenticatedUI)
        XCTAssertNotNil(session.user)
        XCTAssertEqual(tokens.accessToken(), "A")
    }

    func testColdLaunchKeepsSessionOn503AndOn403() async throws {
        try TokenStore(store: sessionStore).store(accessToken: "A", refreshToken: "R")
        server.setHandler { _ in .json(503, #"{"code":"AUTH_UNAVAILABLE","message":"Sign-in could not be checked right now. Try again in a moment."}"#) }
        let (session, tokens, _) = makeSession()
        await session.start()
        XCTAssertEqual(session.phase, .unauthenticated)
        XCTAssertEqual(tokens.refreshToken(), "R", "AUTH_UNAVAILABLE never logs out")

        server.setHandler { _ in .json(403, #"{"code":"APPLICATION_ACCESS_DENIED","message":"This account does not have access to the Staff app."}"#) }
        let (second, secondTokens, _) = makeSession()
        await second.start()
        XCTAssertEqual(secondTokens.refreshToken(), "R", "403 application denials are not logouts")
    }

    func testBiometricUnlockAsksTheServer() async throws {
        standardBackend()
        let staffId = "6f1c1c3e-2c8e-4b4e-9d4f-0a1b2c3d4e5f"
        let tokens = TokenStore(store: sessionStore)
        try tokens.store(accessToken: "A", refreshToken: "R")
        try tokens.setSessionUserId(staffId)
        let store = BiometricStore(store: deviceStore)
        try store.setRememberedAccount(userId: staffId, email: "sam.staff@example.com")
        try store.setLastFullAuthenticationAt(clock.addingTimeInterval(-86_400))
        try store.confirmBiometric(userId: staffId, at: clock.addingTimeInterval(-3_600))

        let faceID = BiometricCapability(hasHardware: true, isEnrolled: true, kind: .faceID)
        let (session, _, _) = makeSession(biometrics: FakeBiometrics(available: faceID, result: .success))
        await session.start()
        XCTAssertEqual(session.phase, .biometricLocked)
        XCTAssertEqual(server.requests.count, 0, "nothing is fetched before local presence")

        let outcome = await session.attemptBiometricUnlock()
        XCTAssertEqual(outcome, .success)
        XCTAssertEqual(session.phase, .authenticated)
        XCTAssertEqual(server.requests(to: "/auth/me").count, 1)
    }

    func testBiometricTrustExpiresNinetyDaysAfterPasswordSignIn() async throws {
        let staffId = "6f1c1c3e-2c8e-4b4e-9d4f-0a1b2c3d4e5f"
        let tokens = TokenStore(store: sessionStore)
        try tokens.store(accessToken: "A", refreshToken: "R")
        try tokens.setSessionUserId(staffId)
        let store = BiometricStore(store: deviceStore)
        try store.setRememberedAccount(userId: staffId, email: "sam.staff@example.com")
        try store.setLastFullAuthenticationAt(clock.addingTimeInterval(-91 * 86_400))
        try store.confirmBiometric(userId: staffId, at: clock.addingTimeInterval(-3_600)) // recent re-confirmation must not extend trust

        let faceID = BiometricCapability(hasHardware: true, isEnrolled: true, kind: .faceID)
        let (session, _, _) = makeSession(biometrics: FakeBiometrics(available: faceID, result: .success))
        await session.start()
        XCTAssertEqual(session.phase, .reauthRequired)
    }

    func testForcedLogoutWhenRefreshIsRejected() async throws {
        standardBackend()
        let (session, tokens, _) = makeSession()
        await session.start()
        try await session.login(email: "sam.staff@example.com", password: "pw")

        // The session family was revoked elsewhere (password reset, admin).
        server.setHandler { request in
            request.url!.path.hasSuffix("/auth/refresh")
                ? .json(401, #"{"message":"Invalid refresh token"}"#)
                : .json(401, #"{"message":"Please sign in again."}"#)
        }
        do {
            try await session.refreshUser()
            XCTFail("expected 401")
        } catch {}
        try await waitUntil { session.phase == .unauthenticated }
        XCTAssertNil(session.user)
        XCTAssertTrue(session.sessionExpiredNotice)
        XCTAssertNil(tokens.refreshToken())
    }

    func testDeepLinkNeverSignsOut() async throws {
        standardBackend()
        let (session, tokens, _) = makeSession()
        await session.start()
        try await session.login(email: "sam.staff@example.com", password: "pw")
        session.handleOpenURL(URL(string: "rab://login")!)
        XCTAssertEqual(session.phase, .authenticated)
        XCTAssertNotNil(tokens.accessToken())
        XCTAssertEqual(server.requests(to: "/auth/logout").count, 0)
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("condition not met in time"); return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }
}

final class RoutingTests: XCTestCase {
    private func user(_ roles: [String], admin: Bool = false) -> CurrentUser {
        CurrentUser(id: "u", email: "e@x.y", firstName: "F", lastName: "L", organisationId: "o", roles: roles, isPlatformAdmin: admin)
    }

    func testPresentationRulesMatchFlutter() {
        XCTAssertEqual(user(["staff"]).presentation, .staff)
        XCTAssertEqual(user(["venue_manager"]).presentation, .venueManager)
        XCTAssertEqual(user(["staff", "venue_manager"]).presentation, .venueManager, "venue_manager wins")
        XCTAssertEqual(user(["manager", "staff"]).presentation, .manager)
        XCTAssertEqual(user(["ceo"]).presentation, .manager)
        XCTAssertEqual(user(["staff"], admin: true).presentation, .admin)
        XCTAssertEqual(user(["org_admin"]).presentation, .unsupported)
        XCTAssertEqual(user(["custom_rota_viewer"]).presentation, .unsupported)
        XCTAssertEqual(user([]).presentation, .unsupported)
    }

    func testRouteResolution() {
        XCTAssertEqual(AppRoute.resolve(phase: .loading, presentation: nil, canAccessAuthenticatedUI: false), .loading)
        XCTAssertEqual(AppRoute.resolve(phase: .unauthenticated, presentation: nil, canAccessAuthenticatedUI: false), .signIn(reauth: false))
        XCTAssertEqual(AppRoute.resolve(phase: .reauthRequired, presentation: .staff, canAccessAuthenticatedUI: false), .signIn(reauth: true))
        XCTAssertEqual(AppRoute.resolve(phase: .biometricLocked, presentation: nil, canAccessAuthenticatedUI: false), .biometricUnlock)
        XCTAssertEqual(AppRoute.resolve(phase: .offeringBiometricSetup, presentation: .staff, canAccessAuthenticatedUI: false), .biometricSetup)
        XCTAssertEqual(AppRoute.resolve(phase: .mustResetPassword, presentation: .staff, canAccessAuthenticatedUI: false), .setPassword)
        XCTAssertEqual(AppRoute.resolve(phase: .authenticated, presentation: .staff, canAccessAuthenticatedUI: true), .staff)
        XCTAssertEqual(AppRoute.resolve(phase: .authenticated, presentation: .venueManager, canAccessAuthenticatedUI: true), .venueManager)
        XCTAssertEqual(AppRoute.resolve(phase: .authenticated, presentation: .manager, canAccessAuthenticatedUI: true), .console(unsupported: false))
        XCTAssertEqual(AppRoute.resolve(phase: .authenticated, presentation: .admin, canAccessAuthenticatedUI: true), .console(unsupported: false))
        XCTAssertEqual(AppRoute.resolve(phase: .authenticated, presentation: .unsupported, canAccessAuthenticatedUI: true), .console(unsupported: true))
        // Authenticated but still locked never shows a shell.
        XCTAssertEqual(AppRoute.resolve(phase: .authenticated, presentation: .staff, canAccessAuthenticatedUI: false), .signIn(reauth: false))
    }
}

@MainActor
final class ToastCenterTests: XCTestCase {
    func testErrorsOnlyPolicyDropsSuccessToasts() {
        let center = ToastCenter(policy: .errorsOnly, announcer: { _ in })
        XCTAssertFalse(center.show("Review saved.", kind: .success))
        XCTAssertFalse(center.show("Heads up", kind: .info))
        XCTAssertTrue(center.show("The PDF could not be saved.", kind: .error))
        XCTAssertEqual(center.visible.count, 1)
    }

    func testDedupeQueueAndPromotion() {
        var spoken: [String] = []
        let center = ToastCenter(policy: .all, announcer: { spoken.append($0) })
        XCTAssertTrue(center.show("One", kind: .error))
        XCTAssertFalse(center.show("One", kind: .error), "duplicate ignored")
        center.show("Two", kind: .error)
        center.show("Three", kind: .error)
        center.show("Four", kind: .error)
        XCTAssertEqual(center.visible.map(\.message), ["One", "Two", "Three"])
        XCTAssertEqual(center.queued.map(\.message), ["Four"])
        center.dismiss(center.visible[0].id)
        XCTAssertEqual(center.visible.map(\.message), ["Two", "Three", "Four"])
        XCTAssertEqual(spoken.first, "Error. One")
        center.dismissAll()
        XCTAssertTrue(center.visible.isEmpty)
        XCTAssertTrue(center.queued.isEmpty)
    }

    func testShowErrorUsesNormaliserAndSkipsCancellations() {
        let center = ToastCenter(policy: .errorsOnly, announcer: { _ in })
        XCTAssertFalse(center.showError(APIError.cancelled))
        XCTAssertFalse(center.showError(APIError.sessionChanged))
        XCTAssertTrue(center.showError(APIError.offline))
        XCTAssertEqual(center.visible.first?.message, APIMessages.offline)
        XCTAssertEqual(center.visible.first?.duration, ToastCenter.longDuration)
    }

    func testPauseHoldsTheRemainingTime() {
        var now = Date(timeIntervalSince1970: 0)
        let center = ToastCenter(policy: .all, announcer: { _ in }, now: { now })
        center.show("Hold me", kind: .error)
        let id = center.visible[0].id
        now = now.addingTimeInterval(3.5)
        center.pause(id)
        XCTAssertEqual(center.remainingFraction(for: id, at: now.addingTimeInterval(100)), 0.5, accuracy: 0.001)
        center.resume(id)
        XCTAssertEqual(center.remainingFraction(for: id, at: now.addingTimeInterval(1.75)), 0.25, accuracy: 0.001)
    }
}

final class ConfigurationTests: XCTestCase {
    func testPlaceholderHostIsRefused() {
        XCTAssertEqual(AppConfiguration.resolve(apiBaseURL: "https://dev-host.invalid/rest/v1", consoleURL: nil, isDebugBuild: true), .failure(.placeholder))
    }

    func testMissingOrUnexpandedIsRefused() {
        XCTAssertEqual(AppConfiguration.resolve(apiBaseURL: nil, consoleURL: nil, isDebugBuild: false), .failure(.missing))
        XCTAssertEqual(AppConfiguration.resolve(apiBaseURL: "$(API_BASE_URL)", consoleURL: nil, isDebugBuild: false), .failure(.missing))
    }

    func testReleaseRequiresHTTPSAndDebugAllowsLAN() {
        XCTAssertEqual(AppConfiguration.resolve(apiBaseURL: "http://192.168.1.20:3000/rest/v1", consoleURL: nil, isDebugBuild: false), .failure(.insecure))
        guard case .success(let debug) = AppConfiguration.resolve(apiBaseURL: "http://192.168.1.20:3000/rest/v1/", consoleURL: "http://192.168.1.20:5173", isDebugBuild: true) else {
            return XCTFail("debug LAN should be accepted")
        }
        XCTAssertEqual(debug.apiBaseURL.absoluteString, "http://192.168.1.20:3000/rest/v1")
        XCTAssertNotNil(debug.consoleURL)
    }

    func testPathMustIncludeRestPrefix() {
        XCTAssertEqual(AppConfiguration.resolve(apiBaseURL: "https://api.example.com", consoleURL: nil, isDebugBuild: false), .failure(.wrongPath))
    }

    func testInsecureConsoleIsDroppedInRelease() {
        guard case .success(let config) = AppConfiguration.resolve(apiBaseURL: "https://api.example.com/rest/v1", consoleURL: "http://console.example.com", isDebugBuild: false) else {
            return XCTFail("valid API URL")
        }
        XCTAssertNil(config.consoleURL)
    }

    func testLoginErrorTextIsUniform() {
        XCTAssertEqual(LoginErrorText.message(for: APIError.unauthorized(message: "Invalid email or password.")), "Invalid email or password.")
        XCTAssertEqual(LoginErrorText.message(for: APIError.offline), LoginErrorText.unreachable)
        XCTAssertEqual(LoginErrorText.message(for: APIError.server(status: 503)), LoginErrorText.unavailable)
        XCTAssertEqual(LoginErrorText.message(for: APIError.forbidden(ServerErrorPayload(message: "This account does not have access to the Staff app.", code: "APPLICATION_ACCESS_DENIED"))),
                       "This account does not have access to the Staff app.")
    }
}

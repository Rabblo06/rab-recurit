import XCTest
@testable import Crewflow

/// Phase C1b push readiness: the registration payload, permission only on an
/// explicit call, no registration for another (or no) signed-in person, and
/// sign-out naming the device so the server deactivates exactly it.
///
/// Written, not run (no macOS here): never compiled or executed.
@MainActor
final class PushRegistrationTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }
    private static let userId = "6f1c1c3e-2c8e-4b4e-9d4f-0a1b2c3d4e5f"

    override func setUp() async throws {
        try await super.setUp()
        URLProtocolStub.server.reset()
    }

    final class FakeAuthorizer: PushAuthorizing {
        var grant = true
        private(set) var permissionRequests = 0
        private(set) var registrations = 0

        func requestAuthorization() async -> Bool {
            permissionRequests += 1
            return grant
        }

        func registerForRemoteNotifications() {
            registrations += 1
        }
    }

    final class SignedIn {
        var userId: String?
        init(_ userId: String?) { self.userId = userId }
    }

    private func makeRegistrar(
        authorizer: FakeAuthorizer,
        signedIn: SignedIn,
        identity: PushDeviceIdentity
    ) -> PushRegistrar {
        let (client, tokens) = makeClient()
        try? tokens.store(accessToken: "ACCESS", refreshToken: "R")
        return PushRegistrar(
            api: client,
            identity: identity,
            authorizer: authorizer,
            currentUserId: { signedIn.userId },
            appVersion: "0.1.0"
        )
    }

    func testRegistersTheKeychainDeviceIdWithTheHexAPNsToken() async throws {
        server.setHandler { _ in .json(201, #"{"id":"d1"}"#) }
        let authorizer = FakeAuthorizer()
        let identity = PushDeviceIdentity(store: InMemorySecureStore())
        let registrar = makeRegistrar(authorizer: authorizer, signedIn: SignedIn(Self.userId), identity: identity)

        await registrar.enable(for: Self.userId)
        XCTAssertEqual(authorizer.permissionRequests, 1)
        XCTAssertEqual(authorizer.registrations, 1)
        XCTAssertEqual(registrar.state, .waitingForToken)

        await registrar.didReceive(deviceToken: Data([0x0a, 0x0b, 0xff, 0x00]))

        let post = try XCTUnwrap(server.requests(to: "/push/devices").first)
        XCTAssertEqual(post.httpMethod, "POST")
        let body = try XCTUnwrap(post.jsonBody)
        XCTAssertEqual(Set(body.keys), ["deviceId", "platform", "pushToken", "appVersion"], "no user / organisation field")
        XCTAssertEqual(body["platform"] as? String, "ios")
        XCTAssertEqual(body["pushToken"] as? String, "0a0bff00")
        let deviceId = try XCTUnwrap(body["deviceId"] as? String)
        XCTAssertNotNil(UUID(uuidString: deviceId), "a UUID, or deactivate 404s")
        XCTAssertEqual(deviceId, identity.deviceId(), "the stable Keychain id")
        XCTAssertEqual(identity.registeredUserId(), Self.userId, "markRegistered makes sign-out deactivate it")
        XCTAssertEqual(registrar.state, .registered)
    }

    func testDeniedPermissionRegistersNothing() async {
        let authorizer = FakeAuthorizer()
        authorizer.grant = false
        let identity = PushDeviceIdentity(store: InMemorySecureStore())
        let registrar = makeRegistrar(authorizer: authorizer, signedIn: SignedIn(Self.userId), identity: identity)
        await registrar.enable(for: Self.userId)
        XCTAssertEqual(registrar.state, .denied)
        XCTAssertEqual(authorizer.registrations, 0)
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testNothingHappensWithoutAnExplicitRequest() async {
        let authorizer = FakeAuthorizer()
        let identity = PushDeviceIdentity(store: InMemorySecureStore())
        let registrar = makeRegistrar(authorizer: authorizer, signedIn: SignedIn(Self.userId), identity: identity)
        // A token the OS hands over without this person having asked.
        await registrar.didReceive(deviceToken: Data([0x01]))
        XCTAssertEqual(authorizer.permissionRequests, 0)
        XCTAssertTrue(server.requests.isEmpty)
        XCTAssertNil(identity.registeredUserId())
    }

    func testATokenAfterSignOutIsNeverRegisteredForTheNextPerson() async {
        server.setHandler { _ in .json(201, #"{"id":"d1"}"#) }
        let authorizer = FakeAuthorizer()
        let signedIn = SignedIn(Self.userId)
        let identity = PushDeviceIdentity(store: InMemorySecureStore())
        let registrar = makeRegistrar(authorizer: authorizer, signedIn: signedIn, identity: identity)
        await registrar.enable(for: Self.userId)

        signedIn.userId = "0b6f7c1e-1111-4222-8333-444455556666" // another account now
        await registrar.didReceive(deviceToken: Data([0x01]))
        XCTAssertTrue(server.requests.isEmpty)
        XCTAssertNil(identity.registeredUserId())
    }

    // MARK: Sign-out deactivation

    private func standardBackend(logoutStatus: @escaping (URLRequest) -> StubResponse = { _ in .empty(204) }) {
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/login": return .fixture("auth_login")
            case "/rest/v1/auth/me": return .fixture("auth_me_staff")
            case "/rest/v1/auth/capabilities": return .fixture("auth_capabilities")
            case "/rest/v1/auth/logout": return logoutStatus(request)
            default: return .empty(204)
            }
        }
    }

    private func signedInSession(deviceStore: InMemorySecureStore) async throws -> SessionCoordinator {
        let (client, tokens) = makeClient(store: InMemorySecureStore())
        let session = SessionCoordinator(
            api: client,
            tokens: tokens,
            biometricStore: BiometricStore(store: deviceStore),
            pushDevice: PushDeviceIdentity(store: deviceStore),
            authenticator: FakeBiometrics()
        )
        await session.start()
        try await session.login(email: "sam.staff@example.com", password: "pw")
        return session
    }

    func testLogoutNamesTheRegisteredDeviceAndStillDeactivatesItFirst() async throws {
        standardBackend()
        let deviceStore = InMemorySecureStore()
        let session = try await signedInSession(deviceStore: deviceStore)
        let push = PushDeviceIdentity(store: deviceStore)
        let deviceId = push.deviceId()
        try push.markRegistered(userId: Self.userId)

        await session.logout()

        let paths = server.requests.map { $0.url!.path }
        let deactivate = try XCTUnwrap(paths.firstIndex(of: "/rest/v1/push/devices/\(deviceId)/deactivate"))
        let logoutIndex = try XCTUnwrap(paths.firstIndex(of: "/rest/v1/auth/logout"))
        XCTAssertLessThan(deactivate, logoutIndex, "the explicit deactivate is kept, before the revoke")
        let logout = try XCTUnwrap(server.requests(to: "/auth/logout").first)
        XCTAssertEqual(logout.jsonBody?["pushDeviceId"] as? String, deviceId, "the server deactivates exactly this device")
        XCTAssertNotNil(logout.jsonBody?["refreshToken"] as? String)
        XCTAssertNil(push.registeredUserId())
    }

    func testLogoutWithoutARegisteredDeviceSendsNoDeviceId() async throws {
        standardBackend()
        let session = try await signedInSession(deviceStore: InMemorySecureStore())
        await session.logout()
        let logout = try XCTUnwrap(server.requests(to: "/auth/logout").first)
        XCTAssertEqual(Set(logout.jsonBody?.keys.map { $0 } ?? []), ["refreshToken"])
        XCTAssertTrue(server.requests(containing: "/push/devices").isEmpty)
    }

    func testAnOlderServerRejectingTheFieldStillRevokesTheSession() async throws {
        // forbidNonWhitelisted answers 400 BEFORE the handler: nothing was
        // revoked, so the plain body is sent once more.
        standardBackend { request in
            if request.jsonBody?["pushDeviceId"] != nil {
                return .json(400, #"{"statusCode":400,"message":["property pushDeviceId should not exist"],"error":"Bad Request"}"#)
            }
            return .empty(204)
        }
        let deviceStore = InMemorySecureStore()
        let session = try await signedInSession(deviceStore: deviceStore)
        try PushDeviceIdentity(store: deviceStore).markRegistered(userId: Self.userId)

        await session.logout()

        let logouts = server.requests(to: "/auth/logout")
        XCTAssertEqual(logouts.count, 2)
        XCTAssertNotNil(logouts.first?.jsonBody?["pushDeviceId"])
        XCTAssertNil(logouts.last?.jsonBody?["pushDeviceId"])
        XCTAssertNotNil(logouts.last?.jsonBody?["refreshToken"])
    }

    func testAPNsTokenHex() {
        XCTAssertEqual(PushRegistrar.hex(Data([0x00, 0x01, 0xab, 0xff])), "0001abff")
    }

    /// C1 security review F3: a foreground arrival is not user activity (the shells reconcile background-flagged, so a
    /// push cannot slide the idle window of an unattended phone); a tap is. Anything else reads as not user-initiated.
    func testPushActivityDistinguishesArrivalFromTap() {
        func note(_ userInfo: [AnyHashable: Any]?) -> Notification {
            Notification(name: .crewflowPushActivity, object: nil, userInfo: userInfo)
        }
        XCTAssertFalse(PushActivity.isUserInitiated(note([PushActivity.userInitiatedKey: false])))
        XCTAssertTrue(PushActivity.isUserInitiated(note([PushActivity.userInitiatedKey: true])))
        XCTAssertFalse(PushActivity.isUserInitiated(note(nil)))
        XCTAssertFalse(PushActivity.isUserInitiated(note([PushActivity.userInitiatedKey: "yes"])))
    }
}

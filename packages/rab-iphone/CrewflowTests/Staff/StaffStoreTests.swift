import XCTest
@testable import Crewflow

/// The Staff store and attendance flow against the stub server: retry
/// policy (never resend clock-in/out/accept/decline), reconcile-after-
/// uncertain, check-in without location where the geofence is off, error
/// code text, and fail-closed loading states.
final class StaffStoreTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }

    override func setUp() {
        super.setUp()
        URLProtocolStub.server.reset()
    }

    private func path(_ request: URLRequest) -> String { request.url?.path ?? "" }

    private func decodeOffer(_ json: String) throws -> StaffOfferSummary {
        try StaffFixtures.decode(StaffOfferSummary.self, json)
    }

    // MARK: Clock-in is never retried automatically

    @MainActor
    func testClockInTimeoutIsNotResentAndTheStateIsReloadedFirst() async {
        let open = StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil)
        server.setHandler { request in
            switch request.url?.path ?? "" {
            case let p where p.hasSuffix("/attendance/clock-in"): return .failure(.timedOut)
            case let p where p.hasSuffix("/attendance/me/active"): return .json(200, StaffFixtures.activeJSON(attendance: open))
            case let p where p.hasSuffix("/check-in"): return .json(200, StaffFixtures.checkInStateJSON(checkInRequired: false))
            default: return .json(404, #"{"message":"Not found."}"#)
            }
        }
        let store = makeStaffStore()
        let ok = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "token", location: nil)
        XCTAssertEqual(server.requests(to: "/attendance/clock-in").count, 1, "an uncertain clock-in is NEVER resent")
        XCTAssertEqual(server.requests(to: "/attendance/me/active").count, 1, "the state is re-fetched instead")
        XCTAssertTrue(ok, "the server shows the clock-in landed, so it is reported as done")
        XCTAssertEqual(store.liveAttendance?.shiftId, StaffFixtures.shiftId)
        XCTAssertNil(store.attendanceError)
    }

    @MainActor
    func testClockIn502IsNotResentAndAsksThePersonToCheckFirst() async {
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/attendance/clock-in") { return .json(502, "") }
            if path.hasSuffix("/attendance/me/active") { return .json(200, StaffFixtures.activeJSON()) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let ok = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "token", location: nil)
        XCTAssertFalse(ok)
        XCTAssertEqual(server.requests(to: "/attendance/clock-in").count, 1)
        XCTAssertEqual(store.attendanceError?.message, StaffAttendanceMessages.uncertainClockIn)
        XCTAssertNil(store.liveAttendance, "nothing optimistic")
    }

    @MainActor
    func testClockOutTimeoutIsNotResent() async throws {
        let open = StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil)
        var activeAnswer = StaffFixtures.activeJSON(attendance: open)
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/attendance/clock-out") { return .failure(.networkConnectionLost) }
            if path.hasSuffix("/attendance/me/active") { return .json(200, activeAnswer) }
            if path.hasSuffix("/attendance/me/history") { return .json(200, "[]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        await store.refreshActive()
        XCTAssertNotNil(store.liveAttendance)
        activeAnswer = StaffFixtures.activeJSON(attendance: open) // still clocked in on the server
        let ok = await store.clockOut(qrToken: "token", location: nil)
        XCTAssertFalse(ok)
        XCTAssertEqual(server.requests(to: "/attendance/clock-out").count, 1, "never resent")
        XCTAssertEqual(store.attendanceError?.message, StaffAttendanceMessages.uncertainClockOut)
        XCTAssertNotNil(store.liveAttendance, "still clocked in per the server")
    }

    // MARK: Check In without location where the geofence is off

    @MainActor
    func testCheckInWithGeofenceOffRequestsNoLocationAndSendsNone() async throws {
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/check-in"), request.httpMethod == "GET" {
                return .json(200, StaffFixtures.checkInStateJSON(geofenceEnforced: false))
            }
            if path.hasSuffix("/attendance/check-in"), request.httpMethod == "POST" {
                return .json(200, StaffFixtures.checkInStateJSON(checkedInAt: "2026-10-21T08:51:00.000Z", geofenceEnforced: false))
            }
            if path.hasSuffix("/offers/mine") { return .json(200, "[]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let location = StaffFakeLocation()
        let prompts = StaffFakePrompts()
        let flow = StaffClockFlow(store: store, location: location, prompts: prompts)
        let booking = try decodeOffer(StaffFixtures.offerJSON(checkInRequired: true, geofenceEnforced: false))
        XCTAssertTrue(store.needsCheckIn(booking))

        await flow.checkIn(booking)

        XCTAssertEqual(location.totalCalls, 0, "geofence off → no permission prompt and no fix at all")
        XCTAssertFalse(prompts.shown.contains("explain"))
        XCTAssertFalse(prompts.shown.contains("scan"), "Check In never scans the QR")
        let post = try XCTUnwrap(server.requests(to: "/attendance/check-in").first { $0.httpMethod == "POST" })
        XCTAssertEqual(Set(post.jsonBody.map { Array($0.keys) } ?? []), ["shiftId"])
        XCTAssertEqual(post.jsonBody?["shiftId"] as? String, StaffFixtures.shiftId)
        XCTAssertFalse(store.needsCheckIn(booking), "the server's check-in state now wins over the offer")
        XCTAssertEqual(store.checkedInAt(booking), StaffFixtures.date("2026-10-21T08:51:00.000Z"))
    }

    @MainActor
    func testCheckInWithGeofenceOnSendsOneFix() async throws {
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/check-in"), request.httpMethod == "GET" {
                return .json(200, StaffFixtures.checkInStateJSON(geofenceEnforced: true))
            }
            if path.hasSuffix("/attendance/check-in") {
                return .json(200, StaffFixtures.checkInStateJSON(checkedInAt: "2026-10-21T08:51:00.000Z", geofenceEnforced: true))
            }
            if path.hasSuffix("/offers/mine") { return .json(200, "[]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let location = StaffFakeLocation()
        let flow = StaffClockFlow(store: store, location: location, prompts: StaffFakePrompts(), deviceNow: { Date() })
        await flow.checkIn(try decodeOffer(StaffFixtures.offerJSON(checkInRequired: true, geofenceEnforced: true)))
        XCTAssertEqual(location.fixCalls, 1)
        let body = try XCTUnwrap(server.requests(to: "/attendance/check-in").first { $0.httpMethod == "POST" }?.jsonBody)
        XCTAssertEqual(Set(body.keys), ["shiftId", "lat", "lng", "accuracyM", "capturedAt"])
        XCTAssertTrue((body["capturedAt"] as? String)?.hasSuffix("Z") == true)
    }

    @MainActor
    func testUnknownGeofenceFromAnOlderServerStillAsksExplainFirst() async throws {
        server.setHandler { _ in .json(404, #"{"message":"Not found."}"#) }
        let store = makeStaffStore()
        let location = StaffFakeLocation()
        location.status = .notDetermined
        let prompts = StaffFakePrompts()
        prompts.explainAnswer = false
        let flow = StaffClockFlow(store: store, location: location, prompts: prompts)
        let result = await flow.evidence(geofenceEnforced: nil)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(prompts.shown, ["explain"], "explain-first sheet before the system prompt")
        XCTAssertEqual(location.requestCalls, 0, "'Not now' never triggers the OS prompt")
    }

    @MainActor
    func testClockInFlowScansAndSendsTheTokenVerbatimOnce() async throws {
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJzaGlmdElkIjoiYSJ9.sig"
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/attendance/clock-in") {
                return .json(201, StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil))
            }
            if path.hasSuffix("/attendance/me/active") {
                return .json(200, StaffFixtures.activeJSON(attendance: StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil)))
            }
            if path.hasSuffix("/offers/mine") { return .json(200, "[]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let prompts = StaffFakePrompts()
        prompts.token = token
        let location = StaffFakeLocation()
        let flow = StaffClockFlow(store: store, location: location, prompts: prompts)
        await flow.clockIn(try decodeOffer(StaffFixtures.offerJSON(geofenceEnforced: false)))
        let requests = server.requests(to: "/attendance/clock-in")
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.jsonBody?["qrToken"] as? String, token)
        XCTAssertNil(requests.first?.jsonBody?["lat"])
        XCTAssertEqual(location.totalCalls, 0)
        XCTAssertNotNil(store.liveAttendance)
    }

    // MARK: Error codes

    @MainActor
    func testCheckInRequiredRefusalReloadsTheCheckInState() async {
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/attendance/clock-in") {
                return .json(409, #"{"code":"CHECK_IN_REQUIRED","message":"Check in before you clock in."}"#)
            }
            if path.hasSuffix("/check-in") { return .json(200, StaffFixtures.checkInStateJSON()) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let ok = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "token", location: nil)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.attendanceError, StaffAttendanceFailure(message: "Check in at the venue before you clock in.", code: "CHECK_IN_REQUIRED"))
        XCTAssertEqual(server.requests(to: "/check-in").count, 1, "the screen then offers Check In")
        XCTAssertEqual(server.requests(to: "/attendance/clock-in").count, 1)
    }

    @MainActor
    func testOutsideGeofenceShowsTheStaffMessage() async {
        server.setHandler { request in
            if (request.url?.path ?? "").hasSuffix("/attendance/check-in") {
                return .json(409, #"{"code":"OUTSIDE_GEOFENCE","message":"You are 420 m from Harbour Hall.","venueName":"Harbour Hall"}"#)
            }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let fix = StaffLocationFix(lat: 51, lng: -2, accuracyM: 10, capturedAt: Date())
        let ok = await store.checkIn(shiftId: StaffFixtures.shiftId, location: fix)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.attendanceError?.message, "You're outside the venue's permitted check-in area.")
        XCTAssertEqual(store.attendanceError?.code, "OUTSIDE_GEOFENCE")
    }

    @MainActor
    func testAFixBeyondThePublishedLimitsIsExplainedWithoutARequest() async {
        server.setHandler { request in
            if (request.url?.path ?? "").hasSuffix("/attendance/me/active") {
                return .json(200, StaffFixtures.activeJSON(maxAccuracyM: 50))
            }
            return .json(500, "")
        }
        let monotonic = StaffFakeMonotonic()
        let store = makeStaffStore(monotonic: monotonic)
        await store.refreshActive()
        let vague = StaffLocationFix(lat: 51, lng: -2, accuracyM: 80, capturedAt: StaffFixtures.date("2026-10-21T08:00:00.000Z"))
        let ok = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "token", location: vague)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.attendanceError?.code, "LOCATION_ACCURACY_TOO_LOW")
        XCTAssertTrue(server.requests(to: "/attendance/clock-in").isEmpty, "no request for a fix the server would refuse")
    }

    // MARK: Offers

    @MainActor
    func testAcceptConnectionLostIsNotResentAndReloadsOffers() async throws {
        let pending = StaffFixtures.offerJSON(status: "pending", presentation: StaffFixtures.presentationJSON(state: "pending"))
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/accept") { return .failure(.networkConnectionLost) }
            if path.hasSuffix("/offers/mine") { return .json(200, "[\(pending)]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let outcome = await store.respond(to: try decodeOffer(pending), action: .accept)
        XCTAssertEqual(outcome, .uncertain(StaffAttendanceMessages.uncertainOffer))
        XCTAssertEqual(server.requests(to: "/accept").count, 1, "accept is not idempotent: never resent")
        XCTAssertEqual(server.requests(to: "/offers/mine").count, 1, "the list is re-fetched instead")
        XCTAssertNil(store.busyOfferId)
    }

    @MainActor
    func testDeclineSendsNoBodyAndReloads() async throws {
        let pending = StaffFixtures.offerJSON(status: "pending", presentation: StaffFixtures.presentationJSON(state: "pending"))
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/decline") { return .json(201, #"{"id":"x"}"#) }
            if path.hasSuffix("/offers/mine") { return .json(200, "[]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let outcome = await store.respond(to: try decodeOffer(pending), action: .decline)
        XCTAssertEqual(outcome, .declined)
        let decline = try XCTUnwrap(server.requests(to: "/decline").first)
        XCTAssertNil(decline.jsonBody, "Flutter sends no body; no reason is required")
        XCTAssertEqual(decline.httpMethod, "POST")
        XCTAssertTrue(store.offers.isEmpty)
    }

    @MainActor
    func testRefusedAcceptShowsTheServerReason() async throws {
        let pending = StaffFixtures.offerJSON(status: "pending", presentation: StaffFixtures.presentationJSON(state: "pending"))
        server.setHandler { request in
            if (request.url?.path ?? "").hasSuffix("/accept") {
                return .json(409, #"{"statusCode":409,"message":"This offer has expired.","error":"Conflict"}"#)
            }
            return .json(200, "[]")
        }
        let store = makeStaffStore()
        let outcome = await store.respond(to: try decodeOffer(pending), action: .accept)
        XCTAssertEqual(outcome, .failed("This offer has expired."))
    }

    // MARK: Fail closed

    @MainActor
    func testHistoryFailureIsAnErrorNeverAnEmptyList() async {
        server.setHandler { _ in .json(500, #"{"statusCode":500,"message":"Internal server error"}"#) }
        let store = makeStaffStore()
        await store.loadHistory()
        XCTAssertEqual(store.historyError, "Could not check completed shifts. Please try again.")
        XCTAssertFalse(store.historyLoading)
    }

    @MainActor
    func testOffersFailureKeepsTheLastGoodList() async throws {
        var fail = false
        server.setHandler { _ in fail ? .json(503, "") : .json(200, "[\(StaffFixtures.offerJSON())]") }
        let store = makeStaffStore()
        await store.loadOffers()
        XCTAssertEqual(store.offers.count, 1)
        fail = true
        await store.loadOffers(silent: true)
        XCTAssertEqual(store.offers.count, 1, "a failed reload never clears good data")
        XCTAssertNotNil(store.offersError)
    }

    @MainActor
    func testAnswersForAPreviousIdentityAreDropped() async {
        server.setHandler { _ in .json(200, "[\(StaffFixtures.offerJSON())]") }
        let fence = StaffTestFence()
        fence.current = false
        let store = makeStaffStore(fence: fence)
        await store.loadOffers()
        XCTAssertTrue(store.offers.isEmpty)
        XCTAssertNil(store.offersError)
    }

    @MainActor
    func testTrustedClockComesFromTheServerAndTheMonotonicClock() async {
        server.setHandler { _ in .json(200, StaffFixtures.activeJSON(serverNow: "2026-10-21T08:00:00.000Z")) }
        let monotonic = StaffFakeMonotonic()
        let store = makeStaffStore(monotonic: monotonic)
        XCTAssertNil(store.attendanceNow, "no server answer yet")
        await store.refreshActive()
        monotonic.advance(seconds: 65)
        XCTAssertEqual(store.attendanceNow, StaffFixtures.date("2026-10-21T08:01:05.000Z"))
    }

    // MARK: Payroll paging

    func testStatementsArePagedToTheTotal() async throws {
        server.setHandler { request in
            let query = request.url?.query ?? ""
            let page = query.contains("page=2") ? 2 : 1
            let count = page == 1 ? 100 : 20
            let rows = (0..<count).map { StaffFixtures.statementJSON(id: "p\(page)-\($0)") }.joined(separator: ",")
            return .json(200, #"{"data":[\#(rows)],"total":120}"#)
        }
        let (client, _) = makeClient()
        let statements = try await StaffRepository(api: client).statements()
        XCTAssertEqual(statements.count, 120)
        XCTAssertEqual(server.requests(to: "/payroll/me/statements").count, 2)
        XCTAssertTrue(server.requests.first?.url?.query?.contains("limit=100") == true)
    }

    func testRoutesAndRetryPolicies() {
        XCTAssertEqual(StaffRepository.nonRepeatable.retry, .never)
        XCTAssertEqual(StaffPath.segment("../x?y"), "..%2Fx%3Fy")
    }
}

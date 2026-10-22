import XCTest
@testable import Crewflow

/// The Venue Manager store: server-scoped loads, capability hints, and
/// fail-closed behaviour (no records kept after a permission/scope failure).
@MainActor
final class VMStoreTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        URLProtocolStub.server.reset()
    }

    private func backend(capabilities: String) {
        URLProtocolStub.server.setHandler { request in
            let path = request.url?.path ?? ""
            switch true {
            case path.hasSuffix("/auth/capabilities"): return .json(200, capabilities)
            case path.hasSuffix("/shifts"):
                return .json(200, #"{"data":[{"id":"s1","venueId":"v1","jobRoleId":"r1","createdBy":"u1","address":"1 High St","notes":null,"status":"partially_filled","startsAt":"2099-01-01T09:00:00.000Z","endsAt":"2099-01-01T17:00:00.000Z","requiredCount":3,"filledCount":1}],"total":1}"#)
            case path.hasSuffix("/venues"): return .json(200, #"{"data":[{"id":"v1","name":"Hall"}],"total":1}"#)
            case path.hasSuffix("/job-roles"): return .json(200, #"[{"id":"r1","name":"Bartender"}]"#)
            case path.hasSuffix("/offers"): return .json(200, #"{"data":[],"total":0}"#)
            case path.hasSuffix("/shifts/sent"): return .fixture("vm_sent_shifts")
            case path.hasSuffix("/staff/venue-directory"): return .fixture("vm_directory")
            case path.hasSuffix("/attendance/report/shifts"): return .fixture("vm_report_list")
            default: return .json(404, #"{"message":"Not found."}"#)
            }
        }
    }

    func testRefreshResolvesNamesAndServerCounts() async {
        backend(capabilities: #"{"schedule.view":true,"venue.view":true,"staff.view":true,"report.view":true,"staffing_request.create":true}"#)
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        await store.refresh()
        XCTAssertNil(store.error)
        XCTAssertFalse(store.loading)
        XCTAssertEqual(store.events.first?.venue, "Hall")
        XCTAssertEqual(store.events.first?.role, "Bartender")
        XCTAssertEqual(store.upcoming(now: vmDate("2098-12-31T00:00:00Z")).count, 1)
        XCTAssertEqual(store.sentSubmitted, 5)
        XCTAssertEqual(store.userCount, 42, "server total, not a client count")
        XCTAssertEqual(store.currentReportCount, 31)
        XCTAssertTrue(store.allows(.staffingRequestCreate))
        XCTAssertFalse(store.allows(.offerSend), "absent flag reads false")
    }

    func testNoStaffViewMeansNoDirectoryCall() async {
        backend(capabilities: #"{"schedule.view":true,"venue.view":true,"staff.view":false,"report.view":false}"#)
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        await store.refresh()
        XCTAssertNil(store.userCount)
        XCTAssertTrue(URLProtocolStub.server.requests(containing: "/staff/venue-directory").isEmpty)
        XCTAssertTrue(URLProtocolStub.server.requests(containing: "/attendance/report/shifts").isEmpty)
    }

    func testMissingScheduleAccessFailsClosedAndDropsRecords() async {
        backend(capabilities: #"{"schedule.view":true,"venue.view":true,"staff.view":true,"report.view":true}"#)
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        await store.refresh()
        XCTAssertFalse(store.events.isEmpty)
        backend(capabilities: #"{"schedule.view":false,"venue.view":true}"#)
        await store.refresh()
        XCTAssertEqual(store.error, "Your account cannot view venue schedules.")
        XCTAssertTrue(store.events.isEmpty, "no records retained after a permission change")
        XCTAssertTrue(store.venues.isEmpty)
        XCTAssertEqual(store.capabilities, .none)
    }

    func testRosterRefusesAReportForAnotherShift() async {
        backend(capabilities: #"{"schedule.view":true,"venue.view":true,"report.view":true}"#)
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        await store.refresh()
        URLProtocolStub.server.setHandler { _ in .fixture("vm_shift_report") }
        do {
            _ = try await store.roster(for: "a1b2c3d4-0000-4000-8000-000000000099")
            XCTFail("expected a mismatch")
        } catch {
            XCTAssertEqual(error as? VenueManagerError, .reportMismatch)
        }
    }

    func testPollingMarksRequestsAsBackground() async {
        backend(capabilities: #"{"schedule.view":true,"venue.view":true}"#)
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        await store.refresh(silent: true, background: true)
        let flagged = URLProtocolStub.server.requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Crewflow-Background") == "1" }
        XCTAssertTrue(flagged, "automatic polls never slide the idle session window")
    }
}

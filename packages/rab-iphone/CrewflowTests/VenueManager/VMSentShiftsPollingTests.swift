import XCTest
@testable import Crewflow

/// Phase C1 Venue Manager polling: the Sent Shifts poll reads ONLY the first
/// page of the tab on screen (background-flagged), keeps the data on
/// failure, merges instead of replacing, and the full refresh is
/// single-flight with queued follow-ups. Mirrors the Flutter
/// `venue_manager_provider_test.dart` / `sent_shifts_screen_test.dart` cases.
///
/// Written, not run (no macOS here): never compiled or executed.
@MainActor
final class VMSentShiftsPollingTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }
    private static let allCaps = #"{"schedule.view":true,"venue.view":true,"staff.view":false,"report.view":false}"#

    override func setUp() async throws {
        try await super.setUp()
        URLProtocolStub.server.reset()
    }

    // MARK: Fixtures

    static func sentRow(_ id: String, submitted: String) -> String {
        #"{"id":"\#(id)","status":"published","requiredCount":1,"startsAt":"2099-01-01T09:00:00.000Z","endsAt":"2099-01-01T17:00:00.000Z","submittedAt":"\#(submitted)","venueName":"Hall","roleName":"Bar"}"#
    }

    static func sentPage(_ rows: [String], total: Int, submitted: Int = 5) -> String {
        #"{"data":[\#(rows.joined(separator: ","))],"total":\#(total),"view":"all","counts":{"all":\#(total),"pending":0,"accepted":0,"confirmed":0,"declined":0,"expired":0,"submitted":\#(submitted)}}"#
    }

    private func row(_ id: String, _ submitted: String) throws -> SentShift {
        try CrewflowJSON.makeDecoder().decode(SentShift.self, from: Data(Self.sentRow(id, submitted: submitted).utf8))
    }

    /// A small VM backend; `sent` answers every `/shifts/sent` read.
    private func backend(caps: String? = nil, sent: @escaping (URLRequest) -> StubResponse) {
        let capabilities = caps ?? Self.allCaps
        server.setHandler { request in
            let path = request.url?.path ?? ""
            switch true {
            case path.hasSuffix("/auth/capabilities"): return .json(200, capabilities)
            case path.hasSuffix("/shifts/sent"): return sent(request)
            case path.hasSuffix("/shifts"):
                return .json(200, #"{"data":[{"id":"s1","venueId":"v1","jobRoleId":"r1","createdBy":"u1","address":"1 High St","notes":null,"status":"partially_filled","startsAt":"2099-01-01T09:00:00.000Z","endsAt":"2099-01-01T17:00:00.000Z","requiredCount":3,"filledCount":1}],"total":1}"#)
            case path.hasSuffix("/venues"): return .json(200, #"{"data":[{"id":"v1","name":"Hall"}],"total":1}"#)
            case path.hasSuffix("/job-roles"): return .json(200, #"[{"id":"r1","name":"Bartender"}]"#)
            case path.hasSuffix("/offers"): return .json(200, #"{"data":[],"total":0}"#)
            default: return .json(404, #"{"message":"Not found."}"#)
            }
        }
    }

    private func twoRows() -> String {
        Self.sentPage([
            Self.sentRow("d0000000-0000-4000-8000-000000000002", submitted: "2026-10-22T08:55:00.000Z"),
            Self.sentRow("d0000000-0000-4000-8000-000000000001", submitted: "2026-10-21T10:00:00.000Z"),
        ], total: 2)
    }

    private func loadedStore() async -> VenueManagerStore {
        let page = twoRows()
        backend { _ in .json(200, page) }
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        await store.refresh()
        XCTAssertEqual(store.sentShifts.count, 2)
        return store
    }

    private func sentRequests(after index: Int) -> [URLRequest] {
        Array(server.requests.dropFirst(index)).filter { ($0.url?.path ?? "").hasSuffix("/shifts/sent") }
    }

    // MARK: Request shape

    func testPollReadsOnlyTheFirstPageOfTheTabOnScreenAsBackground() async throws {
        let store = await loadedStore()
        let before = server.requests.count

        try await store.pollSentView(background: true)

        let after = Array(server.requests.dropFirst(before))
        XCTAssertEqual(after.count, 1, "one request per poll (was 10–12 every 5 s)")
        let poll = try XCTUnwrap(after.first)
        XCTAssertTrue(poll.url?.path.hasSuffix("/shifts/sent") == true)
        let query = poll.url?.query ?? ""
        XCTAssertTrue(query.contains("view=all"))
        XCTAssertTrue(query.contains("page=1"))
        XCTAssertTrue(query.contains("limit=50"))
        XCTAssertEqual(poll.value(forHTTPHeaderField: "X-Crewflow-Background"), "1")
        XCTAssertEqual(store.sentSubmitted, 5, "counts come from the same page")
    }

    func testFullRefreshNeedsNoSeparateCountProbe() async {
        _ = await loadedStore()
        let sent = server.requests.filter { ($0.url?.path ?? "").hasSuffix("/shifts/sent") }
        XCTAssertEqual(sent.count, 1, "counts are read from the first page of the All view")
    }

    func testTabChoiceIsTheUsersOwnReadNeverBackground() async {
        let store = await loadedStore()
        let before = server.requests.count

        await store.selectSentView("pending")
        let firstOpen = sentRequests(after: before)
        XCTAssertEqual(firstOpen.count, 1)
        XCTAssertTrue((firstOpen.first?.url?.query ?? "").contains("view=pending"))
        XCTAssertNil(firstOpen.first?.value(forHTTPHeaderField: "X-Crewflow-Background"))
        XCTAssertNotNil(store.sentRows("pending"))

        await store.selectSentView("all")
        let middle = server.requests.count
        await store.selectSentView("pending")
        let reopen = sentRequests(after: middle)
        XCTAssertEqual(reopen.count, 1, "an already loaded tab re-reads its first page")
        XCTAssertTrue((reopen.first?.url?.query ?? "").contains("limit=50"))
        XCTAssertNil(reopen.first?.value(forHTTPHeaderField: "X-Crewflow-Background"))
    }

    func testTimerPollsCarryTheBackgroundHeaderAndHiddenTabsDoNotPoll() async {
        let store = await loadedStore()
        let clock = VirtualClock()
        let poll = PollScheduler(interval: 30, refreshOnResume: false, random: { 0.5 }, sleeper: clock.sleeper)
        await poll.start(foreground: true, visible: true) { trigger in
            try await store.pollSentView(background: trigger.isBackground)
        }
        let before = server.requests.count
        await waitUntil { clock.pending == 1 }
        clock.advance(30)
        await waitUntil { self.sentRequests(after: before).count == 1 }
        XCTAssertEqual(sentRequests(after: before).first?.value(forHTTPHeaderField: "X-Crewflow-Background"), "1")

        // The shell hides the tab (TabShell keeps it mounted at opacity 0).
        await waitUntil { clock.pending == 1 }
        poll.setVisible(false)
        await waitUntil { clock.pending == 0 }
        clock.advance(600)
        await settle()
        XCTAssertEqual(sentRequests(after: before).count, 1, "no polling while the tab is hidden")

        poll.setVisible(true)
        await waitUntil { self.sentRequests(after: before).count == 2 }
        XCTAssertNil(sentRequests(after: before).last?.value(forHTTPHeaderField: "X-Crewflow-Background"),
                     "becoming visible is not background traffic")
    }

    // MARK: Failure keeps data

    func testPollFailureKeepsTheRowsAndShowsANonBlockingNotice() async throws {
        let store = await loadedStore()
        backend { _ in .json(500, #"{"statusCode":500,"message":"Internal server error"}"#) }
        do {
            try await store.pollSentView(background: true)
            XCTFail("the poll reports its failure to the scheduler")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 500))
        }
        XCTAssertEqual(store.sentShifts.count, 2, "never clear a list because a background refresh failed")
        XCTAssertNil(store.error, "no error page over data on screen")
        XCTAssertTrue(store.refreshFailed)
    }

    func testFullRefreshFailureWithDataOnScreenKeepsEverything() async {
        let store = await loadedStore()
        server.setHandler { _ in .json(500, #"{"statusCode":500,"message":"Internal server error"}"#) }
        await store.refresh(silent: true)
        XCTAssertNil(store.error)
        XCTAssertTrue(store.refreshFailed)
        XCTAssertFalse(store.events.isEmpty)
        XCTAssertEqual(store.sentShifts.count, 2)
        XCTAssertFalse(store.loading)
    }

    func testFirstLoadFailureStillShowsTheErrorPage() async {
        server.setHandler { _ in .json(500, #"{"statusCode":500,"message":"Internal server error"}"#) }
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        await store.refresh()
        XCTAssertNotNil(store.error, "nothing to show yet: the failure view")
        XCTAssertNil(store.updatedAt)
        XCTAssertFalse(store.loading)
    }

    func testPermissionRefusalStillDropsEveryRecord() async {
        let store = await loadedStore()
        backend { _ in .json(403, #"{"statusCode":403,"message":"You don't have permission to do that."}"#) }
        do {
            try await store.pollSentView(background: true)
            XCTFail("expected 403")
        } catch {}
        XCTAssertTrue(store.sentShifts.isEmpty, "no records kept after a scope change")
        XCTAssertTrue(store.events.isEmpty)
        XCTAssertNotNil(store.error)
        XCTAssertFalse(store.refreshFailed)
    }

    // MARK: Merge

    func testFirstPageShorterThanTheLimitReplacesTheList() throws {
        let previous = [try row("a", "2026-10-03T00:00:00.000Z"), try row("b", "2026-10-02T00:00:00.000Z")]
        let page = [try row("c", "2026-10-04T00:00:00.000Z")]
        let merged = VenueManagerStore.mergeSentFirstPage(previous, page, total: 1)
        XCTAssertEqual(merged.map(\.id), ["c"], "a complete first page is the whole list")
    }

    func testFullFirstPageKeepsOlderRowsBelowIt() throws {
        let page = try (0..<50).map { index in
            try row(String(format: "p%02ld", 99 - index), "2026-10-\(String(format: "%02ld", 30 - index / 2))T12:00:00.000Z")
        }
        let older = try row("old", "2026-09-01T00:00:00.000Z")
        let moved = try row("p99", "2026-10-30T12:00:00.000Z")
        let merged = VenueManagerStore.mergeSentFirstPage([moved, older], page, total: 80)
        XCTAssertEqual(merged.count, 51)
        XCTAssertEqual(Array(merged.prefix(50)).map(\.id), page.map(\.id), "the page is authoritative down to its last row")
        XCTAssertEqual(merged.last?.id, "old", "rows below the page are kept as last read")
    }

    // MARK: Single flight

    func testRefreshAfterTheManagersOwnChangeIsQueuedNotDropped() async {
        let release = DispatchSemaphore(value: 0)
        let capsCalls = AtomicCounter()
        let page = twoRows()
        let caps = Self.allCaps
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/auth/capabilities") {
                if capsCalls.increment() == 1 { release.wait() }
                return .json(200, caps)
            }
            if path.hasSuffix("/shifts/sent") { return .json(200, page) }
            if path.hasSuffix("/shifts") || path.hasSuffix("/venues") || path.hasSuffix("/offers") {
                return .json(200, #"{"data":[],"total":0}"#)
            }
            if path.hasSuffix("/job-roles") { return .json(200, "[]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        let first = Task { await store.refresh() }
        await waitUntil { capsCalls.value == 1 }
        let second = Task { await store.refresh(silent: true) }
        await settle()
        XCTAssertEqual(capsCalls.value, 1, "no overlapping refresh")
        release.signal()
        await first.value
        await second.value
        XCTAssertEqual(capsCalls.value, 2, "the queued refresh ran after the first one, once")
        XCTAssertNil(store.error)
    }

    /// A pull-to-refresh queued behind a running refresh stays the person's action even when a realtime
    /// (background) refresh joins the same queued run afterwards: the merged run is foreground.
    func testQueuedRefreshIsForegroundIfAnyCallerIsThePerson() async throws {
        let caps = Self.allCaps
        let page = twoRows()
        let capsCalls = AtomicCounter()
        let release = DispatchSemaphore(value: 0)
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/auth/capabilities") {
                if capsCalls.increment() == 1 { release.wait() }
                return .json(200, caps)
            }
            if path.hasSuffix("/shifts/sent") { return .json(200, page) }
            if path.hasSuffix("/shifts") || path.hasSuffix("/venues") || path.hasSuffix("/offers") {
                return .json(200, #"{"data":[],"total":0}"#)
            }
            if path.hasSuffix("/job-roles") { return .json(200, "[]") }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        let first = Task { await store.refresh() }
        await waitUntil { capsCalls.value == 1 }
        let pull = Task { await store.refresh(silent: true) }
        await settle()
        let realtime = Task { await store.refresh(silent: true, background: true) }
        await settle()
        release.signal()
        await first.value
        await pull.value
        await realtime.value
        XCTAssertEqual(capsCalls.value, 2, "one queued run served both callers")
        let queuedCaps = try XCTUnwrap(server.requests.filter { ($0.url?.path ?? "").hasSuffix("/auth/capabilities") }.last)
        XCTAssertNil(queuedCaps.value(forHTTPHeaderField: "X-Crewflow-Background"), "the person's pull keeps it foreground")
    }

    func testNoPollBeforeTheFirstLoad() async throws {
        let store = VenueManagerStore(repository: vmRepository(), userId: "u1")
        let before = server.requests.count
        try await store.pollSentView(background: true)
        XCTAssertEqual(server.requests.count, before, "no poll before the first load")
    }
}

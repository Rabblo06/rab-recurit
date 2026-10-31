import XCTest
@testable import Crewflow

/// Phase C1 Staff polling: `/offers/mine` keyset paging (`scope=current` on
/// polls, `scope=all` on first load / pull-to-refresh), attendance history
/// paging with the legacy fallback, queued (never dropped) reloads after the
/// person's own action, background header only on timer reads, and the team
/// list that keeps its rows. Mirrors the Flutter `offers_provider_test.dart`
/// and `keyset_pages_test.dart` cases.
///
/// Written, not run (no macOS here): never compiled or executed.
@MainActor
final class StaffPollingTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }

    override func setUp() async throws {
        try await super.setUp()
        URLProtocolStub.server.reset()
    }

    private static let offerA = "aaaaaaaa-1d2e-4a5b-9c6d-7e8f9a0b1c2d"
    private static let offerB = "bbbbbbbb-1d2e-4a5b-9c6d-7e8f9a0b1c2d"
    private static let shiftA = "aaaaaaaa-8f3a-4c6d-9e0f-1a2b3c4d5e6f"
    private static let shiftB = "bbbbbbbb-8f3a-4c6d-9e0f-1a2b3c4d5e6f"

    private var offerRequests: [URLRequest] {
        server.requests.filter { ($0.url?.path ?? "").hasSuffix("/offers/mine") }
    }

    private func query(_ request: URLRequest?) -> String { request?.url?.query ?? "" }

    // MARK: /offers/mine keyset paging

    func testReconcileReadsTheCurrentScopeAndFollowsTheCursorAsBackground() async {
        let first = StaffFixtures.offerJSON(id: Self.offerA, shiftId: Self.shiftA)
        let second = StaffFixtures.offerJSON(id: Self.offerB, shiftId: Self.shiftB)
        server.setHandler { request in
            let path = request.url?.path ?? ""
            let query = request.url?.query ?? ""
            if path.hasSuffix("/offers/mine") {
                if query.contains("cursor=c2") { return .json(200, #"{"data":[\#(second)],"nextCursor":null}"#) }
                return .json(200, #"{"data":[\#(first)],"nextCursor":"c2"}"#)
            }
            if path.hasSuffix("/attendance/me/active") { return .json(200, StaffFixtures.activeJSON()) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()

        await store.reconcile(background: true)

        let reads = offerRequests
        XCTAssertEqual(reads.count, 2, "every page until nextCursor is null")
        XCTAssertTrue(query(reads.first).contains("scope=current"))
        XCTAssertTrue(query(reads.first).contains("limit=50"))
        XCTAssertFalse(query(reads.first).contains("cursor="), "the first page has no cursor")
        XCTAssertTrue(query(reads.last).contains("cursor=c2"))
        XCTAssertTrue(reads.allSatisfy { $0.value(forHTTPHeaderField: "X-Crewflow-Background") == "1" })
        XCTAssertEqual(Set(store.offers.map(\.id)), [Self.offerA, Self.offerB])
    }

    func testFirstLoadAndPullToRefreshReadEveryOfferForTheCalendar() async {
        server.setHandler { request in
            if (request.url?.path ?? "").hasSuffix("/offers/mine") { return .json(200, #"{"data":[],"nextCursor":null}"#) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        await store.start()
        XCTAssertTrue(query(offerRequests.first).contains("scope=all"), "the Calendar shows past months")
        XCTAssertTrue(query(offerRequests.first).contains("limit=200"))
        XCTAssertNil(offerRequests.first?.value(forHTTPHeaderField: "X-Crewflow-Background"))

        await store.refreshAll()
        XCTAssertEqual(offerRequests.count, 2)
        XCTAssertTrue(query(offerRequests.last).contains("scope=all"))
        XCTAssertNil(offerRequests.last?.value(forHTTPHeaderField: "X-Crewflow-Background"), "pull-to-refresh is the person's own read")
    }

    func testCurrentScopePollMergesAndKeepsOlderOffers() async {
        let old = StaffFixtures.offerJSON(id: Self.offerA, shiftId: Self.shiftA, status: "manager_confirmed")
        let pending = StaffFixtures.offerJSON(id: Self.offerB, shiftId: Self.shiftB, status: "pending")
        let accepted = StaffFixtures.offerJSON(id: Self.offerB, shiftId: Self.shiftB, status: "staff_accepted")
        server.setHandler { request in
            guard (request.url?.path ?? "").hasSuffix("/offers/mine") else { return .json(404, #"{"message":"Not found."}"#) }
            if (request.url?.query ?? "").contains("scope=all") {
                return .json(200, #"{"data":[\#(pending),\#(old)],"nextCursor":null}"#)
            }
            return .json(200, #"{"data":[\#(accepted)],"nextCursor":null}"#)
        }
        let store = makeStaffStore()
        await store.loadOffers(full: true)
        XCTAssertEqual(store.offers.count, 2)

        await store.loadOffers(silent: true)

        XCTAssertEqual(store.offers.count, 2, "an offer outside the current window stays as last read")
        XCTAssertEqual(store.offer(id: Self.offerB)?.status, "staff_accepted", "the fresh row replaces the same id")
        XCTAssertEqual(store.offer(id: Self.offerA)?.status, "manager_confirmed")
    }

    func testOlderServerBareArrayAtTheLimitFallsBackToOneLegacyCall() async {
        let fifty = (0..<50).map { index in
            StaffFixtures.offerJSON(id: String(format: "%08lx-1d2e-4a5b-9c6d-7e8f9a0b1c2d", index), shiftId: Self.shiftA)
        }
        let sixty = (0..<60).map { index in
            StaffFixtures.offerJSON(id: String(format: "%08lx-1d2e-4a5b-9c6d-7e8f9a0b1c2d", index), shiftId: Self.shiftA)
        }
        server.setHandler { request in
            guard (request.url?.path ?? "").hasSuffix("/offers/mine") else { return .json(404, #"{"message":"Not found."}"#) }
            let query = request.url?.query ?? ""
            return .json(200, "[\((query.isEmpty ? sixty : fifty).joined(separator: ","))]")
        }
        let store = makeStaffStore()
        await store.loadOffers(silent: true)
        XCTAssertEqual(offerRequests.count, 2)
        XCTAssertEqual(query(offerRequests.last), "", "the legacy call sends no parameters (the server's own default)")
        XCTAssertEqual(store.offers.count, 60, "nothing truncated")
    }

    func testOlderServerRejectingTheParametersFallsBackToTheLegacyCall() async {
        let offer = StaffFixtures.offerJSON()
        server.setHandler { request in
            guard (request.url?.path ?? "").hasSuffix("/offers/mine") else { return .json(404, #"{"message":"Not found."}"#) }
            if (request.url?.query ?? "").isEmpty { return .json(200, "[\(offer)]") }
            return .json(400, #"{"statusCode":400,"message":["property scope should not exist"],"error":"Bad Request"}"#)
        }
        let store = makeStaffStore()
        await store.loadOffers(silent: true)
        XCTAssertEqual(offerRequests.count, 2)
        XCTAssertEqual(store.offers.count, 1)
        XCTAssertNil(store.offersError)
    }

    // MARK: Attendance history paging

    func testHistoryPagesUntilNextCursorIsNull() async {
        let first = StaffFixtures.attendanceJSON(id: "a1b2c3d4-e5f6-4a7b-8c9d-000000000001")
        let second = StaffFixtures.attendanceJSON(id: "a1b2c3d4-e5f6-4a7b-8c9d-000000000002")
        server.setHandler { request in
            guard (request.url?.path ?? "").hasSuffix("/attendance/me/history") else { return .json(404, #"{"message":"Not found."}"#) }
            if (request.url?.query ?? "").contains("cursor=h2") { return .json(200, #"{"data":[\#(second)],"nextCursor":null}"#) }
            return .json(200, #"{"data":[\#(first)],"nextCursor":"h2"}"#)
        }
        let store = makeStaffStore()
        await store.loadHistory()
        let reads = server.requests(to: "/attendance/me/history")
        XCTAssertEqual(reads.count, 2)
        XCTAssertTrue(query(reads.first).contains("limit=200"))
        XCTAssertEqual(store.history.count, 2)
        XCTAssertNil(store.historyError)
    }

    func testHistoryFallsBackToTheLegacyCallOn400() async {
        let row = StaffFixtures.attendanceJSON()
        server.setHandler { request in
            guard (request.url?.path ?? "").hasSuffix("/attendance/me/history") else { return .json(404, #"{"message":"Not found."}"#) }
            if (request.url?.query ?? "").isEmpty { return .json(200, "[\(row)]") }
            return .json(400, #"{"statusCode":400,"message":["property limit should not exist"],"error":"Bad Request"}"#)
        }
        let store = makeStaffStore()
        await store.loadHistory()
        XCTAssertEqual(store.history.count, 1)
        XCTAssertEqual(server.requests(to: "/attendance/me/history").count, 2)
    }

    // MARK: The person's own action is never dropped

    func testReloadAfterOwnAcceptIsQueuedBehindAPollNotDropped() async throws {
        let pending = StaffFixtures.offerJSON(status: "pending", presentation: StaffFixtures.presentationJSON(state: "pending"))
        let release = DispatchSemaphore(value: 0)
        let offersCalls = AtomicCounter()
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/offers/mine") {
                if offersCalls.increment() == 1 { release.wait() }
                return .json(200, #"{"data":[\#(pending)],"nextCursor":null}"#)
            }
            if path.hasSuffix("/accept") { return .json(201, #"{"id":"x"}"#) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let offer = try StaffFixtures.decode(StaffOfferSummary.self, pending)
        let poll = Task { await store.reconcile(background: true) }
        await waitUntil { offersCalls.value == 1 }

        let respond = Task { await store.respond(to: offer, action: .accept) }
        await waitUntil { self.server.requests(to: "/accept").count == 1 }
        await settle()
        XCTAssertEqual(offersCalls.value, 1, "the follow-up waits for the poll on the wire")

        release.signal()
        await poll.value
        let outcome = await respond.value
        XCTAssertEqual(outcome, .accepted)
        XCTAssertEqual(offersCalls.value, 2, "the reload after the accept was queued, not swallowed")
        let paths = server.requests.map { $0.url?.path ?? "" }
        let acceptIndex = try XCTUnwrap(paths.firstIndex { $0.hasSuffix("/accept") })
        let lastOffers = try XCTUnwrap(paths.lastIndex { $0.hasSuffix("/offers/mine") })
        XCTAssertGreaterThan(lastOffers, acceptIndex, "it read state from AFTER the accept")
        XCTAssertNil(server.requests.last(where: { ($0.url?.path ?? "").hasSuffix("/offers/mine") })?
            .value(forHTTPHeaderField: "X-Crewflow-Background"), "a reload for the person's own action is not background")
    }

    // MARK: Poll task

    func testPollReconcileThrowsForBackoffButKeepsTheData() async {
        let offer = StaffFixtures.offerJSON()
        let flag = AtomicCounter()
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if flag.value > 0 { return .json(500, #"{"statusCode":500,"message":"Internal server error"}"#) }
            if path.hasSuffix("/offers/mine") { return .json(200, #"{"data":[\#(offer)],"nextCursor":null}"#) }
            if path.hasSuffix("/attendance/me/active") { return .json(200, StaffFixtures.activeJSON()) }
            if path.hasSuffix("/notifications/unread-count") { return .json(200, #"{"count":2}"#) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        do {
            try await store.pollReconcile(background: true)
        } catch {
            XCTFail("healthy poll should not throw: \(error)")
        }
        XCTAssertEqual(store.offers.count, 1)
        XCTAssertEqual(store.unreadCount, 2)

        flag.increment()
        do {
            try await store.pollReconcile(background: true)
            XCTFail("a failed poll reports the failure to the scheduler")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 500))
        }
        XCTAssertEqual(store.offers.count, 1, "a failed reload never clears good data")
        XCTAssertEqual(store.unreadCount, 2)
        XCTAssertNotNil(store.offersError)
    }

    func testTheBellIsReadOnEverySecondReconcileSixtySeconds() async throws {
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/offers/mine") { return .json(200, #"{"data":[],"nextCursor":null}"#) }
            if path.hasSuffix("/attendance/me/active") { return .json(200, StaffFixtures.activeJSON()) }
            if path.hasSuffix("/notifications/unread-count") { return .json(200, #"{"count":1}"#) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        for _ in 0..<4 { try await store.pollReconcile(background: true) }
        let unread = server.requests.filter { ($0.url?.path ?? "").hasSuffix("/notifications/unread-count") }
        let offers = server.requests.filter { ($0.url?.path ?? "").hasSuffix("/offers/mine") }
        XCTAssertEqual(offers.count, 4, "reconcile every 30 s")
        XCTAssertEqual(unread.count, 2, "the bell every 60 s")
        XCTAssertEqual(store.unreadCount, 1)
    }

    func testOnlyTimerRunsCarryTheBackgroundHeader() async {
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/offers/mine") { return .json(200, #"{"data":[],"nextCursor":null}"#) }
            if path.hasSuffix("/attendance/me/active") { return .json(200, StaffFixtures.activeJSON()) }
            if path.hasSuffix("/notifications/unread-count") { return .json(200, #"{"count":0}"#) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStaffStore()
        let clock = VirtualClock()
        let poll = PollScheduler(interval: 30, refreshOnResume: false, random: { 0.5 }, sleeper: clock.sleeper)
        await poll.start(foreground: true) { trigger in
            try await store.pollReconcile(background: trigger.isBackground)
        }
        await waitUntil { clock.pending == 1 }
        clock.advance(30)
        await waitUntil { self.server.requests.count == 3 }
        XCTAssertTrue(server.requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Crewflow-Background") == "1" },
                      "offers, active attendance and unread count, all background")

        let before = server.requests.count
        await store.refreshAll()
        let user = Array(server.requests.dropFirst(before))
        XCTAssertFalse(user.isEmpty)
        XCTAssertTrue(user.allSatisfy { $0.value(forHTTPHeaderField: "X-Crewflow-Background") == nil })
    }

    func testPollStopsWhenTheSessionGenerationChanges() async throws {
        server.setHandler { _ in .json(200, #"{"data":[],"nextCursor":null}"#) }
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "A", refreshToken: "R")
        let store = StaffStore(repository: StaffRepository(api: client), fence: StaffTestFence())
        let clock = VirtualClock()
        let poll = PollScheduler(interval: 30, random: { 0.5 }, sleeper: clock.sleeper)
        await poll.start(foreground: true, identity: { await client.currentGeneration() }) { trigger in
            try await store.pollReconcile(background: trigger.isBackground)
        }
        await waitUntil { clock.pending == 1 }

        await client.endSession() // sign-out: new generation, tokens wiped
        clock.advance(30)
        await waitUntil { poll.isStopped }
        await settle()
        XCTAssertTrue(server.requests.isEmpty, "nothing is ever sent for the signed-out identity")
    }

    // MARK: Team list

    func testTeamRefreshKeepsRowsOnFailureAndFlagsTimerReads() async throws {
        let flag = AtomicCounter()
        server.setHandler { request in
            guard (request.url?.path ?? "").hasSuffix("/team") else { return .json(404, #"{"message":"Not found."}"#) }
            if flag.value > 0 { return .json(500, #"{"statusCode":500,"message":"Internal server error"}"#) }
            return .json(200, #"[{"displayName":"Alex","startsAt":"2026-10-21T09:00:00.000Z","endsAt":"2026-10-21T17:00:00.000Z","isYou":false}]"#)
        }
        let store = makeStaffStore()
        let loader = StaffTeamLoader()
        try await loader.load(shiftId: StaffFixtures.shiftId, using: store)
        XCTAssertEqual(loader.members.count, 1)
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "X-Crewflow-Background"))

        flag.increment()
        do {
            try await loader.load(shiftId: StaffFixtures.shiftId, background: true, using: store)
            XCTFail("the failure is reported to the poller")
        } catch {}
        XCTAssertEqual(server.requests.last?.value(forHTTPHeaderField: "X-Crewflow-Background"), "1")
        XCTAssertEqual(loader.members.count, 1, "rows stay on screen")
        XCTAssertTrue(loader.stale, "non-blocking notice")
        XCTAssertNil(loader.error, "no error page over the rows")
        XCTAssertFalse(loader.loading)
    }

    func testTeamPermanentRefusalDropsTheRows() async throws {
        let flag = AtomicCounter()
        server.setHandler { request in
            guard (request.url?.path ?? "").hasSuffix("/team") else { return .json(404, #"{"message":"Not found."}"#) }
            if flag.value > 0 { return .json(404, #"{"statusCode":404,"message":"Not found."}"#) }
            return .json(200, #"[{"displayName":"Alex","startsAt":"2026-10-21T09:00:00.000Z","endsAt":"2026-10-21T17:00:00.000Z","isYou":false}]"#)
        }
        let store = makeStaffStore()
        let loader = StaffTeamLoader()
        try await loader.load(shiftId: StaffFixtures.shiftId, using: store)
        XCTAssertEqual(loader.members.count, 1)

        flag.increment() // no longer on this shift
        do { try await loader.load(shiftId: StaffFixtures.shiftId, background: true, using: store) } catch {}
        XCTAssertTrue(loader.members.isEmpty, "refused rows are not kept")
        XCTAssertFalse(loader.stale)
        XCTAssertNotNil(loader.error)
    }

    func testTeamFirstLoadFailureShowsTheError() async throws {
        server.setHandler { _ in .json(500, #"{"statusCode":500,"message":"Internal server error"}"#) }
        let store = makeStaffStore()
        let loader = StaffTeamLoader()
        do { try await loader.load(shiftId: "s-1", using: store) } catch {}
        XCTAssertNotNil(loader.error, "a first load with nothing to show reports the error")
        XCTAssertTrue(loader.members.isEmpty)
    }
}

import XCTest
@testable import Crewflow

/// Request/response helpers for the stubbed sync route. Not actor-isolated:
/// the stub server calls them on a background queue.
enum SyncStub {
    typealias Row = (key: String, outcome: String, code: String?)

    static func entries(_ request: URLRequest) -> [[String: Any]] {
        (request.jsonBody?["entries"] as? [[String: Any]]) ?? []
    }

    static func keys(_ request: URLRequest) -> [String] {
        entries(request).compactMap { $0["idempotencyKey"] as? String }
    }

    static func results(_ items: [Row], ticket: String? = nil) -> StubResponse {
        let rows = items.map { item -> String in
            let code = item.code.map { ",\"code\":\"\($0)\"" } ?? ""
            return "{\"idempotencyKey\":\"\(item.key)\",\"outcome\":\"\(item.outcome)\"\(code)}"
        }
        let ticketPart = ticket.map { ",\"offlineTicket\":\"\($0)\"" } ?? ""
        return .json(200, "{\"serverNow\":\"2026-11-21T18:40:02.120Z\",\"results\":[\(rows.joined(separator: ","))]\(ticketPart)}")
    }

    static func applyAll(_ request: URLRequest, ticket: String? = nil) -> StubResponse {
        results(keys(request).map { (key: $0, outcome: "applied", code: nil) }, ticket: ticket)
    }

    static func calls() -> [URLRequest] {
        URLProtocolStub.server.requests(to: "/attendance/me/sync")
    }
}

/// A switch the test flips while the stub server reads it from another queue.
final class StubFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Bool

    init(_ value: Bool) { current = value }

    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }
}

final class Millis {
    var value: Int64 = 1_000_000
}

/// `POST /attendance/me/sync` through the real APIClient and a stubbed
/// URLProtocol (DESIGN §3.5, §7.2): partial success, batching and order,
/// whole-batch 400, 429, backoff, replay safety, fail-closed outcomes and the
/// ticket renewal rule.
final class OfflineSyncEngineTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }

    override func setUp() {
        super.setUp()
        URLProtocolStub.server.reset()
    }

    // MARK: Helpers

    @MainActor
    private func makeOffline(_ count: Int, clock: FakeBootClock) throws -> StaffOfflineAttendance {
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        for index in 0..<count {
            try offline.capture(.make(.checkIn, shiftId: "shift-\(index)"), context: OfflineAttendanceContext())
        }
        return offline
    }

    @MainActor
    private func makeEngine(_ offline: StaffOfflineAttendance, millis: Millis = Millis(), owner: @escaping () -> Bool = { true }) -> OfflineSyncEngine {
        let (client, _) = makeClient()
        let repository = StaffRepository(api: client)
        return OfflineSyncEngine(
            queue: offline.queue,
            bootClock: offline.clock,
            monotonicMs: { millis.value },
            onTicket: { [weak offline] raw, serverNow, started in
                offline?.renewTicket(raw, serverNow: serverNow, fetchStarted: started)
            },
            isOwnerSignedIn: owner,
            send: { body in try await repository.syncOffline(body) }
        )
    }

    // MARK: Partial success

    @MainActor
    func testPartialSuccessDeletesReceivedKeepsRejectedWithItsCodeAndLeavesMissingPending() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(4, clock: clock)
        let ids = offline.queue.items.map(\.id)
        server.setHandler { request in
            let sent = Set(SyncStub.keys(request))
            var rows: [SyncStub.Row] = []
            if sent.contains(ids[0]) { rows.append((key: ids[0], outcome: "applied", code: nil)) }
            if sent.contains(ids[1]) { rows.append((key: ids[1], outcome: "duplicate", code: nil)) }
            if sent.contains(ids[2]) { rows.append((key: ids[2], outcome: "rejected", code: "REPORT_FINALISED")) }
            return SyncStub.results(rows) // ids[3] is never answered
        }
        let engine = makeEngine(offline)

        let result = await engine.run(trigger: .automatic, trustedNow: nil)

        XCTAssertEqual(result, .sent(received: 2, rejected: 1))
        XCTAssertEqual(offline.queue.items.map(\.id), [ids[2], ids[3]])
        XCTAssertEqual(offline.queue.items[0].state, .rejected)
        XCTAssertEqual(offline.queue.items[0].rejectionCode, "REPORT_FINALISED")
        XCTAssertEqual(offline.queue.items[1].state, .pending, "no answer for it: still waiting, never assumed received")
        let calls = SyncStub.calls()
        XCTAssertEqual(calls.count, 1, "an unanswered entry ends the run: nothing later can overtake it")
        XCTAssertEqual(calls[0].httpMethod, "POST")
        XCTAssertEqual(calls[0].url?.path, "/rest/v1/attendance/me/sync")
    }

    @MainActor
    func testNoLaterBatchIsSentWhileAnEarlierEntryIsUnanswered() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(30, clock: clock)
        let ids = offline.queue.items.map(\.id)
        let unanswered = ids[3]
        server.setHandler { request in
            SyncStub.results(SyncStub.keys(request).filter { $0 != unanswered }.map { (key: $0, outcome: "applied", code: nil) })
        }
        let engine = makeEngine(offline)
        let result = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(result, .sent(received: 24, rejected: 0))
        XCTAssertEqual(SyncStub.calls().count, 1, "entries 26-30 wait behind the unanswered entry 4")
        XCTAssertEqual(offline.queue.pending.first?.id, unanswered)
        XCTAssertEqual(offline.queue.pending.count, 6)
    }

    @MainActor
    func testNothingIsSentWhenTheSignedInUserIsNotTheQueuesOwner() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(2, clock: clock)
        server.setHandler { request in SyncStub.applyAll(request) }
        let engine = makeEngine(offline, owner: { false })
        let result = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertEqual(result, .failed)
        XCTAssertTrue(SyncStub.calls().isEmpty, "another account never sends this queue")
        XCTAssertEqual(offline.queue.pending.count, 2)
    }

    @MainActor
    func testTheEngineTellsANoAnswerStopFromAnAnswer() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(1, clock: clock)
        let answer = StubFlag(false)
        server.setHandler { _ in answer.value ? .json(500, "") : .failure(.notConnectedToInternet) }
        let engine = makeEngine(offline)
        _ = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertTrue(engine.lastRunEndedWithoutAnswer)
        answer.value = true
        _ = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertFalse(engine.lastRunEndedWithoutAnswer, "a 500 is an answer")
    }

    @MainActor
    func testTheSyncRequestIsBoundToTheQueuesOwner() async throws {
        server.setHandler { request in SyncStub.applyAll(request) }
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "access-b", refreshToken: "refresh-b")
        try tokens.setSessionUserId(OfflineFixtures.otherUserId)
        let repository = StaffRepository(api: client)
        let body = OfflineSyncRequestBody(entries: [])
        do {
            _ = try await repository.syncOffline(body, ownerUserId: OfflineFixtures.userId)
            XCTFail("sent under another account")
        } catch {
            XCTAssertEqual(error as? APIError, .sessionChanged)
        }
        XCTAssertTrue(SyncStub.calls().isEmpty, "nothing reaches the server under the wrong identity")
        _ = try await repository.syncOffline(body, ownerUserId: OfflineFixtures.otherUserId)
        XCTAssertEqual(SyncStub.calls().count, 1)
        XCTAssertEqual(SyncStub.calls().first?.bearer, "Bearer access-b")
    }

    @MainActor
    func testRetryAfterIsCappedAtFifteenMinutes() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(1, clock: clock)
        let millis = Millis()
        server.setHandler { _ in .json(429, "\"Too many requests\"", headers: ["Retry-After": "86400"]) }
        let engine = makeEngine(offline, millis: millis)
        _ = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(engine.retryAfterUntilMs, millis.value + 900_000)
    }

    @MainActor
    func testAtMostTwentyFivePerRequestInClientSeqOrderAndOnlyTheEntriesAreSent() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(30, clock: clock)
        server.setHandler { request in SyncStub.applyAll(request) }
        let engine = makeEngine(offline)

        let result = await engine.run(trigger: .automatic, trustedNow: nil)

        XCTAssertEqual(result, .sent(received: 30, rejected: 0))
        XCTAssertTrue(offline.queue.items.isEmpty)
        let calls = SyncStub.calls()
        XCTAssertEqual(calls.map { SyncStub.entries($0).count }, [25, 5])
        let seqs = calls.flatMap { SyncStub.entries($0).compactMap { ($0["clientSeq"] as? NSNumber)?.int64Value } }
        XCTAssertEqual(seqs, seqs.sorted(), "replayed in clientSeq order")
        XCTAssertEqual(Set(seqs).count, 30)
        XCTAssertEqual(calls[0].jsonBody.map { Set($0.keys) }, ["entries"])
        for entry in calls.flatMap({ SyncStub.entries($0) }) {
            for forbidden in ["organisationId", "workspaceId", "staffProfileId", "status", "clockInAt", "clockOutAt"] {
                XCTAssertNil(entry[forbidden], forbidden)
            }
        }
    }

    // MARK: Whole-batch refusal

    @MainActor
    func testAWholeBatch400IsResentOneByOneAndOnlyTheOffenderIsParked() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(3, clock: clock)
        let ids = offline.queue.items.map(\.id)
        let bad = ids[1]
        server.setHandler { request in
            let sent = SyncStub.keys(request)
            if sent.count > 1 || sent == [bad] {
                return .json(400, #"{"message":["entries.0.foo should not exist"],"statusCode":400}"#)
            }
            return SyncStub.applyAll(request)
        }
        let engine = makeEngine(offline)

        let result = await engine.run(trigger: .automatic, trustedNow: nil)

        XCTAssertEqual(result, .sent(received: 2, rejected: 0))
        XCTAssertEqual(offline.queue.items.map(\.id), [bad])
        XCTAssertEqual(offline.queue.items.first?.state, .undeliverable)
        XCTAssertEqual(offline.queue.unsentCount, 1, "parked, still unsent: sign-out asks first")
        XCTAssertEqual(SyncStub.calls().count, 4, "1 batch + 3 single resends")
    }

    // MARK: 429 and backoff

    @MainActor
    func testRateLimitHonoursRetryAfterForEveryTrigger() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(2, clock: clock)
        let millis = Millis()
        let limited = StubFlag(true)
        server.setHandler { request in
            limited.value ? .json(429, #""Too many requests""#, headers: ["Retry-After": "120"]) : SyncStub.applyAll(request)
        }
        let engine = makeEngine(offline, millis: millis)

        let first = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(first, .failed)
        let manual = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertEqual(manual, .deferred, "even Send now waits for Retry-After")
        XCTAssertEqual(SyncStub.calls().count, 1)
        XCTAssertEqual(offline.queue.pending.count, 2)

        limited.value = false
        millis.value += 120_000
        let later = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(later, .sent(received: 2, rejected: 0))
        XCTAssertTrue(offline.queue.items.isEmpty)
    }

    @MainActor
    func testNetworkFailureBacksOffExponentiallyUpToFiveMinutesAndSendNowSkipsTheWait() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(1, clock: clock)
        let millis = Millis()
        server.setHandler { _ in .failure(.notConnectedToInternet) }
        let engine = makeEngine(offline, millis: millis)

        let first = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(first, .failed)
        XCTAssertEqual(engine.notBeforeMs, millis.value + 1_000)
        let waiting = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(waiting, .deferred)
        XCTAssertEqual(SyncStub.calls().count, 1)

        millis.value += 1_000
        let second = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(second, .failed)
        XCTAssertEqual(engine.notBeforeMs, millis.value + 2_000)

        let manual = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertEqual(manual, .failed, "Send now does not wait for the backoff")
        XCTAssertEqual(SyncStub.calls().count, 3)
        for _ in 0..<12 { _ = await engine.run(trigger: .manual, trustedNow: nil) }
        XCTAssertEqual(engine.notBeforeMs, millis.value + 300_000, "capped at 5 minutes")
        XCTAssertEqual(offline.queue.pending.count, 1, "nothing is dropped on failure")
    }

    @MainActor
    func testAServerWithoutTheRouteOrAServerErrorKeepsTheQueueAndBacksOff() async throws {
        for status in [404, 500, 503] {
            URLProtocolStub.server.reset()
            let clock = FakeBootClock()
            let offline = try makeOffline(1, clock: clock)
            server.setHandler { _ in .json(status, #"{"message":"Not found."}"#) }
            let engine = makeEngine(offline)
            let result = await engine.run(trigger: .automatic, trustedNow: nil)
            XCTAssertEqual(result, .failed, "\(status)")
            XCTAssertNotNil(engine.notBeforeMs)
            XCTAssertEqual(offline.queue.pending.count, 1)
        }
    }

    // MARK: Replay safety and fail-closed outcomes

    @MainActor
    func testAnUncertainTimeoutKeepsTheEntryAndTheResendIsAnsweredReplayed() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(2, clock: clock)
        let ids = offline.queue.items.map(\.id)
        let timeOut = StubFlag(true)
        server.setHandler { _ in
            if timeOut.value { return .failure(.timedOut) }
            return SyncStub.results([
                (key: ids[0], outcome: "replayed", code: nil),
                (key: ids[1], outcome: "replayed", code: "SHIFT_NOT_OPEN"),
            ])
        }
        let engine = makeEngine(offline)
        let uncertain = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertEqual(uncertain, .failed)
        XCTAssertEqual(offline.queue.pending.count, 2, "maybe applied, maybe not: kept, same keys")

        timeOut.value = false
        let resent = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertEqual(resent, .sent(received: 1, rejected: 1))
        let calls = SyncStub.calls()
        XCTAssertEqual(SyncStub.keys(calls[1]), SyncStub.keys(calls[0]), "the resend carries the same idempotency keys")
        XCTAssertEqual(offline.queue.items.map(\.id), [ids[1]])
        XCTAssertEqual(offline.queue.items.first?.state, .rejected, "a replayed rejection keeps its code")
        XCTAssertEqual(offline.queue.items.first?.rejectionCode, "SHIFT_NOT_OPEN")
    }

    @MainActor
    func testAnUnknownOutcomeStaysPendingAndAMalformedCodeIsNeverStored() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(2, clock: clock)
        let ids = offline.queue.items.map(\.id)
        server.setHandler { _ in
            SyncStub.results([
                (key: ids[0], outcome: "accepted_maybe", code: nil),
                (key: ids[1], outcome: "rejected", code: "<b>drop table</b>"),
                (key: "someone-elses-key", outcome: "applied", code: nil),
            ])
        }
        let engine = makeEngine(offline)
        let result = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(result, .sent(received: 0, rejected: 1))
        XCTAssertEqual(offline.queue.items.first { $0.id == ids[0] }?.state, .pending)
        XCTAssertEqual(offline.queue.items.first { $0.id == ids[1] }?.rejectionCode, "REJECTED")
        XCTAssertEqual(OfflineSyncMessages.reason("REJECTED"), "This action was not accepted.")
        XCTAssertEqual(OfflineSyncMessages.reason("NOT_CLOCKED_IN"), "You are not clocked in for this shift.")
    }

    @MainActor
    func testAnUndecodableAnswerKeepsEverythingPending() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(1, clock: clock)
        server.setHandler { _ in .json(200, #"{"results":"nope"}"#) }
        let engine = makeEngine(offline)
        let result = await engine.run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(result, .failed)
        XCTAssertEqual(offline.queue.pending.count, 1)
    }

    // MARK: Age, ticket, single flight

    @MainActor
    func testEntriesOlderThanSeventyTwoHoursAreNeverSent() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(1, clock: clock)
        let captured = try XCTUnwrap(offline.queue.items.first?.estimatedAt)
        let engine = makeEngine(offline)
        let result = await engine.run(trigger: .manual, trustedNow: captured.addingTimeInterval(72 * 3600 + 1))
        XCTAssertEqual(result, .nothingToSend)
        XCTAssertTrue(SyncStub.calls().isEmpty)
        XCTAssertEqual(offline.queue.items.first?.state, .tooOld)
    }

    @MainActor
    func testAFreshTicketInTheAnswerRenewsAnOpenGateButNeverOpensAClosedOne() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(1, clock: clock)
        server.setHandler { request in SyncStub.applyAll(request, ticket: OfflineFixtures.renewedTicket) }
        _ = await makeEngine(offline).run(trigger: .automatic, trustedNow: nil)
        XCTAssertEqual(offline.ticket?.ticket, OfflineFixtures.renewedTicket)

        let closed = try makeOffline(1, clock: clock)
        closed.updateFromServer(enabled: false, ticket: nil, serverNow: nil, fetchStarted: nil)
        XCTAssertEqual(closed.queue.pending.count, 1, "turning offline off never deletes what was saved")
        _ = await makeEngine(closed).run(trigger: .automatic, trustedNow: nil)
        XCTAssertNil(closed.ticket, "only /attendance/me/active can turn offline on")
        XCTAssertFalse(closed.canCapture)
    }

    @MainActor
    func testOneRunAtATime() async throws {
        let clock = FakeBootClock()
        let offline = try makeOffline(1, clock: clock)
        let hold = DispatchSemaphore(value: 0)
        server.setHandler { request in
            hold.wait()
            return SyncStub.applyAll(request)
        }
        let engine = makeEngine(offline)
        let first = Task { @MainActor in await engine.run(trigger: .manual, trustedNow: nil) }
        var waited = 0
        while SyncStub.calls().isEmpty && waited < 300 {
            try await Task.sleep(nanoseconds: 10_000_000)
            waited += 1
        }
        XCTAssertTrue(engine.isRunning)
        let second = await engine.run(trigger: .manual, trustedNow: nil)
        XCTAssertEqual(second, .deferred)
        hold.signal()
        let firstResult = await first.value
        XCTAssertEqual(firstResult, .sent(received: 1, rejected: 0))
        XCTAssertEqual(SyncStub.calls().count, 1)
    }
}

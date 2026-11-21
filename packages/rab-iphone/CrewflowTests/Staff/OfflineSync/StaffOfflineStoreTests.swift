import XCTest
@testable import Crewflow

/// The Staff store wired to the offline queue (DESIGN §3.1, §3.6, D10, D17,
/// D18). With the gate shut (every build today) nothing changes: no header,
/// nothing saved, today's uncertain-outcome handling. With it open (tests
/// only), a clock action that got no answer is saved with the SAME key the
/// online attempt carried, nothing is shown as confirmed, and sending happens
/// after a successful read.
final class StaffOfflineStoreTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }

    override func setUp() {
        super.setUp()
        URLProtocolStub.server.reset()
    }

    private static let emptyPage = #"{"data":[],"nextCursor":null}"#

    private static func activeWithOffline(attendance: String? = nil, enabled: Bool = true) -> String {
        #"{"attendance":\#(attendance ?? "null"),"serverNow":"2026-10-21T08:00:00.000Z","clockInEarlyMinutes":15,"offline":{"enabled":\#(enabled)},"offlineTicket":"\#(OfflineFixtures.ticket)"}"#
    }

    @MainActor
    private func makeStore(_ offline: StaffOfflineAttendance) -> StaffStore {
        let (client, _) = makeClient()
        return StaffStore(repository: StaffRepository(api: client), fence: StaffTestFence(), monotonic: { 1_000_000_000 }, offline: offline)
    }

    @MainActor
    private func openGate() -> (StaffOfflineAttendance, FakeBootClock) {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        return (offline, clock)
    }

    // MARK: Gate shut: exactly today's behaviour

    @MainActor
    func testWithOfflineOffAFailedClockInSendsNoKeySavesNothingAndKeepsTodaysHandling() async {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock, buildAllows: false)
        enableOffline(offline, clock: clock)
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/attendance/clock-in") { return .failure(.notConnectedToInternet) }
            if path.hasSuffix("/attendance/me/active") { return .failure(.notConnectedToInternet) }
            return .failure(.notConnectedToInternet)
        }
        let store = makeStore(offline)

        let ok = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "qr", location: nil)

        XCTAssertFalse(ok)
        let calls = server.requests(to: "/attendance/clock-in")
        XCTAssertEqual(calls.count, 1, "never resent")
        XCTAssertNil(calls.first?.value(forHTTPHeaderField: "Idempotency-Key"), "no header while offline mode is off")
        XCTAssertTrue(offline.queue.items.isEmpty)
        XCTAssertEqual(store.attendanceError?.message, StaffAttendanceMessages.uncertainClockIn)
        XCTAssertEqual(store.unsentSavedCount, 0)
        XCTAssertNil(store.savedOpenShiftId)
    }

    // MARK: Gate open (tests only)

    @MainActor
    func testAnUnansweredClockInIsSavedWithTheSameKeyAndNothingIsShownAsConfirmed() async throws {
        let (offline, _) = openGate()
        server.setHandler { _ in .failure(.notConnectedToInternet) }
        let store = makeStore(offline)

        let ok = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "venue-qr", location: nil)

        XCTAssertFalse(ok, "not confirmed by the server")
        let call = try XCTUnwrap(server.requests(to: "/attendance/clock-in").first)
        let key = try XCTUnwrap(call.value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertNotNil(UUID(uuidString: key))
        XCTAssertEqual(server.requests(to: "/attendance/clock-in").count, 1, "never resent online")
        let saved = try XCTUnwrap(offline.queue.items.first)
        XCTAssertEqual(saved.entry.idempotencyKey, key, "the saved copy carries the online attempt's key (D17)")
        XCTAssertEqual(saved.entry.type, .clockIn)
        XCTAssertEqual(saved.entry.qrToken, "venue-qr")
        XCTAssertEqual(saved.state, .pending)
        XCTAssertNil(store.liveAttendance, "nothing optimistic: no attendance until the server answers")
        XCTAssertNil(store.attendanceError)
        XCTAssertEqual(store.savedOpenShiftId, StaffFixtures.shiftId)
        XCTAssertEqual(store.savedPunch(.clockIn, shiftId: StaffFixtures.shiftId)?.id, saved.id)
        XCTAssertEqual(store.unsentSavedCount, 1)
    }

    @MainActor
    func testATimeoutAfterSendingIsSavedTooBecauseTheKeyMakesItSafe() async throws {
        let (offline, _) = openGate()
        server.setHandler { _ in .failure(.timedOut) }
        let store = makeStore(offline)
        _ = await store.checkIn(shiftId: StaffFixtures.shiftId, location: nil)
        let saved = try XCTUnwrap(offline.queue.items.first)
        XCTAssertEqual(saved.entry.type, .checkIn)
        let keys = Set(server.requests(to: "/attendance/check-in").compactMap { $0.value(forHTTPHeaderField: "Idempotency-Key") })
        XCTAssertEqual(keys, [saved.entry.idempotencyKey], "the repeat-safe transport retry and the saved copy share one key")
    }

    @MainActor
    func testARefusalWithAnAnswerIsNeverSaved() async {
        let (offline, _) = openGate()
        server.setHandler { request in
            if (request.url?.path ?? "").hasSuffix("/attendance/clock-in") {
                return .json(409, #"{"message":"x","code":"SHIFT_NOT_CONFIRMED"}"#)
            }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStore(offline)
        _ = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "qr", location: nil)
        XCTAssertTrue(offline.queue.items.isEmpty, "the server answered: nothing to save")
        XCTAssertEqual(store.attendanceError?.code, "SHIFT_NOT_CONFIRMED")
    }

    @MainActor
    func testASuccessfulActiveReadSendsWhatIsSavedThenShowsTheServersState() async throws {
        let (offline, _) = openGate()
        let online = StubFlag(false)
        let open = StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil)
        server.setHandler { request in
            guard online.value else { return .failure(.notConnectedToInternet) }
            let path = request.url?.path ?? ""
            if path.hasSuffix("/attendance/me/sync") { return SyncStub.applyAll(request) }
            if path.hasSuffix("/attendance/me/active") { return .json(200, StaffOfflineStoreTests.activeWithOffline(attendance: open)) }
            if path.hasSuffix("/attendance/me/history") || path.hasSuffix("/offers/mine") { return .json(200, StaffOfflineStoreTests.emptyPage) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStore(offline)
        _ = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "qr", location: nil)
        XCTAssertEqual(offline.queue.pending.count, 1)

        online.value = true
        await store.refreshActive(silent: true)

        XCTAssertEqual(server.requests(to: "/attendance/me/sync").count, 1)
        XCTAssertTrue(offline.queue.items.isEmpty, "applied: deleted from the phone")
        XCTAssertEqual(store.liveAttendance?.shiftId, StaffFixtures.shiftId, "the timer now runs from the server's attendance")
        XCTAssertGreaterThanOrEqual(server.requests(to: "/attendance/me/active").count, 2, "re-read after the sync")
        XCTAssertNil(store.savedOpenShiftId)
    }

    @MainActor
    func testAnActiveAnswerWithoutTheOfflineFieldsShutsTheGate() async {
        let (offline, _) = openGate()
        XCTAssertTrue(offline.canCapture)
        server.setHandler { _ in .json(200, StaffFixtures.activeJSON()) }
        let store = makeStore(offline)
        await store.refreshActive()
        XCTAssertFalse(offline.canCapture, "today's server sends no offline fields: offline stays off")
        XCTAssertNil(offline.ticket)
    }

    @MainActor
    func testClockOutAfterASavedClockInIsSavedWhenStillOffline() async throws {
        let (offline, _) = openGate()
        server.setHandler { _ in .failure(.notConnectedToInternet) }
        let store = makeStore(offline)
        _ = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "in", location: nil)

        let ok = await store.clockOutSavedShift(shiftId: StaffFixtures.shiftId, qrToken: "out", location: nil)

        XCTAssertFalse(ok)
        XCTAssertNil(store.attendanceError)
        XCTAssertEqual(offline.queue.pending.map(\.type), [.clockIn, .clockOut])
        XCTAssertEqual(offline.queue.pending.last?.entry.qrToken, "out")
        XCTAssertEqual(server.requests(to: "/attendance/me/sync").count, 1, "what was saved is tried first")
        XCTAssertNil(store.savedOpenShiftId, "both ends saved: nothing more to tap")
    }

    @MainActor
    func testClockOutAfterASavedClockInBecomesAnOnlineClockOutOnceTheClockInIsReceived() async throws {
        let (offline, _) = openGate()
        let online = StubFlag(false)
        let open = StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil)
        let closed = StaffFixtures.attendanceJSON()
        server.setHandler { request in
            guard online.value else { return .failure(.notConnectedToInternet) }
            let path = request.url?.path ?? ""
            if path.hasSuffix("/attendance/me/sync") { return SyncStub.applyAll(request) }
            if path.hasSuffix("/attendance/me/active") { return .json(200, StaffOfflineStoreTests.activeWithOffline(attendance: open)) }
            if path.hasSuffix("/attendance/clock-out") { return .json(200, closed) }
            if path.hasSuffix("/attendance/me/history") || path.hasSuffix("/offers/mine") { return .json(200, StaffOfflineStoreTests.emptyPage) }
            return .json(404, #"{"message":"Not found."}"#)
        }
        let store = makeStore(offline)
        _ = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "in", location: nil)
        online.value = true

        let ok = await store.clockOutSavedShift(shiftId: StaffFixtures.shiftId, qrToken: "out", location: nil)

        XCTAssertTrue(ok)
        XCTAssertEqual(server.requests(to: "/attendance/clock-out").count, 1)
        XCTAssertEqual(server.requests(to: "/attendance/clock-out").first?.jsonBody?["qrToken"] as? String, "out")
        XCTAssertTrue(offline.queue.items.isEmpty)
    }

    // MARK: Sign-out (D18) and presentation (D10)

    @MainActor
    func testUnsentActionsBlockSignOutUntilExplicitlyDiscarded() async throws {
        let store0 = InMemorySecureStore()
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: store0, clock: clock)
        enableOffline(offline, clock: clock)
        server.setHandler { _ in .failure(.notConnectedToInternet) }
        let store = makeStore(offline)
        _ = await store.clockIn(shiftId: StaffFixtures.shiftId, qrToken: "qr", location: nil)
        XCTAssertEqual(store.unsentSavedCount, 1)
        XCTAssertEqual(StaffOfflinePresentation.signOutTitle(1), "1 action is saved on this phone and not sent yet")

        store.discardAllSaved()
        XCTAssertEqual(store.unsentSavedCount, 0)
        XCTAssertNil(store0.string(for: OfflinePunchStorage.queueKey(OfflineFixtures.userId)), "discarded = gone from the phone, never sent")
    }

    @MainActor
    func testSavedActionWordsUseTheServerAnchoredTimeAndNeverTick() throws {
        let (offline, _) = openGate()
        let punch = try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())
        let time = CrewflowDateFormat.time(punch.estimatedAt)
        XCTAssertEqual(StaffOfflinePresentation.savedClockIn(punch), "Clocked in \(time), saved on this phone, not yet confirmed")
        XCTAssertEqual(StaffOfflinePresentation.title(punch), "Clock-in saved on this phone at \(time)")
        XCTAssertEqual(StaffOfflinePresentation.detail(punch), "No connection. It will be sent when you're back online.")

        var rejected = punch
        rejected.state = .rejected
        rejected.rejectionCode = "REPORT_FINALISED"
        XCTAssertEqual(
            StaffOfflinePresentation.detail(rejected),
            "The shift report was already finalised. Your manager can see this and can record your hours."
        )
        var old = punch
        old.state = .tooOld
        XCTAssertEqual(StaffOfflinePresentation.detail(old), "Too old to send automatically. Tell your manager.")
    }

    // MARK: Transport

    @MainActor
    func testExtraHeadersCanNeverReplaceTheTransportsOwn() async throws {
        server.setHandler { _ in .empty(204) }
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "real-access", refreshToken: "real-refresh")
        let options = RequestOptions(retry: .never, headers: [
            "Authorization": "Bearer forged",
            "x-client-platform": "web",
            "X-Crewflow-Background": "1",
            "Idempotency-Key": "0d6c3c2e-0000-4000-8000-000000000001",
        ])
        try await client.requestVoid(.post, "/attendance/clock-in", options: options)
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.bearer, "Bearer real-access")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Platform"), "mobile")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Crewflow-Background"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "0d6c3c2e-0000-4000-8000-000000000001")
    }
}

import XCTest
@testable import Crewflow

/// The offline punch queue (DESIGN §3): the gate stays shut unless every
/// condition holds, entries carry the boot clock and never a wall-clock time
/// or a server-derived field, storage is per user and encrypted (Keychain via
/// SecureStore), and the D5 limits hold.
@MainActor
final class OfflinePunchQueueTests: XCTestCase {
    // MARK: The gate (fail closed)

    func testTheGateIsShutByDefaultAndInTheLiveBuild() {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        XCTAssertFalse(offline.canCapture, "no ticket from the server yet")
        XCTAssertFalse(OfflineAttendanceBuildSwitch.isOn(), "the build switch is not set in any configuration")

        let live = StaffOfflineAttendance.live(store: InMemorySecureStore(), userId: OfflineFixtures.userId)
        live.updateFromServer(enabled: true, ticket: OfflineFixtures.ticket, serverNow: OfflineFixtures.serverNow, fetchStarted: live.clock.reading())
        XCTAssertFalse(live.canCapture, "the live build has no device-key signer and no build switch: it can never save offline")
        XCTAssertThrowsError(try live.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .notEnabled)
        }
        XCTAssertTrue(live.queue.items.isEmpty)
    }

    func testTheGateNeedsTheBuildSwitchASignerAndTheServerFlag() {
        for (build, hasSigner) in [(false, true), (true, false)] {
            let clock = FakeBootClock()
            let offline = makeOfflineAttendance(clock: clock, signer: hasSigner ? FakeSigner() : nil, buildAllows: build)
            enableOffline(offline, clock: clock)
            XCTAssertFalse(offline.canCapture, "build \(build) signer \(hasSigner)")
        }
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        XCTAssertTrue(offline.canCapture)
    }

    func testTheServerTurningOfflineOffOrAnOlderServerClosesTheGateAndForgetsTheTicket() {
        let store = InMemorySecureStore()
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: store, clock: clock)
        enableOffline(offline, clock: clock)
        XCTAssertNotNil(store.string(for: OfflinePunchStorage.ticketKey(OfflineFixtures.userId)))

        offline.updateFromServer(enabled: false, ticket: OfflineFixtures.ticket, serverNow: OfflineFixtures.serverNow, fetchStarted: clock.reading())
        XCTAssertFalse(offline.canCapture)
        XCTAssertNil(store.string(for: OfflinePunchStorage.ticketKey(OfflineFixtures.userId)))

        enableOffline(offline, clock: clock)
        offline.updateFromServer(enabled: nil, ticket: nil, serverNow: OfflineFixtures.serverNow, fetchStarted: clock.reading())
        XCTAssertFalse(offline.canCapture, "an answer without the offline fields (older server) means off")

        offline.updateFromServer(enabled: true, ticket: "not a jws", serverNow: OfflineFixtures.serverNow, fetchStarted: clock.reading())
        XCTAssertFalse(offline.canCapture, "a malformed ticket is never stored")
    }

    func testATicketWhoseFetchTookOverTenSecondsIsThrownAway() {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        let started = clock.reading()
        clock.advance(ms: 10_001)
        offline.updateFromServer(enabled: true, ticket: OfflineFixtures.ticket, serverNow: OfflineFixtures.serverNow, fetchStarted: started)
        XCTAssertNil(offline.ticket)
        XCTAssertFalse(offline.canCapture)
    }

    func testCaptureIsRefusedSixteenHoursAfterTheTicketAndAfterAReboot() throws {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        clock.advance(ms: 16 * 3_600_000)
        XCTAssertTrue(offline.canCapture, "exactly 16 h is still allowed")
        clock.advance(ms: 1)
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .connectOnce)
            XCTAssertEqual(($0 as? OfflineCaptureRefusal)?.message, "Connect once to enable offline clocking.")
        }

        let rebootClock = FakeBootClock()
        let rebooted = makeOfflineAttendance(clock: rebootClock)
        enableOffline(rebooted, clock: rebootClock)
        rebootClock.reboot()
        XCTAssertThrowsError(try rebooted.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .connectOnce, "boot-clock readings from different boots are never compared")
        }
        rebootClock.current = nil
        XCTAssertFalse(rebooted.canCapture, "no boot clock, no capture")
    }

    // MARK: The entry

    func testAnEntryCarriesTheBootClockTheTicketAndASignatureOverItsCanonicalBytes() throws {
        let clock = FakeBootClock()
        let signer = FakeSigner()
        let offline = makeOfflineAttendance(clock: clock, signer: signer)
        enableOffline(offline, clock: clock)
        let ticketBootMs = try XCTUnwrap(offline.ticket?.received.bootMs)
        clock.advance(ms: 4 * 60_000) // the button is pressed 4 minutes after the ticket arrived
        let fix = StaffLocationFix(lat: 51.4545, lng: -2.5879, accuracyM: 12, capturedAt: Date(), ageSeconds: 3, mock: true)
        let key = OfflineFixtures.key()

        let punch = try offline.capture(.make(.clockIn, key: key, qr: "venue-qr-verbatim", location: fix), context: OfflineAttendanceContext())

        let entry = punch.entry
        XCTAssertEqual(entry.v, 1)
        XCTAssertEqual(entry.idempotencyKey, key, "the online attempt's key is kept (D17)")
        XCTAssertEqual(entry.type, .clockIn)
        XCTAssertEqual(entry.shiftId, OfflineFixtures.shiftId)
        XCTAssertEqual(entry.ticket, OfflineFixtures.ticket)
        XCTAssertEqual(entry.bootId, "boot-A")
        XCTAssertEqual(entry.punchBootId, "boot-A")
        XCTAssertEqual(entry.ticketBootMs, ticketBootMs)
        XCTAssertEqual(entry.punchBootMs - entry.ticketBootMs, 4 * 60_000, "elapsed comes from the boot clock")
        XCTAssertEqual(entry.qrToken, "venue-qr-verbatim")
        XCTAssertEqual(entry.location, OfflinePunchLocation(lat: 51.4545, lng: -2.5879, accuracyM: 12, fixBootMs: entry.punchBootMs - 3_000, mock: true))
        XCTAssertEqual(entry.deviceKeyId, "dk-test-0001")
        XCTAssertEqual(entry.deviceWallClockAt, "2001-01-01T00:00:00.000Z", "the wall clock is copied for diagnostics only")
        XCTAssertEqual(punch.estimatedAt, OfflineFixtures.serverNow.addingTimeInterval(240), "the shown time is server time + boot elapsed, not the wrong wall clock")
        XCTAssertEqual(signer.messages.last, try entry.signingInput())
        XCTAssertFalse(entry.sig.isEmpty)
    }

    func testAnEntryNeverCarriesAServerDerivedFieldOrATime() throws {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        let punch = try offline.capture(.make(.clockIn, qr: "qr"), context: OfflineAttendanceContext())
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: CrewflowJSON.makeEncoder().encode(punch.entry)) as? [String: Any])
        for forbidden in ["organisationId", "workspaceId", "staffProfileId", "status", "clockInAt", "clockOutAt", "estimatedAt", "amountPence", "earnedPence", "state"] {
            XCTAssertNil(json[forbidden], forbidden)
        }
        XCTAssertEqual(Set(json.keys), [
            "v", "idempotencyKey", "clientSeq", "type", "shiftId", "ticket", "bootId", "ticketBootMs", "punchBootId",
            "punchBootMs", "deviceWallClockAt", "qrToken", "integrity", "appVersion", "deviceKeyId", "sig",
        ], "exactly the DESIGN §3.2 members; nil members are omitted, never null")
    }

    func testClientSeqIsStrictlyIncreasingAndNeverReusedEvenAfterTheQueueEmpties() throws {
        let store = InMemorySecureStore()
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: store, clock: clock)
        enableOffline(offline, clock: clock)
        let first = try offline.capture(.make(.checkIn), context: OfflineAttendanceContext())
        let second = try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())
        XCTAssertLessThan(first.entry.clientSeq, second.entry.clientSeq)
        offline.queue.discardAll()

        let reopened = makeOfflineAttendance(store: store, clock: clock)
        let third = try reopened.capture(.make(.clockIn), context: OfflineAttendanceContext())
        XCTAssertGreaterThan(third.entry.clientSeq, second.entry.clientSeq, "the counter lives in the secure store, not in the queue")
    }

    func testASigningFailureSavesNothing() {
        let clock = FakeBootClock()
        let signer = FakeSigner()
        signer.fails = true
        let offline = makeOfflineAttendance(clock: clock, signer: signer)
        enableOffline(offline, clock: clock)
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .notSaved)
        }
        XCTAssertTrue(offline.queue.items.isEmpty)
    }

    // MARK: Storage (encrypted, per user)

    func testTheQueueIsStoredPerUserInTheSecureStoreAndSurvivesARestart() throws {
        let store = InMemorySecureStore()
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: store, clock: clock)
        enableOffline(offline, clock: clock)
        let punch = try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())
        XCTAssertNotNil(store.string(for: OfflinePunchStorage.queueKey(OfflineFixtures.userId)))

        let restarted = makeOfflineAttendance(store: store, clock: clock)
        XCTAssertEqual(restarted.queue.items, [punch])
        XCTAssertNotNil(restarted.ticket, "the ticket survives a restart in the same boot")

        let otherUser = makeOfflineAttendance(store: store, userId: OfflineFixtures.otherUserId, clock: clock)
        XCTAssertTrue(otherUser.queue.items.isEmpty, "another user on the same phone never sees (or sends) this queue")
        XCTAssertNil(otherUser.ticket)
        XCTAssertFalse(otherUser.canCapture)
    }

    func testAnUnreadableStoredQueueIsNeverOverwrittenAndStillBlocksSignOut() {
        let store = InMemorySecureStore([OfflinePunchStorage.queueKey(OfflineFixtures.userId): "{not json"])
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: store, clock: clock)
        enableOffline(offline, clock: clock)
        XCTAssertTrue(offline.queue.unreadable)
        XCTAssertEqual(offline.queue.unsentCount, 1)
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .notSaved)
        }
        XCTAssertEqual(store.string(for: OfflinePunchStorage.queueKey(OfflineFixtures.userId)), "{not json")
        XCTAssertFalse(offline.queue.discardAll(), "an unreadable queue is never wiped, not even by an explicit discard")
        XCTAssertEqual(store.string(for: OfflinePunchStorage.queueKey(OfflineFixtures.userId)), "{not json")
        XCTAssertEqual(offline.queue.unsentCount, 1, "the sign-out guard keeps showing")
    }

    @MainActor
    func testAFailedKeychainReadIsNeverTakenForAnEmptyQueue() throws {
        let key = OfflinePunchStorage.queueKey(OfflineFixtures.userId)
        let keychain = FailingReadSecureStore([key: "[stored punches]"], failingPrefixes: [key])
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: keychain, clock: clock)
        enableOffline(offline, clock: clock)
        XCTAssertTrue(offline.queue.unreadable, "a failed read is unreadable, not empty")
        XCTAssertEqual(offline.queue.unsentCount, 1, "the sign-out guard shows")
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .notSaved)
        }
        XCTAssertFalse(offline.queue.discardAll())
        XCTAssertEqual(keychain.inner.string(for: key), "[stored punches]", "never overwritten, never deleted")

        // Reads recover (first unlock): the queue is read again before any write.
        keychain.failingPrefixes = []
        offline.queue.reload()
        XCTAssertTrue(offline.queue.unreadable, "the stored text itself is not a queue: still never overwritten")
    }

    @MainActor
    func testAQueueThatBecomesUnreadableAfterLoadingIsNotOverwritten() throws {
        let key = OfflinePunchStorage.queueKey(OfflineFixtures.userId)
        let keychain = FailingReadSecureStore(failingPrefixes: [])
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: keychain, clock: clock)
        enableOffline(offline, clock: clock)
        try offline.capture(.make(.checkIn), context: OfflineAttendanceContext())
        let stored = keychain.inner.string(for: key)
        keychain.failingPrefixes = [key]
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .notSaved)
        }
        XCTAssertEqual(keychain.inner.string(for: key), stored)
        XCTAssertTrue(offline.queue.unreadable)
    }

    @MainActor
    func testAFailedCounterOrInstallIdReadRefusesCapture() {
        for prefix in ["rab.offline.seq.", OfflinePunchStorage.installIdKey] {
            let keychain = FailingReadSecureStore(failingPrefixes: [prefix])
            let clock = FakeBootClock()
            let offline = makeOfflineAttendance(store: keychain, clock: clock)
            enableOffline(offline, clock: clock)
            XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext()), prefix) {
                XCTAssertEqual($0 as? OfflineCaptureRefusal, .notSaved, "clientSeq is never numbered from a guess")
            }
            XCTAssertTrue(offline.queue.items.isEmpty)
        }
        let corrupt = InMemorySecureStore([OfflinePunchStorage.installIdKey: "install-1", OfflinePunchStorage.sequenceKey("install-1"): "not a number"])
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(store: corrupt, clock: clock)
        enableOffline(offline, clock: clock)
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .notSaved)
        }
    }

    // MARK: Limits (D5, §3.4)

    func testTheQueueHoldsAtMostThirtyEntries() throws {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        for index in 0..<30 {
            try offline.capture(.make(.checkIn, shiftId: "shift-\(index)"), context: OfflineAttendanceContext())
        }
        XCTAssertThrowsError(try offline.capture(.make(.checkIn, shiftId: "shift-31"), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .full)
            XCTAssertEqual(($0 as? OfflineCaptureRefusal)?.message, "Too many actions saved on this phone. Connect to send them.")
        }
        XCTAssertEqual(offline.queue.items.count, 30)
    }

    func testTheQueueHoldsAtMostItsByteLimit() throws {
        var limits = OfflineQueueLimits.standard
        limits.maxBytes = 3_000
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock, limits: limits)
        enableOffline(offline, clock: clock)
        let bigQR = String(repeating: "q", count: 1_200)
        try offline.capture(.make(.clockIn, shiftId: "a", qr: bigQR), context: OfflineAttendanceContext())
        XCTAssertThrowsError(try offline.capture(.make(.checkIn, shiftId: "c", qr: bigQR + bigQR), context: OfflineAttendanceContext())) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .full)
        }
        XCTAssertEqual(offline.queue.items.count, 1)
    }

    func testEntriesOlderThanSeventyTwoHoursOnTheServerClockAreNotSent() throws {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        let punch = try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())
        offline.queue.markTooOld(now: nil)
        XCTAssertEqual(offline.queue.items.first?.state, .pending, "no trusted time: nothing is judged (the server decides)")
        offline.queue.markTooOld(now: punch.estimatedAt.addingTimeInterval(72 * 3600))
        XCTAssertEqual(offline.queue.items.first?.state, .pending, "exactly 72 h is still sent")
        offline.queue.markTooOld(now: punch.estimatedAt.addingTimeInterval(72 * 3600 + 1))
        XCTAssertEqual(offline.queue.items.first?.state, .tooOld)
        XCTAssertTrue(offline.queue.pending.isEmpty, "never sent")
        XCTAssertEqual(offline.queue.unsentCount, 1, "still blocks sign-out until dismissed")
        offline.queue.dismiss(id: punch.id)
        XCTAssertTrue(offline.queue.items.isEmpty)
    }

    // MARK: Local dependency checks (UX only)

    func testDependencyChecks() throws {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        let none = OfflineAttendanceContext()
        XCTAssertThrowsError(try offline.capture(.make(.clockOut), context: none)) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .notClockedIn, "no clock-out without a clock-in")
        }
        XCTAssertThrowsError(try offline.capture(.make(.breakEnd), context: none)) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .noOpenBreak)
        }
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext(activeShiftId: OfflineFixtures.shiftId))) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .alreadyClockedIn)
        }
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: OfflineAttendanceContext(activeShiftId: OfflineFixtures.otherShiftId))) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .anotherShiftOpen)
        }

        try offline.capture(.make(.clockIn), context: none)
        XCTAssertThrowsError(try offline.capture(.make(.clockIn), context: none)) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .alreadySaved)
        }
        XCTAssertThrowsError(try offline.capture(.make(.clockIn, shiftId: OfflineFixtures.otherShiftId), context: none)) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .anotherShiftOpen)
        }
        try offline.capture(.make(.breakStart), context: none)
        XCTAssertThrowsError(try offline.capture(.make(.breakStart), context: none)) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .breakAlreadyOpen, "no second open break")
        }
        try offline.capture(.make(.breakEnd), context: none)
        try offline.capture(.make(.clockOut), context: none)
        XCTAssertThrowsError(try offline.capture(.make(.clockOut), context: none)) {
            XCTAssertEqual($0 as? OfflineCaptureRefusal, .alreadySaved)
        }
        XCTAssertEqual(offline.queue.pending.map(\.type), [.clockIn, .breakStart, .breakEnd, .clockOut], "replay order = capture order")

        // A server-confirmed attendance (online clock-in) allows an offline clock-out.
        let other = makeOfflineAttendance(clock: clock)
        enableOffline(other, clock: clock)
        XCTAssertNoThrow(try other.capture(.make(.clockOut), context: OfflineAttendanceContext(activeShiftId: OfflineFixtures.shiftId)))
    }

    func testSettleRemovesReceivedRejectsWithACodeAndKeepsTheRest() throws {
        let clock = FakeBootClock()
        let offline = makeOfflineAttendance(clock: clock)
        enableOffline(offline, clock: clock)
        let a = try offline.capture(.make(.checkIn), context: OfflineAttendanceContext())
        let b = try offline.capture(.make(.clockIn), context: OfflineAttendanceContext())
        let c = try offline.capture(.make(.checkIn, shiftId: "other"), context: OfflineAttendanceContext())
        offline.queue.settle(remove: [a.id], rejected: [b.id: "REPORT_FINALISED"])
        XCTAssertEqual(offline.queue.items.map(\.id), [b.id, c.id])
        XCTAssertEqual(offline.queue.items.first?.state, .rejected)
        XCTAssertEqual(offline.queue.items.first?.rejectionCode, "REPORT_FINALISED")
        XCTAssertEqual(offline.queue.unsentCount, 1, "a rejected action reached the server; it does not block sign-out")
        offline.queue.dismiss(id: c.id)
        XCTAssertEqual(offline.queue.items.count, 2, "a pending action is never dismissed one by one")
    }
}

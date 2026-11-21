import Foundation
import XCTest
@testable import Crewflow

/// A boot clock the test moves by hand (and can "reboot").
final class FakeBootClock: OfflineBootClock {
    var current: OfflineBootReading? = OfflineBootReading(bootId: "boot-A", bootMs: 5_000_000)

    func reading() -> OfflineBootReading? { current }

    func advance(ms: Int64) {
        guard let now = current else { return }
        current = OfflineBootReading(bootId: now.bootId, bootMs: now.bootMs + ms)
    }

    func reboot() {
        current = OfflineBootReading(bootId: "boot-B", bootMs: 1_000)
    }
}

/// Records every message it signs; the signature names the message's hash so
/// a test can prove the signature covers exactly the canonical bytes.
final class FakeSigner: OfflineEntrySigning {
    let deviceKeyId = "dk-test-0001"
    private(set) var messages: [Data] = []
    var fails = false

    func signature(for message: Data) throws -> String {
        if fails { throw OfflineCanonicalJSON.Failure.encoding }
        messages.append(message)
        return "sig-\(message.count)-\(message.hashValue)"
    }
}

enum OfflineFixtures {
    /// A syntactically valid compact JWS (the phone never verifies it).
    static let ticket = "eyJhbGciOiJIUzI1NiJ9.eyJ0IjoxfQ.c2lnbmF0dXJl"
    static let renewedTicket = "eyJhbGciOiJIUzI1NiJ9.eyJ0IjoyfQ.bmV3c2lnbmF0dXJl"
    static let serverNow = StaffFixtures.date("2026-11-21T08:58:00.000Z")
    static let userId = "11111111-2222-4333-8444-555555555555"
    static let otherUserId = "99999999-8888-4777-8666-555555555555"
    static let shiftId = StaffFixtures.shiftId
    static let otherShiftId = "0ff5e7a1-0000-4000-8000-00000000beef"

    static func key() -> String { UUID().uuidString.lowercased() }
}

@MainActor
func makeOfflineAttendance(
    store: any SecureStore = InMemorySecureStore(),
    userId: String = OfflineFixtures.userId,
    clock: FakeBootClock = FakeBootClock(),
    signer: FakeSigner? = FakeSigner(),
    buildAllows: Bool = true,
    limits: OfflineQueueLimits = .standard,
    wallClock: Date = StaffFixtures.date("2001-01-01T00:00:00.000Z")
) -> StaffOfflineAttendance {
    StaffOfflineAttendance(
        storage: OfflinePunchStorage(store: store, userId: userId),
        clock: clock,
        signer: signer,
        buildAllows: buildAllows,
        appVersion: "0.1.0 (1)",
        limits: limits,
        wallClock: { wallClock },
        rootedSignal: { false }
    )
}

/// Opens the gate the way a real `/attendance/me/active` answer would: the
/// server says enabled, sends a ticket, and the fetch took 300 ms.
@MainActor
func enableOffline(_ offline: StaffOfflineAttendance, clock: FakeBootClock, serverNow: Date = OfflineFixtures.serverNow) {
    let started = clock.reading()
    clock.advance(ms: 300)
    offline.updateFromServer(enabled: true, ticket: OfflineFixtures.ticket, serverNow: serverNow, fetchStarted: started)
}

extension OfflinePunchRequest {
    static func make(_ type: OfflinePunchType, shiftId: String = OfflineFixtures.shiftId, key: String = OfflineFixtures.key(), qr: String? = nil, location: StaffLocationFix? = nil) -> OfflinePunchRequest {
        OfflinePunchRequest(type: type, shiftId: shiftId, idempotencyKey: key, qrToken: qr, location: location)
    }
}

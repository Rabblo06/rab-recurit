import Combine
import Foundation

/// The build-level switch for offline clocking: Info.plist
/// `CrewflowOfflineAttendance` = YES. The key is not in any configuration, so
/// it is OFF in every build. Owner HARD RULE (DESIGN top): offline mode stays
/// off everywhere until M5 payroll adjustments exist and `POST
/// /attendance/me/sync` has been pen-tested. This switch is a second gate next
/// to the server's per-venue flag, not a way around it.
enum OfflineAttendanceBuildSwitch {
    static let infoKey = "CrewflowOfflineAttendance"

    static func isOn(bundle: Bundle = .main) -> Bool {
        (bundle.object(forInfoDictionaryKey: infoKey) as? Bool) == true
    }
}

/// Why an action could not be saved on the phone. Each has the words the
/// staff member sees (DESIGN §3.4, §3.6).
enum OfflineCaptureRefusal: Error, Equatable {
    case notEnabled
    case connectOnce
    case full
    case notClockedIn
    case alreadyClockedIn
    case anotherShiftOpen
    case alreadySaved
    case breakAlreadyOpen
    case noOpenBreak
    case notSaved

    var message: String {
        switch self {
        case .notEnabled: return APIMessages.offline
        case .connectOnce: return "Connect once to enable offline clocking."
        case .full: return "Too many actions saved on this phone. Connect to send them."
        case .notClockedIn: return "You are not clocked in for this shift."
        case .alreadyClockedIn: return "You have already clocked in for this shift."
        case .anotherShiftOpen: return "You are still clocked in to another shift."
        case .alreadySaved: return "This is already saved on this phone. It will be sent when you're back online."
        case .breakAlreadyOpen: return "Your break has already started."
        case .noOpenBreak: return "You are not on a break."
        case .notSaved: return "This could not be saved on this phone. Connect and try again."
        }
    }
}

/// One action to save, with the idempotency key the online attempt carried.
struct OfflinePunchRequest: Equatable {
    let type: OfflinePunchType
    let shiftId: String
    let idempotencyKey: String
    let qrToken: String?
    let location: StaffLocationFix?
}

/// What the server last said about the person's attendance, for the local
/// dependency checks (UX only; the server decides, §3.4).
struct OfflineAttendanceContext: Equatable {
    var activeShiftId: String?
    var activeOnBreak = false
}

/// Offline clocking for ONE signed-in user (DESIGN §3): the gate, the ticket,
/// and saving an action on the phone. Sending is `OfflineSyncEngine`.
///
/// The gate is closed unless ALL of these hold (§3.1, fail closed):
/// - the build switch is on (`OfflineAttendanceBuildSwitch`, off everywhere);
/// - a device-key signer exists (none does until device-key registration
///   ships on the server);
/// - the server's last answer said offline is enabled and carried a ticket;
/// - the ticket arrived in this boot, less than 16 h ago (boot clock).
///
/// Nothing here computes paid time, and nothing here is optimistic: a saved
/// action is shown as "saved on this phone, not yet confirmed" until the
/// server answers.
@MainActor
final class StaffOfflineAttendance: ObservableObject {
    let queue: OfflinePunchQueue
    let clock: OfflineBootClock
    @Published private(set) var ticket: OfflineTicketRecord?

    private let storage: OfflinePunchStorage
    private let signer: OfflineEntrySigning?
    private let buildAllows: Bool
    private let appVersion: String
    /// The phone's wall clock: copied into `deviceWallClockAt` for the
    /// server's skew flags only. Never a time.
    private let wallClock: () -> Date
    private let rootedSignal: () -> Bool
    /// The signed-in user right now; a send is refused unless it is this
    /// queue's owner. nil (tests only) skips the check.
    private let currentUserId: (() -> String?)?
    private var forwarding: AnyCancellable?

    init(
        storage: OfflinePunchStorage,
        clock: OfflineBootClock,
        signer: OfflineEntrySigning?,
        buildAllows: Bool,
        appVersion: String,
        limits: OfflineQueueLimits = .standard,
        wallClock: @escaping () -> Date = { Date() },
        rootedSignal: @escaping () -> Bool = { OfflineIntegritySignal.rootedSignal() },
        currentUserId: (() -> String?)? = nil
    ) {
        self.storage = storage
        self.clock = clock
        self.signer = signer
        self.buildAllows = buildAllows
        self.appVersion = appVersion
        self.wallClock = wallClock
        self.rootedSignal = rootedSignal
        self.currentUserId = currentUserId
        self.queue = OfflinePunchQueue(storage: storage, limits: limits)
        self.ticket = storage.loadTicket()
        forwarding = queue.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    /// The production instance. `signer: nil`: there is no device key until
    /// `POST /attendance/me/device-key` exists (server M4 step 5), so this
    /// build can never save an action offline.
    static func live(
        store: any SecureStore,
        userId: String,
        currentUserId: @escaping () -> String?,
        bundle: Bundle = .main
    ) -> StaffOfflineAttendance {
        StaffOfflineAttendance(
            storage: OfflinePunchStorage(store: store, userId: userId),
            clock: SystemOfflineBootClock(),
            signer: nil,
            buildAllows: OfflineAttendanceBuildSwitch.isOn(bundle: bundle),
            appVersion: versionString(bundle),
            currentUserId: currentUserId
        )
    }

    /// The signed-in user is this queue's owner (checked before every send).
    func isOwnerSignedIn() -> Bool {
        guard let currentUserId else { return true }
        return currentUserId() == storage.userId
    }

    static func versionString(_ bundle: Bundle) -> String {
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "\(version) (\(build))"
    }

    var limits: OfflineQueueLimits { queue.limits }

    /// Whether an action could be saved on the phone right now.
    var canCapture: Bool { captureBlocker(at: clock.reading()) == nil }

    /// A fresh UUID v4 for one tap (the online attempt and its saved copy
    /// share it, D17).
    func newIdempotencyKey() -> String { UUID().uuidString.lowercased() }

    /// Server time carried forward from the stored ticket by the boot clock
    /// (same boot only). For display and the 72 h check, never for pay.
    func ticketAnchoredNow() -> Date? {
        guard let ticket, let reading = clock.reading(), let elapsed = reading.elapsedMs(since: ticket.received), elapsed >= 0 else {
            return nil
        }
        return ticket.serverNow.addingTimeInterval(TimeInterval(elapsed) / 1000)
    }

    // MARK: - Server answers

    /// `GET /attendance/me/active`: `offline.enabled` and `offlineTicket`
    /// (§3.1, §4.2). Anything but an explicit `enabled: true` with a ticket
    /// and `serverNow` closes the gate and forgets the ticket (an older server
    /// that sends neither leaves offline off). `fetchStarted` is the boot
    /// clock just before the request: a ticket whose fetch took more than
    /// 10 s is thrown away (an earlier one stays usable until it expires).
    func updateFromServer(enabled: Bool?, ticket raw: String?, serverNow: Date?, fetchStarted: OfflineBootReading?) {
        guard enabled == true, let raw, Self.plausibleTicket(raw), let serverNow else {
            storage.clearTicket()
            ticket = nil
            return
        }
        storeTicket(raw, serverNow: serverNow, fetchStarted: fetchStarted)
    }

    /// A fresh ticket in a sync answer. It only renews a gate that is already
    /// open; it never turns offline on by itself.
    func renewTicket(_ raw: String?, serverNow: Date?, fetchStarted: OfflineBootReading?) {
        guard ticket != nil, let raw, Self.plausibleTicket(raw), let serverNow else { return }
        storeTicket(raw, serverNow: serverNow, fetchStarted: fetchStarted)
    }

    private func storeTicket(_ raw: String, serverNow: Date, fetchStarted: OfflineBootReading?) {
        guard let started = fetchStarted, let arrived = clock.reading(), let took = arrived.elapsedMs(since: started),
              took >= 0, took <= limits.maxTicketFetchMs
        else { return }
        let record = OfflineTicketRecord(ticket: raw, received: arrived, serverNow: serverNow)
        do {
            try storage.saveTicket(record)
            ticket = record
        } catch {
            // Not stored = not usable; the previous ticket (if any) stays.
        }
    }

    /// A compact JWS is three base64url parts. Anything else is not stored.
    static func plausibleTicket(_ raw: String) -> Bool {
        guard !raw.isEmpty, raw.utf8.count <= 4096 else { return false }
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")
        return raw.allSatisfy { allowed.contains($0) } && raw.split(separator: ".", omittingEmptySubsequences: false).count == 3
    }

    // MARK: - Saving an action

    /// Saves one action on the phone, signed, in `clientSeq` order. Throws
    /// `OfflineCaptureRefusal` (with the words to show) when the gate is
    /// closed, a limit is reached or the local dependency check fails.
    @discardableResult
    func capture(_ request: OfflinePunchRequest, context: OfflineAttendanceContext) throws -> OfflineQueuedPunch {
        let reading = clock.reading()
        if let refusal = captureBlocker(at: reading) { throw refusal }
        guard let reading, let ticket, let signer else { throw OfflineCaptureRefusal.notEnabled }
        guard !queue.unreadable, UUID(uuidString: request.idempotencyKey) != nil, !request.shiftId.isEmpty else {
            throw OfflineCaptureRefusal.notSaved
        }
        try checkDependencies(request, context: context)
        guard queue.items.count < limits.maxEntries else { throw OfflineCaptureRefusal.full }

        let clientSeq: Int64
        do {
            clientSeq = try storage.nextClientSeq(atLeast: queue.highestClientSeq)
        } catch {
            throw OfflineCaptureRefusal.notSaved
        }
        let elapsed = reading.bootMs - ticket.received.bootMs
        var entry = OfflinePunchEntry(
            v: OfflinePunchEntry.currentVersion,
            idempotencyKey: request.idempotencyKey,
            clientSeq: clientSeq,
            type: request.type,
            shiftId: request.shiftId,
            ticket: ticket.ticket,
            bootId: ticket.received.bootId,
            ticketBootMs: ticket.received.bootMs,
            punchBootId: reading.bootId,
            punchBootMs: reading.bootMs,
            deviceWallClockAt: ISO8601.string(from: wallClock()),
            qrToken: request.qrToken,
            location: request.location.map { Self.evidence($0, at: reading) },
            integrity: OfflinePunchIntegrity(rootedSignal: rootedSignal()),
            appVersion: appVersion,
            deviceKeyId: signer.deviceKeyId,
            sig: ""
        )
        do {
            entry.sig = try signer.signature(for: entry.signingInput())
        } catch {
            throw OfflineCaptureRefusal.notSaved
        }
        let punch = OfflineQueuedPunch(
            entry: entry,
            state: .pending,
            rejectionCode: nil,
            estimatedAt: ticket.serverNow.addingTimeInterval(TimeInterval(elapsed) / 1000)
        )
        do {
            try queue.append(punch)
        } catch OfflinePunchQueue.AppendError.full {
            throw OfflineCaptureRefusal.full
        } catch {
            throw OfflineCaptureRefusal.notSaved
        }
        return punch
    }

    /// The fix's own boot-clock time: the punch reading minus the fix's age
    /// (an age, so a wrong wall clock cancels out, as online).
    static func evidence(_ fix: StaffLocationFix, at reading: OfflineBootReading) -> OfflinePunchLocation {
        let ageMs = Int64((max(0, fix.ageSeconds) * 1000).rounded())
        return OfflinePunchLocation(
            lat: fix.lat,
            lng: fix.lng,
            accuracyM: fix.accuracyM,
            fixBootMs: max(0, reading.bootMs - ageMs),
            mock: fix.mock
        )
    }

    private func captureBlocker(at reading: OfflineBootReading?) -> OfflineCaptureRefusal? {
        guard buildAllows, signer != nil, let ticket else { return .notEnabled }
        guard let reading, let elapsed = reading.elapsedMs(since: ticket.received), elapsed >= 0,
              elapsed <= limits.maxCaptureAgeMs
        else { return .connectOnce }
        return nil
    }

    /// §3.4, UX only (the server decides): no clock-out without a clock-in,
    /// no second open break, nothing saved twice.
    private func checkDependencies(_ request: OfflinePunchRequest, context: OfflineAttendanceContext) throws {
        let shift = request.shiftId
        let savedClockIn = queue.pending(.clockIn, shiftId: shift) != nil
        let savedClockOut = queue.pending(.clockOut, shiftId: shift) != nil
        let clockedIn = context.activeShiftId == shift || savedClockIn
        switch request.type {
        case .checkIn:
            if queue.pending(.checkIn, shiftId: shift) != nil { throw OfflineCaptureRefusal.alreadySaved }
        case .clockIn:
            if context.activeShiftId == shift { throw OfflineCaptureRefusal.alreadyClockedIn }
            if context.activeShiftId != nil { throw OfflineCaptureRefusal.anotherShiftOpen }
            if savedClockIn { throw OfflineCaptureRefusal.alreadySaved }
            if let other = queue.pending.last(where: { $0.type == .clockIn && $0.shiftId != shift }),
               queue.pending(.clockOut, shiftId: other.shiftId) == nil {
                throw OfflineCaptureRefusal.anotherShiftOpen
            }
        case .clockOut:
            if savedClockOut { throw OfflineCaptureRefusal.alreadySaved }
            if !clockedIn { throw OfflineCaptureRefusal.notClockedIn }
        case .breakStart:
            if !clockedIn || savedClockOut { throw OfflineCaptureRefusal.notClockedIn }
            if breakOpen(shift, context: context) { throw OfflineCaptureRefusal.breakAlreadyOpen }
        case .breakEnd:
            if !breakOpen(shift, context: context) { throw OfflineCaptureRefusal.noOpenBreak }
        }
    }

    private func breakOpen(_ shift: String, context: OfflineAttendanceContext) -> Bool {
        let saved = queue.pending.filter { $0.shiftId == shift }
        let starts = saved.filter { $0.type == .breakStart }.count
        let ends = saved.filter { $0.type == .breakEnd }.count
        let serverOpen = context.activeShiftId == shift && context.activeOnBreak ? 1 : 0
        return serverOpen + starts > ends
    }
}

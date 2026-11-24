import Combine
import Foundation
import SwiftUI

/// What the store needs from the session: the identity epoch, so a response
/// that lands after a sign-out / account switch is dropped. `SessionCoordinator`
/// already provides exactly this; tests use a tiny fake.
@MainActor
protocol StaffSessionFence: AnyObject {
    var epoch: UInt64 { get }
    func isCurrent(_ candidate: UInt64) -> Bool
}

extension SessionCoordinator: StaffSessionFence {}

/// A failed attendance action: the user-facing text plus the server `code`.
struct StaffAttendanceFailure: Equatable {
    let message: String
    let code: String?
}

enum StaffOfferAction: String, Equatable {
    case accept
    case decline
}

enum StaffRespondOutcome: Equatable {
    case accepted
    case declined
    /// The server refused; shown as an error toast.
    case failed(String)
    /// Timeout / connection lost / 5xx: the offers were reloaded instead of
    /// resending (accept/decline are not idempotent).
    case uncertain(String)
    /// Busy, cancelled or superseded by an identity change: nothing to show.
    case ignored
}

/// Staff-app state for ONE signed-in identity: the Swift counterpart of the
/// Flutter `OffersProvider` + `AttendanceProvider` (+ the unread count of
/// `NotificationsProvider`). One instance per Staff shell; the shell is keyed
/// to `userId:presentation:epoch`, so nothing here survives an account switch.
///
/// Rules (CLAUDE.md, docs/API_CONTRACT_MAP.md):
/// - Server authoritative: success is shown only after the server answered;
///   nothing is optimistic.
/// - Timers use `attendanceNow` / `offersNow` (server time + monotonic clock),
///   never the device clock.
/// - Clock-in, clock-out, accept and decline are never resent automatically.
///   On an uncertain outcome the state is RE-FETCHED before the person may retry.
@MainActor
final class StaffStore: ObservableObject {
    let repository: StaffRepository
    let photos: StaffPhotoCache
    private let fence: StaffSessionFence
    private let monotonic: () -> UInt64

    // MARK: Offers
    @Published private(set) var offers: [StaffOfferSummary] = []
    @Published private(set) var offersLoading = true
    @Published private(set) var offersError: String?
    @Published private(set) var busyOfferId: String?
    @Published private(set) var busyAction: StaffOfferAction?
    @Published private(set) var offersClock = StaffServerClock()
    /// One `/offers/mine` walk at a time; a reload asked for meanwhile is
    /// queued (never dropped), see `loadOffers`.
    private let offersFlight = SingleFlight()
    // Merged flags of every caller waiting for the next offers load.
    private var pendingLoud = false
    private var pendingForeground = false
    private var pendingFull = false

    // MARK: Attendance
    @Published private(set) var active: StaffAttendanceSummary?
    @Published private(set) var history: [StaffAttendanceSummary] = []
    @Published private(set) var activeLoading = true
    @Published private(set) var historyLoading = false
    @Published private(set) var activeError: String?
    @Published private(set) var historyError: String?
    @Published private(set) var clockInEarlyMinutes: Int?
    @Published private(set) var locationEvidence: StaffLocationEvidenceLimits?
    /// The server's Check In state per shift id. Wins over the offer's fields.
    @Published private(set) var checkIns: [String: StaffCheckInState] = [:]
    @Published private(set) var attendanceBusy = false
    @Published private(set) var attendanceError: StaffAttendanceFailure?
    @Published private(set) var attendanceClock = StaffServerClock()

    // MARK: Notifications
    @Published private(set) var unreadCount = 0

    // MARK: Offline (M4 Lane B; off everywhere, see StaffOfflineAttendance)
    /// Saved-on-this-phone actions and the offline gate for this identity.
    /// nil in tests that do not need it; the live gate is always shut today.
    let offline: StaffOfflineAttendance?
    private let offlineSync: OfflineSyncEngine?
    private var offlineForwarding: AnyCancellable?
    private var offlineSyncing = false
    @Published private(set) var sendingSaved = false

    /// The error of the last read of each kind (nil after a success), for
    /// the poller's backoff / `Retry-After`. The data itself stays on screen.
    private(set) var lastOffersFailure: Error?
    private(set) var lastActiveFailure: Error?
    private(set) var lastHistoryFailure: Error?
    private(set) var lastUnreadFailure: Error?

    /// Set by the shell from the scene phase; automatic polling only runs
    /// while the app is in the foreground.
    var isForeground = true

    /// For screen-local models (Payslips, Inbox) that load their own data
    /// under the same identity fence.
    var sessionFence: StaffSessionFence { fence }

    init(
        repository: StaffRepository,
        fence: StaffSessionFence,
        monotonic: @escaping () -> UInt64 = StaffServerClock.systemMonotonicNanos,
        offline: StaffOfflineAttendance? = nil
    ) {
        self.repository = repository
        self.fence = fence
        self.monotonic = monotonic
        self.photos = StaffPhotoCache { fileId in try await repository.venuePhoto(fileId: fileId) }
        self.offline = offline
        if let offline {
            offlineSync = OfflineSyncEngine(
                queue: offline.queue,
                bootClock: offline.clock,
                onTicket: { [weak offline] raw, serverNow, started in
                    offline?.renewTicket(raw, serverNow: serverNow, fetchStarted: started)
                },
                isOwnerSignedIn: { [weak offline] in offline?.isOwnerSignedIn() ?? false },
                // Bound to the owner where the bearer is read (no await gap).
                send: { [owner = offline.requestOwnerUserId] body in
                    try await repository.syncOffline(body, ownerUserId: owner)
                }
            )
        } else {
            offlineSync = nil
        }
        offlineForwarding = offline?.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    // MARK: - Trusted time

    /// Server time from `/attendance/me/active` (and check-in answers),
    /// advanced by the monotonic clock. nil until the first answer.
    var attendanceNow: Date? { attendanceClock.now(monotonicNanos: monotonic()) }

    /// Server time from the offers' `presentation.serverNow`.
    var offersNow: Date? { offersClock.now(monotonicNanos: monotonic()) }

    /// For list filtering and labels (not timers). Device time is only a
    /// last resort before the server has answered at all.
    var displayNow: Date { attendanceNow ?? offersNow ?? Date() }

    // MARK: - Lifecycle

    /// First load of the identity: every offer (`scope=all`, the Calendar
    /// still shows confirmed shifts of past months), attendance, history and
    /// the unread count.
    func start() async {
        async let offersLoad: Void = loadOffers(full: true)
        async let activeLoad: Void = refreshActive()
        async let historyLoad: Void = loadHistory()
        async let unreadLoad: Void = refreshUnreadCount()
        _ = await (offersLoad, activeLoad, historyLoad, unreadLoad)
    }

    /// Silent reconcile (Flutter `AppShell._reconcileOnce`): the current
    /// offers (`scope=current`, merged) and the active attendance. The timer
    /// passes `background: true` (does not slide the idle window), app
    /// resume false. Joins an offers load already in flight.
    func reconcile(background: Bool) async {
        async let offersLoad: Void = loadOffers(silent: true, background: background, joinInFlight: true)
        async let activeLoad: Void = refreshActive(silent: true, background: background)
        _ = await (offersLoad, activeLoad)
    }

    /// The 30 s reconcile poll (`PollScheduler` task): reconcile, plus the
    /// unread count on every second run (the bell's shared 60 s policy, as on
    /// Flutter and the web). Every store keeps its last good data; the first
    /// failure of THIS run is rethrown so the scheduler backs off (or honours
    /// `Retry-After`).
    func pollReconcile(background: Bool) async throws {
        let readsUnread = reconcilePolls % 2 == 0
        reconcilePolls += 1
        if readsUnread {
            async let reconcileRun: Void = reconcile(background: background)
            async let unreadRun: Void = refreshUnreadCount(background: background)
            _ = await (reconcileRun, unreadRun)
        } else {
            await reconcile(background: background)
        }
        if let failure = lastOffersFailure ?? lastActiveFailure ?? (readsUnread ? lastUnreadFailure : nil) { throw failure }
    }

    /// Runs of `pollReconcile` so far (the unread count is read on the even ones).
    private var reconcilePolls = 0

    /// Pull-to-refresh on a screen that already shows data: every offer
    /// again (`scope=all`, replacing the list), attendance and history.
    func refreshAll() async {
        async let offersLoad: Void = loadOffers(silent: true, full: true)
        async let activeLoad: Void = refreshActive(silent: true)
        async let historyLoad: Void = loadHistory(silent: true)
        _ = await (offersLoad, activeLoad, historyLoad)
    }

    /// Realtime events (Phase C1b): re-read only what the event names.
    /// Automatic traffic, so background-flagged; queued behind a read
    /// already in flight (that read may predate the change).
    func applyRealtime(_ refreshes: Set<StaffRealtimeRefresh>) async {
        if refreshes.contains(.offers) { await loadOffers(silent: true, background: true) }
        if refreshes.contains(.attendance) { await refreshActive(silent: true, background: true) }
        if refreshes.contains(.history) { await loadHistory(silent: true, background: true) }
        if refreshes.contains(.unreadCount) { await refreshUnreadCount(background: true) }
    }

    // MARK: - Offers

    /// Loads `/offers/mine` with keyset paging.
    ///
    /// - `full` (first load, pull-to-refresh): `scope=all`, every page,
    ///   replacing the list.
    /// - otherwise (poll, resume, after the person's own action, an event):
    ///   `scope=current`, every page, merged by id into the list (older rows
    ///   outside the current window are kept as last read).
    ///
    /// At most one walk at a time. A call while one is in flight is QUEUED
    /// (one follow-up after it, shared by every caller queued meanwhile, and
    /// awaited by all of them), never dropped, so a reload after the
    /// person's own accept/check-in reads state from after that action.
    /// `joinInFlight` (automatic refreshes only: timer, resume) shares the
    /// walk in flight instead. `background` marks a timer/event read.
    func loadOffers(silent: Bool = false, background: Bool = false, full: Bool = false, joinInFlight: Bool = false) async {
        if joinInFlight, offersFlight.isRunning {
            await offersFlight.join { [weak self] in
                guard let self else { return }
                await self.runOffersLoad()
            }
            return
        }
        pendingLoud = pendingLoud || !silent
        pendingForeground = pendingForeground || !background
        pendingFull = pendingFull || full
        await offersFlight.run { [weak self] in
            guard let self else { return }
            await self.runOffersLoad()
        }
    }

    private func runOffersLoad() async {
        let silent = !pendingLoud
        let background = !pendingForeground
        let full = pendingFull
        pendingLoud = false
        pendingForeground = false
        pendingFull = false
        if !silent { offersLoading = true }
        let epoch = fence.epoch
        do {
            let loaded = try await repository.myOffers(scope: full ? .all : .current, background: background)
            if fence.isCurrent(epoch) {
                let merged = full ? loaded : Self.mergeOffers(offers, loaded)
                ShiftVisualStyle.registerGroup(merged.map(\.shiftId))
                offers = merged
                if let serverNow = loaded.lazy.compactMap({ $0.presentation?.serverNow }).first {
                    offersClock.anchor(serverNow, monotonicNanos: monotonic())
                }
                offersError = nil
                lastOffersFailure = nil
            }
        } catch {
            if fence.isCurrent(epoch), !Self.ignorable(error) {
                // A failed reload keeps the last good list on screen.
                offersError = "Could not load offers. Please try again."
                lastOffersFailure = error
            }
        }
        offersLoading = false
    }

    /// Fresh rows replace the same ids; rows not in `fresh` are kept. Server
    /// order (`sent_at DESC, id DESC`).
    nonisolated static func mergeOffers(_ previous: [StaffOfferSummary], _ fresh: [StaffOfferSummary]) -> [StaffOfferSummary] {
        var byId: [String: StaffOfferSummary] = [:]
        for offer in previous { byId[offer.id] = offer }
        for offer in fresh { byId[offer.id] = offer }
        return byId.values.sorted { a, b in
            a.sentAt != b.sentAt ? a.sentAt > b.sentAt : a.id > b.id
        }
    }

    /// Accept / Decline. Never retried automatically; an uncertain result
    /// reloads the offers so the person sees the server's truth first.
    @discardableResult
    func respond(to offer: StaffOfferSummary, action: StaffOfferAction) async -> StaffRespondOutcome {
        guard busyOfferId == nil else { return .ignored }
        busyOfferId = offer.id
        busyAction = action
        defer {
            busyOfferId = nil
            busyAction = nil
        }
        let epoch = fence.epoch
        do {
            switch action {
            case .accept: try await repository.accept(offerId: offer.id)
            case .decline: try await repository.decline(offerId: offer.id)
            }
            guard fence.isCurrent(epoch) else { return .ignored }
            await loadOffers(silent: true)
            return action == .accept ? .accepted : .declined
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return .ignored }
            if let apiError = error as? APIError, apiError.isUncertainOutcome {
                await loadOffers(silent: true)
                return .uncertain(StaffAttendanceMessages.uncertainOffer)
            }
            return .failed(userMessage(for: error))
        }
    }

    func offer(id: String) -> StaffOfferSummary? { offers.first { $0.id == id } }
    func offer(forShift shiftId: String) -> StaffOfferSummary? { offers.first { $0.shiftId == shiftId } }

    // MARK: - Attendance reads

    func refreshActive(silent: Bool = false, background: Bool = false) async {
        if !silent { activeLoading = true }
        let epoch = fence.epoch
        defer { activeLoading = false }
        // Boot clock before the request: an offline ticket whose fetch took
        // over 10 s is thrown away (DESIGN §4.2).
        let fetchStarted = offline?.clock.reading()
        do {
            let response = try await repository.activeAttendance(background: background)
            guard fence.isCurrent(epoch) else { return }
            active = response.attendance
            clockInEarlyMinutes = response.clockInEarlyMinutes
            if let limits = response.locationEvidence { locationEvidence = limits }
            attendanceClock.anchor(response.serverNow, monotonicNanos: monotonic())
            offline?.updateFromServer(
                enabled: response.offline?.enabled,
                ticket: response.offlineTicket,
                serverNow: response.serverNow,
                fetchStarted: fetchStarted
            )
            activeError = nil
            lastActiveFailure = nil
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return }
            // A failed restore keeps `active` as-is (never clears a possibly
            // still valid clock-in on a transient error).
            activeError = "Could not check attendance. Please try again."
            lastActiveFailure = error
            return
        }
        activeLoading = false
        // A successful read (30 s reconcile, resume, refresh) is the moment to
        // send anything saved on this phone (DESIGN §3.5).
        if offline?.queue.hasPending == true {
            await syncOffline(trigger: .automatic)
        }
    }

    /// Every page of `/attendance/me/history` (keyset `limit` + `cursor`).
    /// A failure keeps the rows already on screen.
    func loadHistory(silent: Bool = false, background: Bool = false) async {
        if !silent { historyLoading = true }
        let epoch = fence.epoch
        defer { historyLoading = false }
        do {
            let rows = try await repository.attendanceHistory(background: background)
            guard fence.isCurrent(epoch) else { return }
            history = rows
            historyError = nil
            lastHistoryFailure = nil
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return }
            historyError = "Could not check completed shifts. Please try again."
            lastHistoryFailure = error
        }
    }

    /// Silent: a failure keeps whatever was known (the offer's fields apply).
    @discardableResult
    func loadCheckIn(shiftId: String) async -> StaffCheckInState? {
        let epoch = fence.epoch
        do {
            let state = try await repository.checkInState(shiftId: shiftId)
            guard fence.isCurrent(epoch) else { return nil }
            checkIns[shiftId] = state
            attendanceClock.anchor(state.serverNow, monotonicNanos: monotonic())
            return state
        } catch {
            return nil
        }
    }

    func loadTeam(shiftId: String, background: Bool = false) async throws -> [StaffTeamMember] {
        try await repository.team(shiftId: shiftId, background: background)
    }

    // MARK: - Check In / Clock In / Clock Out

    /// Check In: arrival evidence, never worked time. Idempotent server-side
    /// (repeat-safe transport retry). Location only where the venue enforces it.
    func checkIn(shiftId: String, location: StaffLocationFix?) async -> Bool {
        guard !attendanceBusy else { return false }
        attendanceError = nil
        if rejectFix(location) { return false }
        attendanceBusy = true
        defer { attendanceBusy = false }
        let epoch = fence.epoch
        guard await savedActionsAllowOnline({ key in
            OfflinePunchRequest(type: .checkIn, shiftId: shiftId, idempotencyKey: key, qrToken: nil, location: location)
        }) else { return false }
        let key = offlineKey()
        do {
            let state = try await repository.checkIn(StaffCheckInBody(shiftId: shiftId, location: location), idempotencyKey: key)
            guard fence.isCurrent(epoch) else { return false }
            checkIns[shiftId] = state
            attendanceClock.anchor(state.serverNow, monotonicNanos: monotonic())
            return true
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return false }
            let saved = key.map { OfflinePunchRequest(type: .checkIn, shiftId: shiftId, idempotencyKey: $0, qrToken: nil, location: location) }
            if saveAfterFailure(error, saved) { return false }
            if let apiError = error as? APIError, apiError.isUncertainOutcome {
                if let state = await loadCheckIn(shiftId: shiftId), state.checkedIn { return true }
                attendanceError = StaffAttendanceFailure(message: StaffAttendanceMessages.uncertainCheckIn, code: nil)
                return false
            }
            fail(error)
            return false
        }
    }

    /// Clock In with the scanned QR (verbatim) and, where enforced, a fix.
    /// No optimistic state. Never resent: an uncertain result reloads
    /// `/me/active` and the check-in state, and reports success only if the
    /// server now shows the clock-in.
    func clockIn(shiftId: String, qrToken: String, location: StaffLocationFix?) async -> Bool {
        guard !attendanceBusy else { return false }
        attendanceError = nil
        if rejectFix(location) { return false }
        attendanceBusy = true
        defer { attendanceBusy = false }
        let epoch = fence.epoch
        guard await savedActionsAllowOnline({ key in
            OfflinePunchRequest(type: .clockIn, shiftId: shiftId, idempotencyKey: key, qrToken: qrToken, location: location)
        }) else { return false }
        let key = offlineKey()
        do {
            let summary = try await repository.clockIn(StaffClockInBody(shiftId: shiftId, qrToken: qrToken, location: location), idempotencyKey: key)
            guard fence.isCurrent(epoch) else { return false }
            active = summary
            await refreshActive(silent: true)
            return true
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return false }
            let saved = key.map { OfflinePunchRequest(type: .clockIn, shiftId: shiftId, idempotencyKey: $0, qrToken: qrToken, location: location) }
            if saveAfterFailure(error, saved) { return false }
            if let apiError = error as? APIError, apiError.isUncertainOutcome {
                await refreshActive(silent: true)
                await loadCheckIn(shiftId: shiftId)
                if activeError == nil, let active, active.isOpen, active.shiftId == shiftId { return true }
                attendanceError = StaffAttendanceFailure(message: StaffAttendanceMessages.uncertainClockIn, code: nil)
                return false
            }
            fail(error)
            if attendanceError?.code == "CHECK_IN_REQUIRED" {
                // The booking needs Check In first: reload so the screen offers it.
                await loadCheckIn(shiftId: shiftId)
            }
            return false
        }
    }

    func clockOut(qrToken: String, location: StaffLocationFix?) async -> Bool {
        guard !attendanceBusy else { return false }
        attendanceError = nil
        if rejectFix(location) { return false }
        attendanceBusy = true
        defer { attendanceBusy = false }
        let epoch = fence.epoch
        let openShiftId = active?.shiftId
        guard await savedActionsAllowOnline({ key in
            openShiftId.map { shift in OfflinePunchRequest(type: .clockOut, shiftId: shift, idempotencyKey: key, qrToken: qrToken, location: location) }
        }) else { return false }
        let previous = active
        let key = previous == nil ? nil : offlineKey()
        do {
            let completed = try await repository.clockOut(StaffClockOutBody(qrToken: qrToken, location: location), idempotencyKey: key)
            guard fence.isCurrent(epoch) else { return false }
            history = [completed] + history.filter { $0.id != completed.id }
            active = nil
            await loadHistory(silent: true)
            return true
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return false }
            var saved: OfflinePunchRequest?
            if let key, let previous {
                saved = OfflinePunchRequest(type: .clockOut, shiftId: previous.shiftId, idempotencyKey: key, qrToken: qrToken, location: location)
            }
            if saveAfterFailure(error, saved) { return false }
            if let apiError = error as? APIError, apiError.isUncertainOutcome {
                await refreshActive(silent: true)
                await loadHistory(silent: true)
                if activeError == nil, previous != nil, active?.isOpen != true { return true }
                attendanceError = StaffAttendanceFailure(message: StaffAttendanceMessages.uncertainClockOut, code: nil)
                return false
            }
            fail(error)
            return false
        }
    }

    func clearAttendanceError() {
        attendanceError = nil
    }

    // MARK: - Offline (M4 Lane B: DESIGN §3; off everywhere today)

    /// A fresh idempotency key when this tap could be saved offline, else nil
    /// (no `Idempotency-Key` header: exactly today's request).
    private func offlineKey() -> String? {
        guard let offline, offline.canCapture else { return nil }
        return offline.newIdempotencyKey()
    }

    private var offlineContext: OfflineAttendanceContext {
        OfflineAttendanceContext(
            activeShiftId: liveAttendance?.shiftId,
            activeOnBreak: liveAttendance?.status == StaffStatus.onBreak
        )
    }

    /// The online request failed before any answer (or timed out after it was
    /// sent, an uncertain outcome): save it on the phone with the SAME key, so
    /// the server applies it at most once (DESIGN §3.1, D17). true = handled:
    /// saved (nothing optimistic is shown; the screen says "saved on this
    /// phone, not yet confirmed") or the refusal's words are shown. Any other
    /// failure, or a shut gate, keeps today's handling.
    private func saveAfterFailure(_ error: Error, _ request: OfflinePunchRequest?) -> Bool {
        // A real HTTP answer (a server or proxy 408 included) is never saved.
        guard let request, let offline, let apiError = error as? APIError, apiError.isNoResponse else { return false }
        do {
            try offline.capture(request, context: offlineContext)
            attendanceError = nil
            return true
        } catch let refusal as OfflineCaptureRefusal where refusal != .notEnabled {
            attendanceError = StaffAttendanceFailure(message: refusal.message, code: nil)
            return true
        } catch {
            return false
        }
    }

    /// With saved actions waiting, a new punch sends them first. It is held
    /// back ONLY when that attempt got no HTTP answer at all (offline, DNS,
    /// TLS, client timeout): then it is saved behind them (gate open) or
    /// refused (gate shut), since sending it would overtake them. On ANY
    /// answer (4xx, 429, 5xx, an unknown outcome, an undecodable 200), or a
    /// run already in flight, it goes online and the server decides: out of
    /// order can only ever pay less (D3), and a server problem must never
    /// lock a person out of clocking. true = go online.
    private func savedActionsAllowOnline(_ makeRequest: (String) -> OfflinePunchRequest?) async -> Bool {
        guard let offline, offline.queue.hasPending else { return true }
        let result = await syncOffline(trigger: .manual)
        guard offline.queue.hasPending else { return true }
        let noAnswer = result != .deferred && (offlineSync?.lastRunEndedWithoutAnswer ?? false)
        guard noAnswer else { return true }
        guard offline.canCapture, let request = makeRequest(offline.newIdempotencyKey()) else {
            attendanceError = StaffAttendanceFailure(message: StaffOfflinePresentation.sendSavedFirst, code: nil)
            return false
        }
        do {
            try offline.capture(request, context: offlineContext)
            attendanceError = nil
        } catch let refusal as OfflineCaptureRefusal {
            attendanceError = StaffAttendanceFailure(message: refusal.message, code: nil)
        } catch {
            attendanceError = StaffAttendanceFailure(message: OfflineCaptureRefusal.notSaved.message, code: nil)
        }
        return false
    }

    /// Sends what is saved on this phone (DESIGN §3.5). Triggered by every
    /// successful `/attendance/me/active` read (the 30 s reconcile, resume,
    /// pull-to-refresh) and by "Send now". After anything was received, the
    /// server's state is re-read: the screen only ever shows server truth.
    @discardableResult
    func syncOffline(trigger: OfflineSyncEngine.Trigger) async -> OfflineSyncEngine.RunResult {
        guard let offlineSync, !offlineSyncing else { return .deferred }
        offlineSyncing = true
        sendingSaved = trigger == .manual
        let epoch = fence.epoch
        let result = await offlineSync.run(trigger: trigger, trustedNow: attendanceNow ?? offline?.ticketAnchoredNow())
        sendingSaved = false
        guard fence.isCurrent(epoch) else {
            offlineSyncing = false
            return result
        }
        if case .sent(let received, _) = result, received > 0 {
            // Still flagged as syncing, so this re-read does not start a run.
            await refreshActive(silent: true)
            await loadHistory(silent: true)
            offlineSyncing = false
            await loadOffers(silent: true)
        } else {
            offlineSyncing = false
        }
        return result
    }

    /// Clock-out for a shift whose clock-in is still only on this phone. What
    /// is saved is sent first: if the clock-in reaches the server this is an
    /// ordinary (online) clock-out; otherwise the clock-out is saved as well.
    func clockOutSavedShift(shiftId: String, qrToken: String, location: StaffLocationFix?) async -> Bool {
        guard !attendanceBusy, let offline else { return false }
        attendanceError = nil
        if rejectFix(location) { return false }
        await syncOffline(trigger: .manual)
        if liveAttendance?.shiftId == shiftId {
            return await clockOut(qrToken: qrToken, location: location)
        }
        guard offline.queue.pending(.clockIn, shiftId: shiftId) != nil else {
            attendanceError = StaffAttendanceFailure(message: OfflineCaptureRefusal.notClockedIn.message, code: "NOT_CLOCKED_IN")
            return false
        }
        attendanceBusy = true
        defer { attendanceBusy = false }
        do {
            let request = OfflinePunchRequest(type: .clockOut, shiftId: shiftId, idempotencyKey: offline.newIdempotencyKey(), qrToken: qrToken, location: location)
            try offline.capture(request, context: offlineContext)
        } catch let refusal as OfflineCaptureRefusal {
            attendanceError = StaffAttendanceFailure(message: refusal.message, code: nil)
        } catch {
            attendanceError = StaffAttendanceFailure(message: OfflineCaptureRefusal.notSaved.message, code: nil)
        }
        return false
    }

    /// Everything saved on this phone (empty while offline mode is off).
    var savedActions: [OfflineQueuedPunch] { offline?.queue.items ?? [] }

    func savedActions(forShift shiftId: String) -> [OfflineQueuedPunch] {
        offline?.queue.punches(forShift: shiftId) ?? []
    }

    /// Not yet received by the server: logout asks first while > 0 (D18).
    var unsentSavedCount: Int { offline?.queue.unsentCount ?? 0 }

    /// The waiting (unsent) action of `type` for `shiftId`.
    func savedPunch(_ type: OfflinePunchType, shiftId: String) -> OfflineQueuedPunch? {
        offline?.queue.pending(type, shiftId: shiftId)
    }

    /// The shift whose clock-in is saved on this phone (not yet confirmed)
    /// with no saved clock-out, while the server shows no open attendance.
    var savedOpenShiftId: String? {
        guard liveAttendance == nil, let offline,
              let clockIn = offline.queue.pending.last(where: { $0.type == .clockIn })
        else { return nil }
        return offline.queue.pending(.clockOut, shiftId: clockIn.shiftId) == nil ? clockIn.shiftId : nil
    }

    /// The person dismissed a rejected, too-old or undeliverable action.
    func dismissSaved(id: String) {
        offline?.queue.dismiss(id: id)
    }

    /// The stored queue could not be read: it is never discarded (the person
    /// cannot see it); sign-out keeps it on the phone instead.
    var savedQueueUnreadable: Bool { offline?.queue.unreadable ?? false }

    /// D18: the person explicitly discarded everything saved on this phone
    /// (never sent; the manager is not told). false = refused (unreadable).
    @discardableResult
    func discardAllSaved() -> Bool {
        offline?.queue.discardAll() ?? true
    }

    /// The fix fails the server's published limits: explain, send nothing.
    private func rejectFix(_ fix: StaffLocationFix?) -> Bool {
        guard let code = StaffLocationPrecheck.rejection(fix, limits: locationEvidence, now: attendanceNow) else { return false }
        attendanceError = StaffAttendanceFailure(message: StaffAttendanceMessages.staff[code] ?? APIMessages.serverError, code: code)
        return true
    }

    private func fail(_ error: Error) {
        attendanceError = StaffAttendanceFailure(message: StaffAttendanceMessages.forStaff(error), code: (error as? APIError)?.code)
    }

    // MARK: - Derived attendance state

    var liveAttendance: StaffAttendanceSummary? { active?.isOpen == true ? active : nil }

    func checkInState(for offer: StaffOfferSummary) -> StaffCheckInState? { checkIns[offer.shiftId] }

    func checkedInAt(_ offer: StaffOfferSummary) -> Date? {
        StaffCheckInRules.checkedInAt(offer, state: checkIns[offer.shiftId])
    }

    func checkInRequired(_ offer: StaffOfferSummary) -> Bool {
        StaffCheckInRules.checkInRequired(offer, state: checkIns[offer.shiftId])
    }

    /// A Check In saved on this phone counts (the server decides at sync).
    func needsCheckIn(_ offer: StaffOfferSummary) -> Bool {
        StaffCheckInRules.needsCheckIn(offer, state: checkIns[offer.shiftId])
            && savedPunch(.checkIn, shiftId: offer.shiftId) == nil
    }

    func geofenceEnforced(shiftId: String, offer: StaffOfferSummary?) -> Bool? {
        StaffCheckInRules.geofenceEnforced(state: checkIns[shiftId], offer: offer)
    }

    // MARK: - Notifications badge

    func refreshUnreadCount(background: Bool = false) async {
        let epoch = fence.epoch
        do {
            let count = try await repository.unreadCount(background: background)
            guard fence.isCurrent(epoch) else { return }
            unreadCount = count
            lastUnreadFailure = nil
        } catch {
            // Best effort: a failed poll never disrupts the rest of the app
            // (the poller still backs off on it).
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return }
            lastUnreadFailure = error
        }
    }

    func setUnreadCount(_ count: Int) {
        unreadCount = max(0, count)
    }

    // MARK: - Helpers

    static func ignorable(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let apiError = error as? APIError {
            return apiError == .cancelled || apiError == .sessionChanged
        }
        return false
    }
}

/// In-memory venue-photo bytes for ONE identity (the store is rebuilt on an
/// account switch, so bytes authorised for one account are never shown to
/// another). A 404 (no live work at that venue, by design) is remembered as
/// "no photo"; a transient failure is not, so a later view can retry.
@MainActor
final class StaffPhotoCache {
    private enum Outcome {
        case loaded(Data)
        case absent
        case transient
    }

    private var entries: [String: Task<Outcome, Never>] = [:]
    private var order: [String] = []
    private let maxEntries = 40
    private let load: (String) async throws -> Data

    init(load: @escaping (String) async throws -> Data) {
        self.load = load
    }

    func data(for fileId: String) async -> Data? {
        let task: Task<Outcome, Never>
        if let existing = entries[fileId] {
            task = existing
        } else {
            if entries.count >= maxEntries, let oldest = order.first {
                order.removeFirst()
                entries[oldest] = nil
            }
            let loader = load
            task = Task {
                do {
                    let bytes = try await loader(fileId)
                    return bytes.isEmpty ? .absent : .loaded(bytes)
                } catch let error as APIError where error.isTransient || error.isCancellation {
                    return .transient
                } catch {
                    return .absent
                }
            }
            entries[fileId] = task
            order.append(fileId)
        }
        switch await task.value {
        case .loaded(let bytes):
            return bytes
        case .absent:
            return nil
        case .transient:
            entries[fileId] = nil
            order.removeAll { $0 == fileId }
            return nil
        }
    }
}

// MARK: - Navigation

enum StaffTab: String, CaseIterable {
    case home, calendar, history, profile
}

/// Destinations pushed inside a tab's NavigationStack. Screens re-read live
/// data from the store; the offer carried here is only a fallback snapshot.
enum StaffRoute: Hashable {
    case offers
    case confirmed
    case upcoming
    case jobDetail(StaffOfferSummary)
    case clock(StaffOfferSummary?)
    case teams(StaffOfferSummary)
    case inbox
    case payslips
    case document(fileId: String, filename: String?, title: String)
    case security
}

@MainActor
final class StaffNavigator: ObservableObject {
    @Published var selectedTab: String = StaffTab.home.rawValue
    @Published var paths: [String: [StaffRoute]] = [:]

    func push(_ route: StaffRoute) {
        paths[selectedTab, default: []].append(route)
    }

    func select(_ tab: StaffTab) {
        selectedTab = tab.rawValue
    }

    func path(for tab: String) -> Binding<[StaffRoute]> {
        Binding(
            get: { self.paths[tab] ?? [] },
            set: { self.paths[tab] = $0 }
        )
    }

    var isAtRoot: Bool { (paths[selectedTab] ?? []).isEmpty }
}

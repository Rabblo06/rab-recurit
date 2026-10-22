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
    private var offersInFlight = false
    private var offersReloadQueued = false

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

    /// Set by the shell from the scene phase; automatic polling only runs
    /// while the app is in the foreground.
    var isForeground = true

    /// For screen-local models (Payslips, Inbox) that load their own data
    /// under the same identity fence.
    var sessionFence: StaffSessionFence { fence }

    init(
        repository: StaffRepository,
        fence: StaffSessionFence,
        monotonic: @escaping () -> UInt64 = StaffServerClock.systemMonotonicNanos
    ) {
        self.repository = repository
        self.fence = fence
        self.monotonic = monotonic
        self.photos = StaffPhotoCache { fileId in try await repository.venuePhoto(fileId: fileId) }
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

    func start() async {
        async let offersLoad: Void = loadOffers()
        async let activeLoad: Void = refreshActive()
        async let historyLoad: Void = loadHistory()
        async let unreadLoad: Void = refreshUnreadCount()
        _ = await (offersLoad, activeLoad, historyLoad, unreadLoad)
    }

    /// Silent reconcile (Flutter `AppShell._refresh`): the 30 s timer passes
    /// `background: true` (does not slide the idle window), app resume false.
    func reconcile(background: Bool) async {
        async let offersLoad: Void = loadOffers(silent: true, background: background)
        async let activeLoad: Void = refreshActive(silent: true, background: background)
        _ = await (offersLoad, activeLoad)
    }

    /// Pull-to-refresh on a screen that already shows data.
    func refreshAll() async {
        async let offersLoad: Void = loadOffers(silent: true)
        async let activeLoad: Void = refreshActive(silent: true)
        async let historyLoad: Void = loadHistory(silent: true)
        _ = await (offersLoad, activeLoad, historyLoad)
    }

    // MARK: - Offers

    func loadOffers(silent: Bool = false, background: Bool = false) async {
        if offersInFlight {
            // A later reload (e.g. after accept) must not be swallowed by a
            // poll already on the wire with older data.
            offersReloadQueued = true
            return
        }
        offersInFlight = true
        if !silent { offersLoading = true }
        let epoch = fence.epoch
        do {
            let loaded = try await repository.myOffers(background: background)
            if fence.isCurrent(epoch) {
                ShiftVisualStyle.registerGroup(loaded.map(\.shiftId))
                offers = loaded
                if let serverNow = loaded.lazy.compactMap({ $0.presentation?.serverNow }).first {
                    offersClock.anchor(serverNow, monotonicNanos: monotonic())
                }
                offersError = nil
            }
        } catch {
            if fence.isCurrent(epoch), !Self.ignorable(error) {
                // A failed reload keeps the last good list on screen.
                offersError = "Could not load offers. Please try again."
            }
        }
        offersInFlight = false
        offersLoading = false
        if offersReloadQueued, fence.isCurrent(epoch) {
            offersReloadQueued = false
            await loadOffers(silent: true)
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
        do {
            let response = try await repository.activeAttendance(background: background)
            guard fence.isCurrent(epoch) else { return }
            active = response.attendance
            clockInEarlyMinutes = response.clockInEarlyMinutes
            if let limits = response.locationEvidence { locationEvidence = limits }
            attendanceClock.anchor(response.serverNow, monotonicNanos: monotonic())
            activeError = nil
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return }
            // A failed restore keeps `active` as-is (never clears a possibly
            // still valid clock-in on a transient error).
            activeError = "Could not check attendance. Please try again."
        }
    }

    func loadHistory(silent: Bool = false) async {
        if !silent { historyLoading = true }
        let epoch = fence.epoch
        defer { historyLoading = false }
        do {
            let rows = try await repository.attendanceHistory()
            guard fence.isCurrent(epoch) else { return }
            history = rows
            historyError = nil
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return }
            historyError = "Could not check completed shifts. Please try again."
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

    func loadTeam(shiftId: String) async throws -> [StaffTeamMember] {
        try await repository.team(shiftId: shiftId)
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
        do {
            let state = try await repository.checkIn(StaffCheckInBody(shiftId: shiftId, location: location))
            guard fence.isCurrent(epoch) else { return false }
            checkIns[shiftId] = state
            attendanceClock.anchor(state.serverNow, monotonicNanos: monotonic())
            return true
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return false }
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
        do {
            let summary = try await repository.clockIn(StaffClockInBody(shiftId: shiftId, qrToken: qrToken, location: location))
            guard fence.isCurrent(epoch) else { return false }
            active = summary
            await refreshActive(silent: true)
            return true
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return false }
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
        let previous = active
        do {
            let completed = try await repository.clockOut(StaffClockOutBody(qrToken: qrToken, location: location))
            guard fence.isCurrent(epoch) else { return false }
            history = [completed] + history.filter { $0.id != completed.id }
            active = nil
            await loadHistory(silent: true)
            return true
        } catch {
            guard fence.isCurrent(epoch), !Self.ignorable(error) else { return false }
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

    func needsCheckIn(_ offer: StaffOfferSummary) -> Bool {
        StaffCheckInRules.needsCheckIn(offer, state: checkIns[offer.shiftId])
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
        } catch {
            // Best effort: a failed poll never disrupts the rest of the app.
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

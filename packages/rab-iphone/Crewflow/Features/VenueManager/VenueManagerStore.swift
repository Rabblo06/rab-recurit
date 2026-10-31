import Foundation
import SwiftUI

/// Shared Venue Manager state for one signed-in identity (Flutter
/// `VenueManagerProvider`). The shell creates ONE per identity (it is
/// rebuilt on every sign-in / account switch), so nothing leaks between
/// people. Every list is server-scoped to this Venue Manager; the filters
/// here are presentation only, never authorisation.
@MainActor
final class VenueManagerStore: ObservableObject {
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published private(set) var updatedAt: Date?
    @Published private(set) var capabilities: Capabilities = .none
    @Published private(set) var events: [VenueEvent] = []
    @Published private(set) var offers: [VMOffer] = []
    /// Sent Shifts "All" view (never contains expired requests).
    @Published private(set) var sentShifts: [SentShift] = []
    /// Server tab counts plus `submitted` (distinct requests ever submitted).
    @Published private(set) var sentCounts: [String: Int] = [:]
    @Published private(set) var venues: [VenueSummary] = []
    @Published private(set) var jobRoles: [JobRoleSummary] = []
    @Published private(set) var userCount: Int?
    @Published private(set) var directoryError: String?
    @Published private(set) var currentReportCount: Int?
    @Published private(set) var historyReportCount: Int?
    /// A refresh failed while data is on screen: the data stays and a
    /// non-blocking "couldn't refresh" notice shows (Phase C1 policy).
    @Published private(set) var refreshFailed = false

    /// The Sent Shifts tab on screen (`all` or another server view). Its rows
    /// are re-read by every full refresh and by the Sent Shifts poll.
    @Published private(set) var sentView = "all"
    /// Rows of the non-All tabs that have been opened (All is `sentShifts`).
    @Published private(set) var sentViewRows: [String: [SentShift]] = [:]
    /// Tabs whose first load failed (nothing to show for them yet).
    @Published private(set) var sentViewErrors: Set<String> = []

    let repository: VenueManagerRepository
    let userId: String
    private var generation = 0
    private let refreshFlight = SingleFlight()
    private var pendingLoud = false
    /// True when any caller of the queued refresh is the person acting (not background).
    private var pendingForeground = false

    init(repository: VenueManagerRepository, userId: String) {
        self.repository = repository
        self.userId = userId
    }

    /// Display hint only; the server enforces every route.
    func allows(_ flag: PermissionFlag) -> Bool { capabilities.allows(flag) }

    var sentSubmitted: Int? { sentCounts["submitted"] }

    /// A tab's rows, or nil while that tab has never loaded.
    func sentRows(_ view: String) -> [SentShift]? {
        view == "all" ? sentShifts : sentViewRows[view]
    }

    /// The FULL refresh (capabilities, every shift/venue/role/offer page,
    /// the Sent Shifts tab on screen with its counts, directory and report
    /// totals): first load, app resume, pull-to-refresh and right after the
    /// Venue Manager's own mutations. Never timer-driven (the Sent Shifts
    /// poll reads one page instead, `pollSentView`).
    ///
    /// One at a time: a call while one is in flight is QUEUED (one follow-up
    /// after it, shared by everyone queued meanwhile), never dropped and
    /// never overlapping, so a refresh after the person's own change always
    /// reads state from after that change.
    ///
    /// Failure: with data already on screen the lists are KEPT and
    /// `refreshFailed` shows a non-blocking notice; only a load with nothing
    /// to show yet, or a permission refusal (403 / missing schedule access),
    /// shows the error page — records are never kept after the scope changed.
    ///
    /// - Parameters:
    ///   - silent: keep the current content on screen (resume, after a change).
    ///   - background: `X-Crewflow-Background: 1`. Nothing timer-driven calls
    ///     the full refresh any more; kept for callers that need it.
    func refresh(silent: Bool = false, background: Bool = false) async {
        pendingLoud = pendingLoud || !silent
        pendingForeground = pendingForeground || !background
        await refreshFlight.run { [weak self] in
            guard let self else { return }
            await self.runRefresh()
        }
    }

    /// Reads the merged flags of every caller this run serves: loud if any was loud, foreground if any was the person.
    private func runRefresh() async {
        let silent = !pendingLoud
        pendingLoud = false
        let background = !pendingForeground
        pendingForeground = false
        generation += 1
        let stamp = generation
        if !silent { loading = true }
        if updatedAt == nil { error = nil }
        directoryError = nil
        let options: RequestOptions? = background ? .backgroundPoll : nil
        let repository = self.repository
        let view = sentView
        do {
            let caps = try await repository.capabilities(options: options)
            guard caps.allows(.scheduleView), caps.allows(.venueView) else { throw VenueManagerError.scheduleAccessDenied }
            async let shiftsLoad = repository.shifts(options: options)
            async let venuesLoad = repository.venues(options: options)
            async let rolesLoad = repository.jobRoles(options: options)
            async let offersLoad = repository.offers(options: options)
            // `counts` come with the first page; no separate count probe.
            async let sentLoad = repository.sentShiftsWithCounts(view: "all", options: options)
            let (shifts, venues, roles, offers, sent) = try await (shiftsLoad, venuesLoad, rolesLoad, offersLoad, sentLoad)
            var viewRows: [SentShift]?
            if view != "all" {
                viewRows = try await repository.sentShifts(view: view, options: options)
            }
            guard stamp == generation else { return }

            let venueNames = Dictionary(venues.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
            let roleNames = Dictionary(roles.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
            let built = shifts
                .map { VenueEvent(shift: $0, role: roleNames[$0.jobRoleId] ?? "Shift", venue: venueNames[$0.venueId] ?? "Venue unavailable") }
                .sorted { $0.start < $1.start }
            ShiftVisualStyle.registerGroup(built.map(\.id))

            capabilities = caps
            self.venues = venues
            jobRoles = roles
            events = built
            self.offers = offers
            sentShifts = sent.rows
            sentCounts = sent.counts
            // Other tabs re-load when opened again; the one on screen is
            // fresh (a tab selected while this refresh ran keeps what it
            // loaded itself).
            let selectedMeanwhile = sentView == view ? nil : sentViewRows[sentView]
            var rowsByView: [String: [SentShift]] = [:]
            if let viewRows { rowsByView[view] = viewRows }
            if let selectedMeanwhile { rowsByView[sentView] = selectedMeanwhile }
            sentViewRows = rowsByView
            sentViewErrors = []

            userCount = nil
            if caps.allows(.staffView) {
                do {
                    let total = try await repository.directoryTotal(options: options)
                    guard stamp == generation else { return }
                    userCount = total
                } catch {
                    guard stamp == generation else { return }
                    directoryError = vmMessage(error)
                }
            }
            if caps.allows(.reportView) {
                do {
                    async let current = repository.reports(bucket: "current", limit: 1, options: options)
                    async let history = repository.reports(bucket: "history", limit: 1, options: options)
                    let (c, h) = try await (current, history)
                    guard stamp == generation else { return }
                    currentReportCount = c.total
                    historyReportCount = h.total
                } catch {
                    guard stamp == generation else { return }
                    currentReportCount = nil
                    historyReportCount = nil
                }
            }
            error = nil
            refreshFailed = false
            updatedAt = Date()
        } catch {
            guard stamp == generation else { return }
            if Self.ignorable(error) {
                loading = false
                return
            }
            if updatedAt == nil || Self.revokesScope(error) {
                clear(vmMessage(error, fallback: "Unable to load venue data. Please try again."))
            } else {
                refreshFailed = true
            }
        }
        if stamp == generation { loading = false }
    }

    // MARK: Sent Shifts tab + first-page poll

    /// Selects a Sent Shifts tab (a user action: never background). A tab
    /// that has never loaded is read in full; one already loaded re-reads
    /// its first page.
    func selectSentView(_ view: String) async {
        guard sentView != view else { return }
        sentView = view
        if view == "all" { return }
        if sentViewRows[view] != nil {
            try? await pollSentView(background: false)
            return
        }
        let stamp = generation
        do {
            let rows = try await repository.sentShifts(view: view)
            guard stamp == generation else { return }
            sentViewRows[view] = rows
            sentViewErrors.remove(view)
        } catch {
            guard stamp == generation, !Self.ignorable(error) else { return }
            sentViewErrors.insert(view)
        }
    }

    /// Every visit to Sent Shifts opens on All (presentation only).
    func resetSentView() {
        sentView = "all"
    }

    /// The Sent Shifts poll: ONLY the first page of the tab on screen
    /// (`/shifts/sent?view=<tab>&page=1&limit=50`), merged into the rows
    /// already loaded (nothing loaded is discarded) together with the
    /// server's `counts`. Skipped while a full refresh is in flight (no
    /// overlap: that refresh brings fresher data anyway) or before the first
    /// load. Throws on failure, after recording a non-blocking
    /// `refreshFailed` — the rows on screen stay (a 403 clears them).
    func pollSentView(background: Bool) async throws {
        guard !refreshFlight.isRunning, updatedAt != nil else { return }
        let view = sentView
        let stamp = generation
        let page: SentShiftsPage
        do {
            page = try await repository.sentShiftsPage(view: view, options: background ? .backgroundPoll : nil)
        } catch {
            if stamp == generation, !Self.ignorable(error) {
                if Self.revokesScope(error) {
                    clear(vmMessage(error, fallback: "Unable to load venue data. Please try again."))
                } else {
                    refreshFailed = true
                }
            }
            throw error
        }
        guard stamp == generation else { return }
        if view == "all" {
            sentShifts = Self.mergeSentFirstPage(sentShifts, page.data, total: page.total)
        } else if let previous = sentViewRows[view] {
            sentViewRows[view] = Self.mergeSentFirstPage(previous, page.data, total: page.total)
        }
        // A tab that never loaded stays as it is (one page is not the list).
        if !page.counts.isEmpty { sentCounts = page.counts }
        refreshFailed = false
    }

    /// Merges a fresh first page (server order `created_at DESC, id DESC`,
    /// shown as `submittedAt`) into the rows already loaded: the page is
    /// authoritative for everything down to its last row; rows further down
    /// that the page did not reach are kept as last read. A page that holds
    /// the whole list replaces it.
    nonisolated static func mergeSentFirstPage(
        _ previous: [SentShift],
        _ page: [SentShift],
        total: Int?,
        limit: Int = VenueManagerRepository.sentPollLimit
    ) -> [SentShift] {
        if page.count < limit || (total.map { $0 <= page.count } ?? false) { return page }
        guard let last = page.last else { return page }
        let ids = Set(page.map(\.id))
        func below(_ row: SentShift) -> Bool {
            guard let a = row.submittedAt, let b = last.submittedAt else { return false }
            return a < b || (a == b && row.id < last.id)
        }
        return page + previous.filter { !ids.contains($0.id) && below($0) }
    }

    // MARK: Failure handling

    /// Cancelled, or answered for an identity that has since gone: nothing
    /// to show.
    nonisolated static func ignorable(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let apiError = error as? APIError
        return apiError == .cancelled || apiError == .sessionChanged
    }

    /// A permission / scope refusal: sensitive records are never kept after
    /// the scope changed.
    nonisolated static func revokesScope(_ error: Error) -> Bool {
        if (error as? VenueManagerError) == .scheduleAccessDenied { return true }
        if case .forbidden = error as? APIError { return true }
        return false
    }

    private func clear(_ message: String) {
        error = message
        refreshFailed = false
        events = []
        offers = []
        sentShifts = []
        sentCounts = [:]
        sentViewRows = [:]
        sentViewErrors = []
        venues = []
        jobRoles = []
        capabilities = .none
        userCount = nil
        currentReportCount = nil
        historyReportCount = nil
        updatedAt = nil
    }

    // MARK: Presentation filters (never authorisation)

    /// Not ended, not completed / cancelled / draft. `now` is the device
    /// clock (presentation filter only, same as Flutter).
    func upcoming(now: Date = Date()) -> [VenueEvent] {
        events.filter { $0.end > now && !["completed", "cancelled", "draft"].contains($0.status) }
    }

    /// Current/upcoming events with at least one confirmed person, live first.
    func confirmedEvents(now: Date = Date()) -> [VenueEvent] {
        let live: Set<String> = ["confirmed", "fully_filled", "partially_filled", "in_progress"]
        return events
            .filter { $0.end > now && $0.filled > 0 && live.contains($0.status) }
            .sorted { a, b in
                let aLive = a.status == "in_progress" ? 0 : 1
                let bLive = b.status == "in_progress" ? 0 : 1
                return aLive != bLive ? aLive < bLive : a.start < b.start
            }
    }

    func team(_ event: VenueEvent) -> [VMOffer] {
        offers.filter { $0.shiftId == event.id && $0.status == "manager_confirmed" }
    }

    func style(_ event: VenueEvent) -> ShiftVisualStyle { ShiftVisualStyle.forShift(event.id) }

    func venue(_ id: String?) -> VenueSummary? { venues.first { $0.id == id } }

    // MARK: Per-shift loads

    /// The authoritative report for ONE shift; a report for another shift
    /// is refused rather than shown under this shift's header.
    func report(for shiftId: String, background: Bool = false) async throws -> ShiftReportDetail {
        let report = try await repository.report(shiftId, options: background ? .backgroundPoll : nil)
        guard report.shiftId == shiftId else { throw VenueManagerError.reportMismatch }
        return report
    }

    /// Confirmed seats of ONE shift: the report rows with `report.view`,
    /// else the shift's `manager_confirmed` offers (no attendance).
    func roster(for shiftId: String) async throws -> ShiftRoster {
        guard allows(.reportView) else { return ShiftRoster.fromOffers(shiftId: shiftId, offers: offers) }
        return ShiftRoster.fromReport(try await report(for: shiftId))
    }
}

/// Resolves to (value, error) so one failing load never hides another.
func vmSettle<T>(_ operation: () async throws -> T) async -> (T?, Error?) {
    do { return (try await operation(), nil) } catch { return (nil, error) }
}

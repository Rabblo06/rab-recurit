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

    let repository: VenueManagerRepository
    let userId: String
    private var generation = 0

    init(repository: VenueManagerRepository, userId: String) {
        self.repository = repository
        self.userId = userId
    }

    /// Display hint only; the server enforces every route.
    func allows(_ flag: PermissionFlag) -> Bool { capabilities.allows(flag) }

    var sentSubmitted: Int? { sentCounts["submitted"] }

    /// - Parameters:
    ///   - silent: keep the current content on screen (poll, resume).
    ///   - background: automatic poll → `X-Crewflow-Background: 1`, so the
    ///     poll does not keep an idle session alive (tighter than Flutter,
    ///     see BACKEND_DEPENDENCIES B11 / ARCHITECTURE).
    func refresh(silent: Bool = false, background: Bool = false) async {
        generation += 1
        let stamp = generation
        if !silent { loading = true }
        error = nil
        directoryError = nil
        let options: RequestOptions? = background ? .backgroundPoll : nil
        let repository = self.repository
        do {
            let caps = try await repository.capabilities(options: options)
            guard caps.allows(.scheduleView), caps.allows(.venueView) else { throw VenueManagerError.scheduleAccessDenied }
            async let shiftsLoad = repository.shifts(options: options)
            async let venuesLoad = repository.venues(options: options)
            async let rolesLoad = repository.jobRoles(options: options)
            async let offersLoad = repository.offers(options: options)
            async let sentLoad = repository.sentShifts(view: "all", options: options)
            let (shifts, venues, roles, offers, sent) = try await (shiftsLoad, venuesLoad, rolesLoad, offersLoad, sentLoad)
            let counts = try await repository.sentShiftCounts(options: options)
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
            sentShifts = sent
            sentCounts = counts

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
            updatedAt = Date()
        } catch {
            guard stamp == generation else { return }
            if (error as? APIError)?.isCancellation == true || (error as? APIError) == .sessionChanged { return }
            self.error = vmMessage(error, fallback: "Unable to load venue data. Please try again.")
            // Do not retain records after a scope/permission change.
            events = []
            offers = []
            sentShifts = []
            sentCounts = [:]
            venues = []
            jobRoles = []
            capabilities = .none
            userCount = nil
            currentReportCount = nil
            historyReportCount = nil
        }
        if stamp == generation { loading = false }
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

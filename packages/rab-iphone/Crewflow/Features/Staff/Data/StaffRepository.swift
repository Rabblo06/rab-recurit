import Foundation

/// The ONLY place the Staff app's routes live (docs/API_CONTRACT_MAP.md).
/// Transport rules (headers, refresh, generation fencing, retry policy)
/// belong to the shared `APIClient`; this type only names routes, bodies and
/// the per-route retry policy:
///
/// - Reads are repeat-safe (APIClient default for GET).
/// - `POST /attendance/check-in` is idempotent server-side (a repeat answers
///   200 with `alreadyCheckedIn: true`) → `.repeatSafeMutation`.
/// - Clock-in, clock-out, offer accept and decline are NOT repeat-safe →
///   `RetryPolicy.never`. On `APIError.isUncertainOutcome` the caller reloads
///   state; it never resends.
/// - Automatic polling uses `.backgroundPoll` (`X-Crewflow-Background: 1`) so
///   it does not slide the 7-day idle window (B11, flagged in the report).
struct StaffRepository {
    let api: APIClient

    /// Never auto-retried (no Idempotency-Key exists anywhere in the API).
    static let nonRepeatable = RequestOptions(retry: .never)

    private func reads(_ background: Bool) -> RequestOptions? {
        background ? .backgroundPoll : nil
    }

    // MARK: Offers (§3.1)

    /// Page sizes (API contract §1/§3). `current` is bounded server-side
    /// (shifts not yet ended + offers sent in the last 30 days), so walking
    /// it is cheap enough for every poll.
    static let currentOffersPageSize = 50
    static let allOffersPageSize = 200
    static let historyPageSize = 200

    /// `GET /offers/mine?scope=…&limit=…`, every keyset page until
    /// `nextCursor` is null (`sent_at DESC, id DESC`). An older server that
    /// still answers the bare array is read with ONE legacy call (no
    /// parameters, its original default) — see `KeysetPaging`.
    func myOffers(scope: StaffOfferScope, background: Bool = false) async throws -> [StaffOfferSummary] {
        try await KeysetPaging.fetchAll(
            api,
            path: "/offers/mine",
            query: "scope=\(scope.rawValue)",
            limit: scope == .all ? Self.allOffersPageSize : Self.currentOffersPageSize,
            options: reads(background),
            as: StaffOfferSummary.self
        )
    }

    /// 201 `JobOffer`; ignored (Flutter reloads `/offers/mine`).
    func accept(offerId: String) async throws {
        try await api.post("/offers/\(StaffPath.segment(offerId))/accept", options: Self.nonRepeatable)
    }

    /// No body: Flutter sends none and the server's `reason` is optional.
    func decline(offerId: String) async throws {
        try await api.post("/offers/\(StaffPath.segment(offerId))/decline", options: Self.nonRepeatable)
    }

    // MARK: Attendance (§2)

    func activeAttendance(background: Bool = false) async throws -> StaffActiveAttendance {
        try await api.get("/attendance/me/active", options: reads(background), as: StaffActiveAttendance.self)
    }

    /// Newest first, every keyset page (`limit` + `cursor` until `nextCursor`
    /// is null; legacy bare array from an older server). The server does NOT
    /// filter by payroll; the History gate is applied client-side
    /// (`StaffHistoryRules`).
    func attendanceHistory(background: Bool = false) async throws -> [StaffAttendanceSummary] {
        try await KeysetPaging.fetchAll(
            api,
            path: "/attendance/me/history",
            limit: Self.historyPageSize,
            options: reads(background),
            as: StaffAttendanceSummary.self
        )
    }

    /// [TEST-DB] `GET /attendance/me/shift/:shiftId/check-in`.
    func checkInState(shiftId: String) async throws -> StaffCheckInState {
        try await api.get("/attendance/me/shift/\(StaffPath.segment(shiftId))/check-in", as: StaffCheckInState.self)
    }

    /// [TEST-DB] Idempotent: a repeat returns the original state.
    func checkIn(_ body: StaffCheckInBody) async throws -> StaffCheckInState {
        try await api.post("/attendance/check-in", body: body, options: .repeatSafeMutation, as: StaffCheckInState.self)
    }

    /// NOT replay-safe (a repeat is 409). Never auto-retried.
    func clockIn(_ body: StaffClockInBody) async throws -> StaffAttendanceSummary {
        try await api.post("/attendance/clock-in", body: body, options: Self.nonRepeatable, as: StaffAttendanceSummary.self)
    }

    /// NOT replay-safe. Never auto-retried.
    func clockOut(_ body: StaffClockOutBody) async throws -> StaffAttendanceSummary {
        try await api.post("/attendance/clock-out", body: body, options: Self.nonRepeatable, as: StaffAttendanceSummary.self)
    }

    func team(shiftId: String, background: Bool = false) async throws -> [StaffTeamMember] {
        try await api.get("/attendance/me/shift/\(StaffPath.segment(shiftId))/team", options: reads(background), as: [StaffTeamMember].self)
    }

    // MARK: Notifications (§9)

    func notifications() async throws -> [StaffNotification] {
        try await api.get("/notifications", as: [StaffNotification].self)
    }

    func unreadCount(background: Bool = false) async throws -> Int {
        try await api.get("/notifications/unread-count", options: reads(background), as: StaffUnreadCount.self).count
    }

    /// 204. Marking read twice is harmless, but it is a mutation: no auto-retry.
    func markRead(notificationId: String) async throws {
        try await api.post("/notifications/\(StaffPath.segment(notificationId))/read", options: Self.nonRepeatable)
    }

    func markAllRead() async throws {
        try await api.post("/notifications/read-all", options: Self.nonRepeatable)
    }

    // MARK: Payroll (§5)

    /// Pages through `/payroll/me/statements` (Flutter stops at 100: B9).
    /// Stops at `total`, on a short/empty page, or after `maxPages` (a
    /// defensive bound; never an infinite loop on a misbehaving server).
    func statements(pageSize: Int = 100, maxPages: Int = 20) async throws -> [StaffShiftStatement] {
        var all: [StaffShiftStatement] = []
        var page = 1
        while page <= maxPages {
            let result = try await api.get(
                "/payroll/me/statements?page=\(page)&limit=\(pageSize)",
                as: StaffStatementsPage.self
            )
            all.append(contentsOf: result.data)
            if result.data.count < pageSize { break }
            if let total = result.total, all.count >= total { break }
            page += 1
        }
        return all
    }

    func payslips() async throws -> [StaffPayslip] {
        try await api.get("/payroll/me/payslips", as: StaffPayslipsResponse.self).data
    }

    // MARK: Files (§8)

    /// Venue photo bytes (`GET /files/:id`, always streamed, never redirects).
    func venuePhoto(fileId: String) async throws -> Data {
        try await api.getBytes("/files/\(StaffPath.segment(fileId))")
    }

    /// A payroll document (`GET /files/:id/download`): 302 → presigned URL is
    /// followed by the APIClient WITHOUT the bearer.
    func document(fileId: String) async throws -> DownloadedFile {
        try await api.downloadFile("/files/\(StaffPath.segment(fileId))/download")
    }
}

/// `/offers/mine` scope (API contract §3): `current` = offers whose shift has
/// not ended plus offers sent in the last 30 days; `all` = every offer (the
/// explicit history path, e.g. the Calendar's past months).
enum StaffOfferScope: String, Sendable {
    case current
    case all
}

/// Path segment encoding: ids are UUIDs, but anything else is percent-encoded
/// so a value can never add a path segment or a query.
enum StaffPath {
    private static let allowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-_.~")
        return set
    }()

    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

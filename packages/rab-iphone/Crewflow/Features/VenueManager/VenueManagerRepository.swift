import Foundation

/// The ONLY place the Venue Manager routes live (docs/API_CONTRACT_MAP.md
/// §3.2, §4, §8). Mirrors Flutter `VenueManagerProvider`'s API surface.
///
/// - No venue, organisation or workspace selector is ever sent: the server
///   scopes every route to the signed-in Venue Manager (out of scope = 404).
/// - Retry policy: reads are repeat-safe. Mutations default to
///   `RetryPolicy.never`; only routes the contract lists as repeat-safe by
///   server state (finalise, attendance-review, confirm-no-show) pass
///   `.repeatSafeMutation`. On an uncertain outcome callers RELOAD, never
///   resend.
/// - Every seat action returns the authoritative `ShiftReportDetail`.
struct VenueManagerRepository {
    let api: APIClient

    static let allPageLimit = 100
    static let directoryPageLimit = 30
    static let reportPageLimit = 30

    // MARK: Query encoding

    private static let unreserved: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }

    static func query(_ items: [(String, String?)]) -> String {
        items.compactMap { key, value in value.map { "\(key)=\(encode($0))" } }.joined(separator: "&")
    }

    private static func segment(_ id: String) -> String { encode(id) }

    // MARK: Reads

    func capabilities(options: RequestOptions? = nil) async throws -> Capabilities {
        try await api.get("/auth/capabilities", options: options, as: Capabilities.self)
    }

    /// Flutter `all()`: `page=N&limit=100` from page 1. A plain array ends
    /// it; a page envelope is read until `total`; an empty page before
    /// `total` means the list changed underneath (fail, never a short list).
    func all<Item: Decodable>(_ path: String, as type: Item.Type, options: RequestOptions? = nil) async throws -> [Item] {
        var result: [Item] = []
        var page = 1
        while true {
            let separator = path.contains("?") ? "&" : "?"
            let response = try await api.get("\(path)\(separator)page=\(page)&limit=\(Self.allPageLimit)",
                                             options: options, as: VMListOrPage<Item>.self)
            switch response {
            case .list(let items):
                return result + items
            case .page(let items, let total):
                result += items
                if result.count >= total { return result }
                if items.isEmpty { throw VenueManagerError.listChanged }
            }
            page += 1
            if page > 1000 { throw VenueManagerError.listChanged }
        }
    }

    func shifts(options: RequestOptions? = nil) async throws -> [VenueShift] {
        try await all("/shifts", as: VenueShift.self, options: options)
    }

    func shift(_ id: String) async throws -> VenueShift {
        try await api.get("/shifts/\(Self.segment(id))", as: VenueShift.self)
    }

    func venues(options: RequestOptions? = nil) async throws -> [VenueSummary] {
        try await all("/venues", as: VenueSummary.self, options: options)
    }

    func jobRoles(options: RequestOptions? = nil) async throws -> [JobRoleSummary] {
        try await all("/job-roles", as: JobRoleSummary.self, options: options)
    }

    func offers(options: RequestOptions? = nil) async throws -> [VMOffer] {
        try await all("/offers", as: VMOffer.self, options: options)
    }

    /// One Sent Shifts view, filtered and paginated by the server.
    func sentShifts(view: String, options: RequestOptions? = nil) async throws -> [SentShift] {
        try await all("/shifts/sent?view=\(Self.encode(view))", as: SentShift.self, options: options)
    }

    /// Page size of the Sent Shifts poll (first page only, API contract §1).
    static let sentPollLimit = 50

    /// ONE page of a Sent Shifts view with the server's `total` and tab
    /// `counts` (`/shifts/sent?view=<view>&page=<page>&limit=<limit>`).
    func sentShiftsPage(view: String, page: Int = 1, limit: Int = VenueManagerRepository.sentPollLimit,
                        options: RequestOptions? = nil) async throws -> SentShiftsPage {
        try await api.get("/shifts/sent?view=\(Self.encode(view))&page=\(page)&limit=\(limit)", options: options, as: SentShiftsPage.self)
    }

    /// Every page of a Sent Shifts view (limit 100) plus the first page's
    /// `counts`, so a full refresh needs no separate count probe.
    func sentShiftsWithCounts(view: String, options: RequestOptions? = nil) async throws -> (rows: [SentShift], counts: [String: Int]) {
        var rows: [SentShift] = []
        var counts: [String: Int] = [:]
        var page = 1
        while true {
            let response = try await sentShiftsPage(view: view, page: page, limit: Self.allPageLimit, options: options)
            if page == 1 { counts = response.counts }
            rows += response.data
            if rows.count >= response.total { return (rows, counts) }
            if response.data.isEmpty { throw VenueManagerError.listChanged }
            page += 1
            if page > 1000 { throw VenueManagerError.listChanged }
        }
    }

    /// One sent request (works for expired ones too; 404 → no longer available).
    func sentShift(_ id: String) async throws -> SentShift {
        try await api.get("/shifts/sent/\(Self.segment(id))", as: SentShift.self)
    }

    static func directoryPath(query: String, page: Int, status: String?, tag: String?,
                              startAt: Date?, endAt: Date?, excludeShiftId: String?) -> String {
        "/staff/venue-directory?" + Self.query([
            ("q", query),
            ("page", "\(page)"),
            ("limit", "\(directoryPageLimit)"),
            ("status", status),
            ("tag", tag),
            ("startAt", startAt.map(ISO8601.string(from:))),
            ("endAt", endAt.map(ISO8601.string(from:))),
            ("excludeShiftId", excludeShiftId),
        ])
    }

    /// The assigned-staff directory. `startAt`/`endAt` (both or neither) ask
    /// the server for a real per-row `available` flag.
    func directory(query: String, page: Int, status: String? = nil, tag: String? = nil,
                   startAt: Date? = nil, endAt: Date? = nil, excludeShiftId: String? = nil) async throws -> VMListPage<DirectoryUser> {
        assert(tag == nil || tag == "favourite" || tag == "emergency")
        let path = Self.directoryPath(query: query, page: page, status: status, tag: tag,
                                      startAt: startAt, endAt: endAt, excludeShiftId: excludeShiftId)
        return try await api.get(path, as: VMListPage<DirectoryUser>.self)
    }

    func directoryTotal(options: RequestOptions? = nil) async throws -> Int {
        try await api.get("/staff/venue-directory?limit=1", options: options, as: VMListPage<DirectoryUser>.self).total
    }

    /// 404 = no longer assigned to this Venue Manager.
    func staffProfile(_ staffId: String) async throws -> VenueStaffProfile {
        try await api.get("/staff/venue-directory/\(Self.segment(staffId))", as: VenueStaffProfile.self)
    }

    func report(_ shiftId: String, options: RequestOptions? = nil) async throws -> ShiftReportDetail {
        try await api.get("/attendance/report/shift/\(Self.segment(shiftId))", options: options, as: ShiftReportDetail.self)
    }

    /// Reports (`current`) / History (`history`), filtered server-side.
    func reports(bucket: String, page: Int = 1, limit: Int = VenueManagerRepository.reportPageLimit,
                 options: RequestOptions? = nil) async throws -> ReportListPage {
        assert(bucket == "current" || bucket == "history")
        return try await api.get("/attendance/report/shifts?bucket=\(bucket)&page=\(page)&limit=\(limit)",
                                 options: options, as: ReportListPage.self)
    }

    func review(shiftId: String, staffProfileId: String) async throws -> StaffReviewEnvelope {
        try await api.get(seatPath(shiftId, "reviews", staffProfileId), as: StaffReviewEnvelope.self)
    }

    /// Report PDF via `/files/:id/download` (presigned redirect followed
    /// WITHOUT the bearer by the core client). Callers check `isPDF`.
    func downloadDocument(_ fileId: String) async throws -> DownloadedFile {
        try await api.downloadFile("/files/\(Self.segment(fileId))/download")
    }

    /// Inline image bytes (venue photo). Never redirects.
    func imageBytes(_ fileId: String) async throws -> Data {
        try await api.getBytes("/files/\(Self.segment(fileId))")
    }

    // MARK: Mutations

    /// Sends ONLY the tag(s) being changed; returns the server-confirmed state.
    func setTags(_ staffId: String, favourite: Bool? = nil, emergency: Bool? = nil) async throws -> StaffTags {
        assert(favourite != nil || emergency != nil, "setTags needs favourite and/or emergency")
        return try await api.patch("/staff/venue-directory/\(Self.segment(staffId))/tags",
                                   body: StaffTagsBody(favourite: favourite, emergency: emergency),
                                   options: RequestOptions(retry: .never), as: StaffTags.self)
    }

    /// No idempotency key: a resubmit creates ANOTHER shift. Never retried.
    func submitShiftRequest(_ body: SubmitShiftRequestBody) async throws -> CreatedShift {
        try await api.post("/shifts/request", body: body, options: RequestOptions(retry: .never), as: CreatedShift.self)
    }

    /// Repeat-safe by server state (idempotent review).
    func reviewAttendance(shiftId: String, staffProfileId: String) async throws -> ShiftReportDetail {
        try await api.post(seatPath(shiftId, "staff", staffProfileId, "attendance-review"),
                           options: .repeatSafeMutation, as: ShiftReportDetail.self)
    }

    /// Not auto-retried (CAS on `expectedVersion`; reload on an uncertain result).
    func recordAttendance(shiftId: String, staffProfileId: String, body: RecordAttendanceBody) async throws -> ShiftReportDetail {
        try await api.post(seatPath(shiftId, "staff", staffProfileId, "record-attendance"),
                           body: body, options: RequestOptions(retry: .never), as: ShiftReportDetail.self)
    }

    /// Repeat-safe by server state (idempotent confirmation).
    func confirmNoShow(shiftId: String, staffProfileId: String) async throws -> ShiftReportDetail {
        try await api.post(seatPath(shiftId, "staff", staffProfileId, "confirm-no-show"),
                           options: .repeatSafeMutation, as: ShiftReportDetail.self)
    }

    func reopenNoShow(shiftId: String, staffProfileId: String, reason: String) async throws -> ShiftReportDetail {
        try await api.post(seatPath(shiftId, "staff", staffProfileId, "reopen-no-show"),
                           body: ReasonBody(reason: reason), options: RequestOptions(retry: .never), as: ShiftReportDetail.self)
    }

    /// NOT replay-safe (a repeat gives ALREADY_CLOCKED_IN). Never retried.
    func clockInOnBehalf(shiftId: String, staffProfileId: String, reason: String) async throws -> ShiftReportDetail {
        try await api.post(seatPath(shiftId, "staff", staffProfileId, "clock-in-on-behalf"),
                           body: ReasonBody(reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)),
                           options: RequestOptions(retry: .never), as: ShiftReportDetail.self)
    }

    /// NOT replay-safe. Refused at geofence-enforcing venues
    /// (`PRESENCE_EVIDENCE_REQUIRED`). Never retried.
    func clockOutOnBehalf(shiftId: String, staffProfileId: String, reason: String) async throws -> ShiftReportDetail {
        try await api.post(seatPath(shiftId, "staff", staffProfileId, "clock-out-on-behalf"),
                           body: ReasonBody(reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)),
                           options: RequestOptions(retry: .never), as: ShiftReportDetail.self)
    }

    /// Legacy audited correction; answers an AttendanceSummary (ignored):
    /// callers reload the report to show what was stored.
    func correctAttendance(attendanceId: String, body: CorrectAttendanceBody) async throws {
        try await api.post("/attendance/\(Self.segment(attendanceId))/correct", body: body, options: RequestOptions(retry: .never))
    }

    /// Repeat-safe (an already finalised report answers 200 unchanged).
    func finalise(shiftId: String, signedOffName: String) async throws -> ShiftReportDetail? {
        try await api.requestOptional(.patch, "/attendance/report/shift/\(Self.segment(shiftId))/finalise",
                                      body: FinaliseBody(signedOffName: signedOffName, breakConfirmed: true),
                                      options: .repeatSafeMutation, as: ShiftReportDetail.self)
    }

    func saveReview(shiftId: String, staffProfileId: String, body: StaffReviewBody) async throws {
        try await api.requestVoid(.put, seatPath(shiftId, "reviews", staffProfileId), body: body, options: RequestOptions(retry: .never))
    }

    private func seatPath(_ shiftId: String, _ parts: String...) -> String {
        var path = "/attendance/report/shift/\(Self.segment(shiftId))"
        for (index, part) in parts.enumerated() {
            // Odd positions are ids (staffProfileId); even are fixed words.
            path += "/" + (index % 2 == 1 ? Self.segment(part) : part)
        }
        return path
    }
}

enum VenueManagerError: Error, Equatable {
    /// Paging saw an empty page before `total`.
    case listChanged
    /// The server answered for a different shift than requested.
    case reportMismatch
    /// The account lacks schedule.view / venue.view.
    case scheduleAccessDenied

    var message: String {
        switch self {
        case .listChanged: return "The list changed while loading. Please refresh."
        case .reportMismatch: return "This shift's staff could not be matched. Please try again."
        case .scheduleAccessDenied: return "Your account cannot view venue schedules."
        }
    }
}

/// One normaliser for Venue Manager screens: domain errors keep their own
/// text, API errors go through the core `userMessage`.
func vmMessage(_ error: Error, fallback: String? = nil) -> String {
    if let domain = error as? VenueManagerError { return domain.message }
    return userMessage(for: error, fallback: fallback)
}

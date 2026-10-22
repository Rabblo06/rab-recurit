import Foundation

// Venue Manager wire models. Every type mirrors a server projection read in
// packages/rab-server/src (see docs/API_CONTRACT_MAP.md §3.2 and §4) and the
// Flutter parsers in packages/rab-mobile/lib/features/venue_manager/*.
//
// Decoding rules (same as Flutter's `fromJson`):
// - optional / newer fields default exactly like Flutter (`?? false`, `?? 10`),
//   so an older server (D1/D3 not deployed) still decodes;
// - status strings are kept verbatim (an unknown future value never fails a
//   decode, it renders as its own words);
// - money is Int64 pence; the report API serialises bigint `earnedPence` as a
//   decimal STRING, so pence fields accept a number or an integer string;
// - `attendanceVersion` is an opaque string echoed back unchanged.
// - `Shift.chargeRatePence` (client charge rate, BACKEND_DEPENDENCIES B4) is
//   deliberately NOT decoded: it never reaches a Venue Manager screen.

// MARK: - Decoding helpers

extension KeyedDecodingContainer {
    func vmBool(_ key: Key, default value: Bool = false) -> Bool {
        (try? decodeIfPresent(Bool.self, forKey: key)) ?? value
    }

    func vmDate(_ key: Key) -> Date? {
        try? decodeIfPresent(Date.self, forKey: key)
    }

    func vmInt(_ key: Key) -> Int? {
        try? decodeIfPresent(Int.self, forKey: key)
    }

    func vmString(_ key: Key) -> String? {
        try? decodeIfPresent(String.self, forKey: key)
    }

    /// Flutter `_blankToNull`: trimmed, empty → nil.
    func vmNonBlank(_ key: Key) -> String? {
        guard let raw = vmString(key) else { return nil }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// Integer pence sent as a JSON number or as a decimal string (bigint).
    /// A non-integer value is a decoding error, never a guessed amount.
    func vmPence(_ key: Key) throws -> Int64? {
        guard contains(key), !(try decodeNil(forKey: key)) else { return nil }
        if let value = try? decode(Int64.self, forKey: key) { return value }
        let text = try decode(String.self, forKey: key).trimmingCharacters(in: .whitespaces)
        guard let value = Int64(text) else {
            throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "Expected integer pence")
        }
        return value
    }
}

/// `{data: T[], total}` page envelope.
struct VMListPage<Item: Decodable & Hashable>: Decodable, Hashable {
    let data: [Item]
    let total: Int
}

/// A list route that answers either a plain array or a `{data, total}` page
/// (Flutter `VenueManagerProvider.all()` handles both).
enum VMListOrPage<Item: Decodable>: Decodable {
    case list([Item])
    case page([Item], total: Int)

    private enum CodingKeys: String, CodingKey { case data, total }

    init(from decoder: Decoder) throws {
        if let items = try? decoder.singleValueContainer().decode([Item].self) {
            self = .list(items)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self = .page(try c.decode([Item].self, forKey: .data), total: try c.decode(Int.self, forKey: .total))
    }
}

// MARK: - Shifts, venues, roles, offers

/// `GET /shifts` / `GET /shifts/:id` (the Shift entity). Only the fields a
/// Venue Manager screen renders; `chargeRatePence` is intentionally absent.
struct VenueShift: Decodable, Hashable, Identifiable {
    let id: String
    let venueId: String
    let jobRoleId: String
    let createdBy: String
    let address: String
    let notes: String
    let status: String
    let startsAt: Date
    let endsAt: Date
    let defaultStartsAt: Date?
    let defaultEndsAt: Date?
    let breakMinutes: Int?
    let requiredCount: Int
    let filledCount: Int
    /// Staff pay rate (Flutter's calendar shows it); NOT the charge rate.
    let payRatePence: Int64?
    let venuePhotoFileId: String?

    private enum CodingKeys: String, CodingKey {
        case id, venueId, jobRoleId, createdBy, address, notes, status, startsAt, endsAt
        case defaultStartsAt, defaultEndsAt, breakMinutes, requiredCount, filledCount, payRatePence, venuePhotoFileId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        venueId = c.vmString(.venueId) ?? ""
        jobRoleId = c.vmString(.jobRoleId) ?? ""
        createdBy = c.vmString(.createdBy) ?? ""
        address = c.vmString(.address) ?? ""
        notes = c.vmString(.notes) ?? ""
        status = try c.decode(String.self, forKey: .status)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        defaultStartsAt = c.vmDate(.defaultStartsAt)
        defaultEndsAt = c.vmDate(.defaultEndsAt)
        breakMinutes = c.vmInt(.breakMinutes)
        requiredCount = try c.decode(Int.self, forKey: .requiredCount)
        filledCount = try c.decode(Int.self, forKey: .filledCount)
        payRatePence = try? c.vmPence(.payRatePence)
        venuePhotoFileId = c.vmNonBlank(.venuePhotoFileId)
    }

    var vacancies: Int { min(max(requiredCount - filledCount, 0), max(requiredCount, 0)) }
}

/// A shift with its display names resolved from `/venues` and `/job-roles`
/// (Flutter `VenueEvent`).
struct VenueEvent: Hashable, Identifiable {
    let shift: VenueShift
    let role: String
    let venue: String

    init(shift: VenueShift, role: String, venue: String) {
        self.shift = shift
        self.role = VMText.displayRoleName(role)
        self.venue = venue
    }

    var id: String { shift.id }
    var start: Date { shift.startsAt }
    var end: Date { shift.endsAt }
    var status: String { shift.status }
    var required: Int { shift.requiredCount }
    var filled: Int { shift.filledCount }
    var vacancies: Int { shift.vacancies }
    var address: String { shift.address }
    var notes: String { shift.notes }

    func replacing(_ shift: VenueShift) -> VenueEvent {
        VenueEvent(shift: shift, role: role, venue: venue)
    }
}

struct VenueSummary: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let defaultBreakMinutes: Int?

    private enum CodingKeys: String, CodingKey { case id, name, defaultBreakMinutes }

    init(id: String, name: String, defaultBreakMinutes: Int? = nil) {
        self.id = id
        self.name = name
        self.defaultBreakMinutes = defaultBreakMinutes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        defaultBreakMinutes = c.vmInt(.defaultBreakMinutes)
    }
}

struct JobRoleSummary: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
}

/// `GET /offers` row: only what the Venue Manager screens read (no pay).
struct VMOffer: Decodable, Hashable, Identifiable {
    let id: String
    let status: String
    let sentAt: Date
    let shiftId: String
    let startsAt: Date
    let endsAt: Date
    let staffProfileId: String
    let staffName: String
    let roleName: String
    let venueName: String
}

// MARK: - Directory

/// One row of `GET /staff/venue-directory`: only Staff the Initial Manager
/// assigned to this Venue Manager. No contact details, pay or notes.
struct DirectoryUser: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let status: String
    let jobRoleName: String?
    let isFavourite: Bool
    let isEmergency: Bool
    /// Present only when the server evaluated a window; nil = "not
    /// evaluated", never "unavailable".
    let available: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, firstName, lastName, employmentStatus, jobRoleName, isFavourite, isEmergency, available
    }

    init(id: String, name: String, status: String, jobRoleName: String?, isFavourite: Bool, isEmergency: Bool, available: Bool?) {
        self.id = id
        self.name = name
        self.status = status
        self.jobRoleName = jobRoleName
        self.isFavourite = isFavourite
        self.isEmergency = isEmergency
        self.available = available
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let first = c.vmString(.firstName) ?? ""
        let last = c.vmString(.lastName) ?? ""
        name = "\(first) \(last)".trimmingCharacters(in: .whitespaces)
        status = c.vmString(.employmentStatus) ?? ""
        jobRoleName = c.vmNonBlank(.jobRoleName)
        // Flutter: `json['isFavourite'] == true`
        isFavourite = c.vmBool(.isFavourite)
        isEmergency = c.vmBool(.isEmergency)
        available = try? c.decodeIfPresent(Bool.self, forKey: .available)
    }

    /// Applies the SERVER-confirmed tag state (never an optimistic guess).
    func withTags(_ tags: StaffTags) -> DirectoryUser {
        DirectoryUser(id: id, name: name, status: status, jobRoleName: jobRoleName,
                      isFavourite: tags.isFavourite, isEmergency: tags.isEmergency, available: available)
    }
}

/// `PATCH /staff/venue-directory/:id/tags` response.
struct StaffTags: Decodable, Hashable {
    let isFavourite: Bool
    let isEmergency: Bool

    private enum CodingKeys: String, CodingKey { case isFavourite, isEmergency }

    init(isFavourite: Bool, isEmergency: Bool) {
        self.isFavourite = isFavourite
        self.isEmergency = isEmergency
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isFavourite = c.vmBool(.isFavourite)
        isEmergency = c.vmBool(.isEmergency)
    }
}

/// `GET /staff/venue-directory/:staffId`. Every optional field renders only
/// when the server provides it; there is no rating field (no aggregated
/// reviews for Venue Managers).
struct VenueStaffProfile: Decodable, Hashable {
    let id: String
    let firstName: String
    let lastName: String
    let jobRoleName: String?
    let employmentType: String?
    let yearsExperience: Int?
    let skills: [String]
    /// Subset of Monday…Sunday exactly as the server sent it.
    let availableDays: [String]
    let preferredShiftTimes: String?
    let maxHoursPerWeek: Int?
    private(set) var isFavourite: Bool
    private(set) var isEmergency: Bool

    private enum CodingKeys: String, CodingKey {
        case id, firstName, lastName, jobRoleName, employmentType, yearsExperience, skills
        case availableDays, preferredShiftTimes, maxHoursPerWeek, isFavourite, isEmergency
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        firstName = c.vmString(.firstName) ?? ""
        lastName = c.vmString(.lastName) ?? ""
        jobRoleName = c.vmNonBlank(.jobRoleName)
        employmentType = c.vmNonBlank(.employmentType)
        yearsExperience = c.vmInt(.yearsExperience)
        let rawSkills: [String?] = (try? c.decodeIfPresent([String?].self, forKey: .skills)) ?? []
        skills = rawSkills.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let rawDays: [String] = (try? c.decodeIfPresent([String].self, forKey: .availableDays)) ?? []
        var seen = Set<String>()
        availableDays = rawDays.filter { seen.insert($0).inserted }
        preferredShiftTimes = c.vmNonBlank(.preferredShiftTimes)
        maxHoursPerWeek = c.vmInt(.maxHoursPerWeek)
        isFavourite = c.vmBool(.isFavourite)
        isEmergency = c.vmBool(.isEmergency)
    }

    var name: String { "\(firstName) \(lastName)".trimmingCharacters(in: .whitespaces) }

    /// Applies the server-confirmed tag state returned by the PATCH.
    func withTags(_ tags: StaffTags) -> VenueStaffProfile {
        var copy = self
        copy.isFavourite = tags.isFavourite
        copy.isEmergency = tags.isEmergency
        return copy
    }
}

// MARK: - Sent shifts

/// `GET /shifts/sent` row (server `sentShiftPresentation`). Labels, filters
/// and counters are server-derived; the app never infers progress from the
/// clock.
struct SentShift: Decodable, Hashable, Identifiable {
    let id: String
    let status: String
    let requiredCount: Int
    let startsAt: Date
    let endsAt: Date
    let submittedAt: Date?
    let venueName: String
    let roleName: String
    let statusLabel: String
    let actionExpired: Bool
    let offerCounts: [String: Int]
    let counters: [String: Bool]
    let filters: [String]

    private enum CodingKeys: String, CodingKey {
        case id, status, requiredCount, startsAt, endsAt, submittedAt, venueName, roleName
        case statusLabel, actionExpired, offerCounts, counters, filters
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = c.vmString(.status) ?? ""
        requiredCount = try c.decode(Int.self, forKey: .requiredCount)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        submittedAt = c.vmDate(.submittedAt)
        venueName = try c.decode(String.self, forKey: .venueName)
        roleName = try c.decode(String.self, forKey: .roleName)
        statusLabel = c.vmString(.statusLabel) ?? ""
        actionExpired = c.vmBool(.actionExpired)
        offerCounts = (try? c.decodeIfPresent([String: Int].self, forKey: .offerCounts)) ?? [:]
        counters = (try? c.decodeIfPresent([String: Bool].self, forKey: .counters)) ?? [:]
        filters = (try? c.decodeIfPresent([String].self, forKey: .filters)) ?? []
    }

    func count(_ key: String) -> Int { offerCounts[key] ?? 0 }
    func counter(_ key: String) -> Bool { counters[key] == true }
}

/// `GET /shifts/sent?view=` envelope with the server's tab counts.
struct SentShiftsPage: Decodable, Hashable {
    let data: [SentShift]
    let total: Int
    let counts: [String: Int]

    private enum CodingKeys: String, CodingKey { case data, total, counts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        data = (try? c.decodeIfPresent([SentShift].self, forKey: .data)) ?? []
        total = c.vmInt(.total) ?? data.count
        counts = (try? c.decodeIfPresent([String: Int].self, forKey: .counts)) ?? [:]
    }
}

/// `POST /shifts/request` 201 body: only the new shift id is read.
struct CreatedShift: Decodable, Hashable {
    let id: String
}

// MARK: - Shift report

/// Mirrors `ShiftReportStaffRow` (server `shift-report.service.ts`): one row
/// per confirmed / completed / no_show assignment, even with no attendance.
struct ShiftReportStaffRow: Decodable, Hashable, Identifiable {
    let staffProfileId: String
    let staffName: String
    let roleName: String
    let scheduledStart: Date?
    let scheduledEnd: Date?
    let assignmentStatus: String
    let attendanceId: String?
    let attendanceStatus: String?
    let clockInAt: Date?
    let clockOutAt: Date?
    let breakMinutes: Int?
    let scheduledBreakMinutes: Int
    let workedMinutes: Int?
    let earnedPence: Int64?
    let locationVerified: Bool
    let clockOutMethod: String?
    let corrected: Bool
    /// Optional per-shift performance rating saved; never the finalise gate.
    let performanceReviewed: Bool
    /// The explicit ATTENDANCE review; what "Reviewed" means and what gates
    /// Finalise & send.
    let attendanceReviewed: Bool
    let attendanceReviewedAt: Date?
    let attendanceReviewedByName: String?
    /// [NOT-REBUILT] manager-entered attendance.
    let manuallyEntered: Bool
    /// [NOT-REBUILT] opaque optimistic-concurrency token; echo unchanged.
    let attendanceVersion: String?
    /// [NOT-REBUILT] manager-confirmed no-show. Older servers: a reviewed
    /// no_show seat is the confirmed one (Flutter fallback).
    let noShowConfirmed: Bool
    let noShowConfirmableAt: Date?
    /// [TEST-DB] check-in fields (absent → false/nil).
    let checkInRequired: Bool
    let checkedInAt: Date?
    let checkInSource: String?
    let checkInLocationVerified: Bool
    let clockInMethod: String?
    let clockInByName: String?
    let clockInReason: String?
    let clockOutByName: String?
    let clockOutReason: String?

    var id: String { staffProfileId }

    private enum CodingKeys: String, CodingKey {
        case staffProfileId, staffName, roleName, scheduledStart, scheduledEnd, assignmentStatus
        case attendanceId, attendanceStatus, clockInAt, clockOutAt, breakMinutes, scheduledBreakMinutes
        case workedMinutes, earnedPence, locationVerified, clockOutMethod, corrected, performanceReviewed
        case attendanceReviewed, attendanceReviewedAt, attendanceReviewedByName, manuallyEntered
        case attendanceVersion, noShowConfirmed, noShowConfirmableAt, checkInRequired, checkedInAt
        case checkInSource, checkInLocationVerified, clockInMethod, clockInByName, clockInReason
        case clockOutByName, clockOutReason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        staffProfileId = try c.decode(String.self, forKey: .staffProfileId)
        staffName = try c.decode(String.self, forKey: .staffName)
        roleName = try c.decode(String.self, forKey: .roleName)
        scheduledStart = c.vmDate(.scheduledStart)
        scheduledEnd = c.vmDate(.scheduledEnd)
        assignmentStatus = try c.decode(String.self, forKey: .assignmentStatus)
        attendanceId = c.vmString(.attendanceId)
        attendanceStatus = c.vmString(.attendanceStatus)
        // A present-but-unparseable punch time must fail loudly, never read as "not clocked in".
        clockInAt = try c.decodeIfPresent(Date.self, forKey: .clockInAt)
        clockOutAt = try c.decodeIfPresent(Date.self, forKey: .clockOutAt)
        breakMinutes = c.vmInt(.breakMinutes)
        scheduledBreakMinutes = try c.decode(Int.self, forKey: .scheduledBreakMinutes)
        workedMinutes = c.vmInt(.workedMinutes)
        earnedPence = try c.vmPence(.earnedPence)
        locationVerified = c.vmBool(.locationVerified)
        clockOutMethod = c.vmString(.clockOutMethod)
        corrected = c.vmBool(.corrected)
        performanceReviewed = c.vmBool(.performanceReviewed)
        attendanceReviewed = c.vmBool(.attendanceReviewed)
        attendanceReviewedAt = c.vmDate(.attendanceReviewedAt)
        attendanceReviewedByName = c.vmString(.attendanceReviewedByName)
        manuallyEntered = c.vmBool(.manuallyEntered)
        attendanceVersion = c.vmString(.attendanceVersion)
        let explicitNoShow = try? c.decodeIfPresent(Bool.self, forKey: .noShowConfirmed)
        noShowConfirmed = explicitNoShow ?? (assignmentStatus == "no_show" && attendanceReviewed)
        noShowConfirmableAt = c.vmDate(.noShowConfirmableAt)
        checkInRequired = c.vmBool(.checkInRequired)
        checkedInAt = c.vmDate(.checkedInAt)
        checkInSource = c.vmString(.checkInSource)
        checkInLocationVerified = c.vmBool(.checkInLocationVerified)
        clockInMethod = c.vmString(.clockInMethod)
        clockInByName = c.vmString(.clockInByName)
        clockInReason = c.vmString(.clockInReason)
        clockOutByName = c.vmString(.clockOutByName)
        clockOutReason = c.vmString(.clockOutReason)
    }

    var checkedIn: Bool { checkedInAt != nil }
    /// No attendance and no confirmed no-show (includes the worker's
    /// PROVISIONAL no-show): record attendance or confirm the no-show.
    var attendanceMissing: Bool { attendanceId == nil && !noShowConfirmed }
    var isOpen: Bool { attendanceStatus == "clocked_in" || attendanceStatus == "on_break" }
    var isNoShow: Bool { assignmentStatus == "no_show" }
    /// A clock-out exists or the seat is a recorded no-show.
    var attendanceResolved: Bool { !isOpen && (isNoShow || clockOutAt != nil) }
    var canCorrect: Bool { attendanceId != nil }

    /// Display label for the attendance status; never a raw enum value.
    var statusLabel: String {
        switch attendanceStatus {
        case nil: return "Not clocked in"
        case "clocked_in": return "Clocked in"
        case "on_break": return "On break"
        case "clocked_out": return "Clocked out"
        case "under_review": return "Under review"
        case "approved": return "Approved"
        case "missing_clock_out": return "Missing clock-out"
        case "late": return "Late"
        case "absent": return "Absent"
        case "disputed": return "Disputed"
        case let other?: return other.replacingOccurrences(of: "_", with: " ")
        }
    }
}

/// Server `ReportLifecycle` (five-hour policy, computed against DB time).
struct ReportLifecycle: Decodable, Hashable {
    let displayStatus: String
    let displayLabel: String
    let actionExpiresAt: Date
    let actionExpired: Bool
    let needsAttendanceReview: Bool
    let needsAttention: Bool
    /// not_finalised | generating | queued | sent | failed | no_recipients
    let deliveryState: String
    let sentAt: Date?
    let historyAt: Date?

    private enum CodingKeys: String, CodingKey {
        case displayStatus, displayLabel, actionExpiresAt, actionExpired, needsAttendanceReview
        case needsAttention, deliveryState, sentAt, historyAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayStatus = try c.decode(String.self, forKey: .displayStatus)
        displayLabel = try c.decode(String.self, forKey: .displayLabel)
        actionExpiresAt = try c.decode(Date.self, forKey: .actionExpiresAt)
        actionExpired = c.vmBool(.actionExpired)
        needsAttendanceReview = c.vmBool(.needsAttendanceReview)
        needsAttention = c.vmBool(.needsAttention)
        deliveryState = c.vmString(.deliveryState) ?? "not_finalised"
        sentAt = c.vmDate(.sentAt)
        historyAt = c.vmDate(.historyAt)
    }
}

struct ReportFileRef: Decodable, Hashable {
    let fileId: String
    let filename: String
}

/// One openable report document (`/files/:id/download`).
struct ReportDocument: Decodable, Hashable {
    /// `pre_shift` (attendance sheet with the Shift QR) or `final`.
    let kind: String
    let fileId: String
    let filename: String

    var isFinal: Bool { kind == "final" }
}

/// Server `ReportActions` (`report-actions.ts`), decided from DB time. The
/// app only renders it.
struct ReportActions: Decodable, Hashable {
    /// scheduled | pre_shift | started | finalised
    let stage: String
    let timesheetAvailableAt: Date
    /// hidden | preparing | available
    let timesheet: String
    /// hidden | disabled | enabled
    let finalise: String
    let document: ReportDocument?
    let preShiftDocument: ReportDocument?
    let finalDocumentPending: Bool

    private enum CodingKeys: String, CodingKey {
        case stage, timesheetAvailableAt, timesheet, finalise, document, preShiftDocument, finalDocumentPending
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stage = try c.decode(String.self, forKey: .stage)
        timesheetAvailableAt = try c.decode(Date.self, forKey: .timesheetAvailableAt)
        timesheet = try c.decode(String.self, forKey: .timesheet)
        finalise = try c.decode(String.self, forKey: .finalise)
        document = try? c.decodeIfPresent(ReportDocument.self, forKey: .document)
        preShiftDocument = try? c.decodeIfPresent(ReportDocument.self, forKey: .preShiftDocument)
        finalDocumentPending = c.vmBool(.finalDocumentPending)
    }

    var showTimesheet: Bool { timesheet != "hidden" }
    var showFinalise: Bool { finalise != "hidden" }
    var canFinalise: Bool { finalise == "enabled" }
}

/// The QR clock window signed into the Shift QR (display only).
struct QrWindow: Decodable, Hashable {
    let opensAt: Date
    let closesAt: Date
    /// not_open | open | closed
    let state: String
}

struct ReportSignOff: Decodable, Hashable {
    let name: String
    let breakConfirmed: Bool
    let signedBy: String?
    let signedAt: Date?

    private enum CodingKeys: String, CodingKey { case name, breakConfirmed, signedBy, signedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        breakConfirmed = c.vmBool(.breakConfirmed)
        signedBy = c.vmString(.signedBy)
        signedAt = c.vmDate(.signedAt)
    }
}

/// [TEST-DB] on-behalf punch rules for this venue. DISPLAY HINTS ONLY; the
/// server enforces them.
struct ReportAttendancePolicy: Decodable, Hashable {
    let geofenceEnforced: Bool
    let onBehalfClockOutAllowed: Bool
    let onBehalfReasonMinWords: Int

    private enum CodingKeys: String, CodingKey { case geofenceEnforced, onBehalfClockOutAllowed, onBehalfReasonMinWords }

    init(geofenceEnforced: Bool, onBehalfClockOutAllowed: Bool, onBehalfReasonMinWords: Int = 10) {
        self.geofenceEnforced = geofenceEnforced
        self.onBehalfClockOutAllowed = onBehalfClockOutAllowed
        self.onBehalfReasonMinWords = onBehalfReasonMinWords
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        geofenceEnforced = c.vmBool(.geofenceEnforced)
        onBehalfClockOutAllowed = c.vmBool(.onBehalfClockOutAllowed)
        onBehalfReasonMinWords = c.vmInt(.onBehalfReasonMinWords) ?? 10
    }
}

/// Mirrors `ShiftReportDetail`. Every seat action returns a full one; the
/// app renders that response and never patches local state.
struct ShiftReportDetail: Decodable, Hashable, Identifiable {
    let shiftId: String
    let venueName: String
    let roleName: String
    let startsAt: Date
    let endsAt: Date
    /// pending | ready | finalised
    let reportStatus: String
    let finalisedAt: Date?
    let finalisedByName: String?
    let staff: [ShiftReportStaffRow]
    let ready: Bool
    /// Server `isReportFinalisable`: THE finalisation gate.
    let finalisable: Bool
    let reviewsRemaining: Int
    let lifecycle: ReportLifecycle?
    let actions: ReportActions?
    let preShiftFile: ReportFileRef?
    let finalFile: ReportFileRef?
    let qrWindow: QrWindow?
    let signOff: ReportSignOff?
    /// DB time when this report was read (the trusted clock base).
    let serverNow: Date?
    let attendancePolicy: ReportAttendancePolicy?

    var id: String { shiftId }

    private enum CodingKeys: String, CodingKey {
        case shiftId, venueName, roleName, startsAt, endsAt, reportStatus, finalisedAt, finalisedByName
        case staff, ready, finalisable, reviewsRemaining, lifecycle, actions, preShiftFile, finalFile
        case qrWindow, signOff, serverNow, attendancePolicy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shiftId = try c.decode(String.self, forKey: .shiftId)
        venueName = try c.decode(String.self, forKey: .venueName)
        roleName = try c.decode(String.self, forKey: .roleName)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        reportStatus = try c.decode(String.self, forKey: .reportStatus)
        finalisedAt = c.vmDate(.finalisedAt)
        finalisedByName = c.vmString(.finalisedByName)
        staff = try c.decode([ShiftReportStaffRow].self, forKey: .staff)
        ready = c.vmBool(.ready)
        finalisable = c.vmBool(.finalisable)
        reviewsRemaining = c.vmInt(.reviewsRemaining) ?? 0
        lifecycle = try c.decodeIfPresent(ReportLifecycle.self, forKey: .lifecycle)
        actions = try c.decodeIfPresent(ReportActions.self, forKey: .actions)
        preShiftFile = try? c.decodeIfPresent(ReportFileRef.self, forKey: .preShiftFile)
        finalFile = try? c.decodeIfPresent(ReportFileRef.self, forKey: .finalFile)
        qrWindow = try? c.decodeIfPresent(QrWindow.self, forKey: .qrWindow)
        signOff = try? c.decodeIfPresent(ReportSignOff.self, forKey: .signOff)
        serverNow = c.vmDate(.serverNow)
        attendancePolicy = try? c.decodeIfPresent(ReportAttendancePolicy.self, forKey: .attendancePolicy)
    }

    func row(for staffProfileId: String) -> ShiftReportStaffRow? {
        staff.first { $0.staffProfileId == staffProfileId }
    }

    var reviewedCount: Int { staff.filter(\.attendanceReviewed).count }
    /// Seats with no clock-out and no no-show outcome (server readiness rule).
    var missingClockOut: Int { staff.filter { $0.assignmentStatus != "no_show" && $0.clockOutAt == nil }.count }
    var clockedIn: Int { staff.filter { $0.clockInAt != nil }.count }
    var clockedOut: Int { staff.filter { $0.clockOutAt != nil }.count }
    var stillClockedIn: Int { staff.filter(\.isOpen).count }
    var isFinalised: Bool { reportStatus == "finalised" }
    /// The server's gate; the client never decides readiness from its clock.
    var canFinalise: Bool { !isFinalised && finalisable }
}

/// `GET /attendance/report/shifts?bucket=` row.
struct ReportSummary: Decodable, Hashable, Identifiable {
    let shiftId: String
    let venueName: String
    let roleName: String
    let startsAt: Date
    let endsAt: Date
    let shiftStatus: String
    let requiredCount: Int
    let filledCount: Int
    let staffCount: Int
    let clockedOut: Int
    /// Includes provisional marks (server); not shown as "no-shows".
    let noShows: Int
    let reportStatus: String
    let lifecycle: ReportLifecycle

    var id: String { shiftId }
    var open: Int { min(max(requiredCount - filledCount, 0), max(requiredCount, 0)) }
}

struct ReportListPage: Decodable, Hashable {
    let data: [ReportSummary]
    let total: Int
    let serverNow: Date?

    private enum CodingKeys: String, CodingKey { case data, total, serverNow }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        data = try c.decode([ReportSummary].self, forKey: .data)
        total = try c.decode(Int.self, forKey: .total)
        serverNow = c.vmDate(.serverNow)
    }
}

// MARK: - Performance review

/// The five review categories in display order, with their wire names.
enum StaffReviewCategory: String, CaseIterable, Hashable {
    case grooming, attitude, skills, attendance, timeKeeping

    var label: String {
        switch self {
        case .grooming: return "Grooming"
        case .attitude: return "Attitude"
        case .skills: return "Skills"
        case .attendance: return "Attendance"
        case .timeKeeping: return "Time keeping"
        }
    }
}

struct StaffReview: Decodable, Hashable {
    let ratings: [StaffReviewCategory: Int]
    let feedback: String?
    let reviewerName: String?
    let updatedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case grooming, attitude, skills, attendance, timeKeeping, feedback, reviewerName, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var ratings: [StaffReviewCategory: Int] = [:]
        ratings[.grooming] = try c.decode(Int.self, forKey: .grooming)
        ratings[.attitude] = try c.decode(Int.self, forKey: .attitude)
        ratings[.skills] = try c.decode(Int.self, forKey: .skills)
        ratings[.attendance] = try c.decode(Int.self, forKey: .attendance)
        ratings[.timeKeeping] = try c.decode(Int.self, forKey: .timeKeeping)
        self.ratings = ratings
        feedback = c.vmString(.feedback)
        reviewerName = c.vmString(.reviewerName)
        updatedAt = c.vmDate(.updatedAt)
    }
}

/// `GET …/reviews/:staffProfileId`.
struct StaffReviewEnvelope: Decodable, Hashable {
    let review: StaffReview?
    let editable: Bool

    private enum CodingKeys: String, CodingKey { case review, editable }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        review = try c.decodeIfPresent(StaffReview.self, forKey: .review)
        editable = c.vmBool(.editable)
    }
}

// MARK: - Request bodies (only declared DTO fields; never organisationId/status)

struct SubmitShiftRequestBody: Encodable, Equatable {
    struct Assignment: Encodable, Equatable {
        let staffProfileId: String
        /// nil = inherit the request's break (omitted from the JSON).
        let breakMinutes: Int?
        let startsAt: Date
        let endsAt: Date
    }

    struct Acknowledgement: Encodable, Equatable, Hashable {
        let staffProfileId: String
        let dates: [String]
    }

    let venueId: String
    let jobRoleId: String
    let startsAt: Date
    let endsAt: Date
    /// nil = the venue default, else 30 (resolved server-side).
    let breakMinutes: Int?
    let staffRequired: Int
    let staffProfileIds: [String]
    let staffAssignments: [Assignment]
    let acknowledgedAvailabilityConflicts: [Acknowledgement]?
    // No `note`: the server accepts but silently drops it (B3), so the app
    // never offers a field that would pretend to save text.
}

struct StaffTagsBody: Encodable, Equatable {
    let favourite: Bool?
    let emergency: Bool?
}

/// `POST …/record-attendance`.
struct RecordAttendanceBody: Encodable, Equatable {
    let clockInAt: Date?
    let clockOutAt: Date?
    let breakMinutes: Int?
    let reasonCode: String
    let reasonNote: String?
    /// The `attendanceVersion` read with the row, echoed unchanged; omitted
    /// when the row had no attendance (exactly like Flutter).
    let expectedVersion: String?
}

struct ReasonBody: Encodable, Equatable {
    let reason: String
}

struct FinaliseBody: Encodable, Equatable {
    let signedOffName: String
    let breakConfirmed: Bool
}

struct CorrectAttendanceBody: Encodable, Equatable {
    let field: String
    let newValue: String
    let reason: String
}

struct StaffReviewBody: Encodable, Equatable {
    let grooming: Int
    let attitude: Int
    let skills: Int
    let attendance: Int
    let timeKeeping: Int
    let feedback: String?
}

// MARK: - Availability conflict (409 STAFF_AVAILABILITY_CONFLICT)

struct AvailabilityConflict: Equatable {
    struct Entry: Equatable {
        let staffProfileId: String
        let staffName: String
        let availableDays: [String]
        let dates: [String]
        let weekdays: [String]
    }

    let totalRecipients: Int
    let entries: [Entry]
    let unknownCount: Int

    /// Nothing was created; nil for any other error.
    static func from(_ error: Error) -> AvailabilityConflict? {
        guard let api = error as? APIError, api.statusCode == 409, api.code == "STAFF_AVAILABILITY_CONFLICT",
              case .array(let raw)? = api.payload?.body?["conflicts"]
        else { return nil }
        var entries: [Entry] = []
        for item in raw {
            guard case .object(let c) = item, let id = c["staffProfileId"]?.stringValue else { continue }
            var dates: [String] = []
            var weekdays: [String] = []
            if case .array(let list)? = c["conflictDates"] {
                for d in list {
                    guard case .object(let o) = d else { continue }
                    if let date = o["date"]?.stringValue { dates.append(date) }
                    if let weekday = o["weekday"]?.stringValue { weekdays.append(weekday) }
                }
            }
            var available: [String] = []
            if case .array(let list)? = c["availableDays"] { available = list.compactMap(\.stringValue) }
            entries.append(Entry(staffProfileId: id, staffName: c["staffName"]?.stringValue ?? "This staff member",
                                 availableDays: available, dates: dates, weekdays: weekdays))
        }
        var unknown = 0
        if case .array(let list)? = api.payload?.body?["unknownAvailability"] { unknown = list.count }
        var total = entries.count
        if case .number(let n)? = api.payload?.body?["totalRecipients"] { total = Int(n) }
        return AvailabilityConflict(totalRecipients: total, entries: entries, unknownCount: unknown)
    }

    /// Resend with every conflicting date acknowledged ("Submit anyway").
    var acknowledgements: [SubmitShiftRequestBody.Acknowledgement] {
        entries.map { .init(staffProfileId: $0.staffProfileId, dates: $0.dates) }
    }
}

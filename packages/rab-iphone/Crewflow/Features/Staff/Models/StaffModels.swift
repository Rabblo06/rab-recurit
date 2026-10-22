import Foundation

// Staff-app response models. Every type mirrors a server projection field by
// field (docs/API_CONTRACT_MAP.md §2, §3.1, §5, §9) and the Flutter models in
// packages/rab-mobile/lib/core/models. Status-like values stay raw `String`s
// so a value this build does not know never fails a decode (contract §3.3:
// "never crash on a new value"); the known values live in `StaffStatus`.
// Money is always Int64 pence. Type names carry a `Staff` prefix so they can
// never collide with the Venue Manager feature's own models.

/// Known server values (strings compared verbatim, unknown values tolerated).
enum StaffStatus {
    // OfferStatus
    static let pending = "pending"
    static let staffAccepted = "staff_accepted"
    static let managerConfirmed = "manager_confirmed"
    static let managerRejected = "manager_rejected"
    static let declined = "declined"
    static let expired = "expired"
    static let withdrawn = "withdrawn"

    // AttendanceStatus
    static let scheduled = "scheduled"
    static let clockedIn = "clocked_in"
    static let onBreak = "on_break"
    static let underReview = "under_review"
    static let disputed = "disputed"

    // PayrollRecordStatus that count as approved (History gate, contract §2).
    static let payrollApproved: Set<String> = ["approved", "processing", "paid"]

    // OfferKind [TEST-DB]
    static let replacement = "replacement"
    static let standby = "standby"
}

// MARK: - Offers (`GET /offers/mine`)

/// `presentation` on an offer: the server's own lifecycle projection. The app
/// never runs the +2 h / +6 h rules itself (Flutter `StaffShiftPresentation`).
struct StaffShiftPresentation: Decodable, Hashable, Sendable {
    /// pending, confirmed, ended, live, clockedOut, complete, expired,
    /// declined, rejected, cancelled (raw; unknown values tolerated).
    let state: String
    let homeLabel: String
    let isToday: Bool
    /// The trusted clock base for this payload.
    let serverNow: Date
    let nextTransitionAt: Date?
    let clockInAt: Date?
    let clockOutAt: Date?
    let timezone: String?

    init(
        state: String,
        homeLabel: String,
        isToday: Bool,
        serverNow: Date,
        nextTransitionAt: Date? = nil,
        clockInAt: Date? = nil,
        clockOutAt: Date? = nil,
        timezone: String? = nil
    ) {
        self.state = state
        self.homeLabel = homeLabel
        self.isToday = isToday
        self.serverNow = serverNow
        self.nextTransitionAt = nextTransitionAt
        self.clockInAt = clockInAt
        self.clockOutAt = clockOutAt
        self.timezone = timezone
    }

    /// Same wording as Flutter `StaffShiftPresentation.label`.
    var label: String {
        switch state {
        case "pending": return "Pending"
        case "confirmed": return "Confirmed"
        case "live": return "Live"
        case "clockedOut": return "Clocked Out"
        case "complete": return "Complete"
        case "expired": return "Expired"
        case "cancelled": return "Cancelled"
        case "declined": return "Declined"
        case "ended": return "Ended"
        case "rejected": return "Not confirmed"
        default: return "Updating"
        }
    }
}

/// `OfferSummary` (`offer.service.ts`). `startsAt`/`endsAt` are THIS staff
/// member's assignment window.
struct StaffOfferSummary: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let status: String
    let sentAt: Date
    let expiresAt: Date
    let respondedAt: Date?
    let declineReason: String?
    let staffAcceptedAt: Date?
    let managerConfirmedAt: Date?
    let managerRejectedAt: Date?
    let rejectionReason: String?
    let estimatedPayPence: Int64
    let offerBatchId: String?
    let shiftId: String
    let startsAt: Date
    let endsAt: Date
    /// [TEST-DB] original shift window (replacement/standby offers).
    let originalStartsAt: Date?
    let originalEndsAt: Date?
    let venueName: String
    let roleName: String
    let staffProfileId: String
    let staffName: String
    let payRatePence: Int64
    let venueAddress: String?
    let shiftNotes: String?
    let venuePhotoFileId: String?
    /// [TEST-DB] `standard | replacement | standby`; nil from older servers.
    let offerKind: String?
    /// [TEST-DB] This booking needs a Check In before Clock In. False for
    /// bookings made before Check In shipped and from servers without the field.
    let checkInRequired: Bool
    let checkedInAt: Date?
    /// `staff | qr | nil`.
    let checkInSource: String?
    /// [TEST-DB] The venue requires location evidence. nil = the server did
    /// not say (older server): keep the previous behaviour and ask.
    let geofenceEnforced: Bool?
    let presentation: StaffShiftPresentation?

    enum CodingKeys: String, CodingKey {
        case id, status, sentAt, expiresAt, respondedAt, declineReason, staffAcceptedAt, managerConfirmedAt
        case managerRejectedAt, rejectionReason, estimatedPayPence, offerBatchId, shiftId, startsAt, endsAt
        case originalStartsAt, originalEndsAt, venueName, roleName, staffProfileId, staffName, payRatePence
        case venueAddress, shiftNotes, venuePhotoFileId, offerKind, checkInRequired, checkedInAt, checkInSource
        case geofenceEnforced, presentation
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(String.self, forKey: .status)
        sentAt = try c.decode(Date.self, forKey: .sentAt)
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
        respondedAt = try c.decodeIfPresent(Date.self, forKey: .respondedAt)
        declineReason = try c.decodeIfPresent(String.self, forKey: .declineReason)
        staffAcceptedAt = try c.decodeIfPresent(Date.self, forKey: .staffAcceptedAt)
        managerConfirmedAt = try c.decodeIfPresent(Date.self, forKey: .managerConfirmedAt)
        managerRejectedAt = try c.decodeIfPresent(Date.self, forKey: .managerRejectedAt)
        rejectionReason = try c.decodeIfPresent(String.self, forKey: .rejectionReason)
        estimatedPayPence = try c.decode(Int64.self, forKey: .estimatedPayPence)
        offerBatchId = try c.decodeIfPresent(String.self, forKey: .offerBatchId)
        shiftId = try c.decode(String.self, forKey: .shiftId)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        originalStartsAt = try? c.decodeIfPresent(Date.self, forKey: .originalStartsAt)
        originalEndsAt = try? c.decodeIfPresent(Date.self, forKey: .originalEndsAt)
        venueName = try c.decode(String.self, forKey: .venueName)
        roleName = try c.decode(String.self, forKey: .roleName)
        staffProfileId = try c.decode(String.self, forKey: .staffProfileId)
        staffName = try c.decode(String.self, forKey: .staffName)
        payRatePence = try c.decode(Int64.self, forKey: .payRatePence)
        venueAddress = try c.decodeIfPresent(String.self, forKey: .venueAddress)
        shiftNotes = try c.decodeIfPresent(String.self, forKey: .shiftNotes)
        venuePhotoFileId = try c.decodeIfPresent(String.self, forKey: .venuePhotoFileId)
        offerKind = try c.decodeIfPresent(String.self, forKey: .offerKind)
        // Same defaults as Flutter `OfferSummary.fromJson` (contract §3.1).
        checkInRequired = try c.decodeIfPresent(Bool.self, forKey: .checkInRequired) ?? false
        checkedInAt = try? c.decodeIfPresent(Date.self, forKey: .checkedInAt)
        checkInSource = try c.decodeIfPresent(String.self, forKey: .checkInSource)
        geofenceEnforced = try c.decodeIfPresent(Bool.self, forKey: .geofenceEnforced)
        // A malformed projection degrades to "no projection" (Flutter: `is Map`).
        presentation = try? c.decodeIfPresent(StaffShiftPresentation.self, forKey: .presentation)
    }

    var isPending: Bool { status == StaffStatus.pending }
    var isConfirmed: Bool { status == StaffStatus.managerConfirmed }
    var presentationState: String? { presentation?.state }
}

// MARK: - Attendance

/// `AttendanceSummary` (`attendance.service.ts:84-192`).
struct StaffAttendanceSummary: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let status: String
    let clockInAt: Date
    let clockOutAt: Date?
    /// Server-computed; the app never computes worked time.
    let workedMinutes: Int?
    let earnedPence: Int64?
    let breakMinutes: Int?
    let locationVerified: Bool
    let clockOutMethod: String?
    let shiftId: String
    let startsAt: Date
    let endsAt: Date
    let venueName: String
    let roleName: String
    let staffProfileId: String
    let staffName: String
    let venuePhotoFileId: String?
    /// PayrollRecordStatus, or nil while no payroll record exists.
    let payrollStatus: String?
    /// Approved pay; only present once payroll is approved. Never an estimate.
    let payrollApprovedPence: Int64?
    let clockInMethod: String?
    let checkInRequired: Bool
    let checkedInAt: Date?
    let checkInSource: String?

    enum CodingKeys: String, CodingKey {
        case id, status, clockInAt, clockOutAt, workedMinutes, earnedPence, breakMinutes, locationVerified
        case clockOutMethod, shiftId, startsAt, endsAt, venueName, roleName, staffProfileId, staffName
        case venuePhotoFileId, payrollStatus, payrollApprovedPence, clockInMethod, checkInRequired, checkedInAt
        case checkInSource
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(String.self, forKey: .status)
        clockInAt = try c.decode(Date.self, forKey: .clockInAt)
        clockOutAt = try c.decodeIfPresent(Date.self, forKey: .clockOutAt)
        workedMinutes = try c.decodeIfPresent(Int.self, forKey: .workedMinutes)
        earnedPence = try c.decodeIfPresent(Int64.self, forKey: .earnedPence)
        breakMinutes = try c.decodeIfPresent(Int.self, forKey: .breakMinutes)
        locationVerified = try c.decodeIfPresent(Bool.self, forKey: .locationVerified) ?? false
        clockOutMethod = try c.decodeIfPresent(String.self, forKey: .clockOutMethod)
        shiftId = try c.decode(String.self, forKey: .shiftId)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        venueName = try c.decode(String.self, forKey: .venueName)
        roleName = try c.decode(String.self, forKey: .roleName)
        staffProfileId = try c.decode(String.self, forKey: .staffProfileId)
        staffName = try c.decode(String.self, forKey: .staffName)
        venuePhotoFileId = try c.decodeIfPresent(String.self, forKey: .venuePhotoFileId)
        payrollStatus = try c.decodeIfPresent(String.self, forKey: .payrollStatus)
        payrollApprovedPence = try c.decodeIfPresent(Int64.self, forKey: .payrollApprovedPence)
        clockInMethod = try c.decodeIfPresent(String.self, forKey: .clockInMethod)
        checkInRequired = try c.decodeIfPresent(Bool.self, forKey: .checkInRequired) ?? false
        checkedInAt = try? c.decodeIfPresent(Date.self, forKey: .checkedInAt)
        checkInSource = try c.decodeIfPresent(String.self, forKey: .checkInSource)
    }

    /// Payroll approved (possibly since processed or paid). Pending, rejected
    /// and corrected records are NOT approved (Flutter `payrollApproved`).
    var payrollApproved: Bool {
        guard let payrollStatus else { return false }
        return StaffStatus.payrollApproved.contains(payrollStatus)
    }

    /// Still actively on shift.
    var isOpen: Bool { status == StaffStatus.clockedIn || status == StaffStatus.onBreak }

    /// No longer clocked in (whether or not a manager has reviewed it yet).
    var hasEnded: Bool { !isOpen && status != StaffStatus.scheduled }
}

/// `locationEvidence` from `/attendance/me/active`: what a fix must satisfy
/// at a geofence-enforcing venue. Pre-check only; the server decides.
struct StaffLocationEvidenceLimits: Decodable, Hashable, Sendable {
    let maxAccuracyM: Double
    let maxAgeSeconds: Int
    let maxFutureSkewSeconds: Int
}

/// `GET /attendance/me/active`.
struct StaffActiveAttendance: Decodable, Sendable {
    let attendance: StaffAttendanceSummary?
    let serverNow: Date?
    let clockInEarlyMinutes: Int?
    let locationEvidence: StaffLocationEvidenceLimits?

    enum CodingKeys: String, CodingKey {
        case attendance, serverNow, clockInEarlyMinutes, locationEvidence
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        attendance = try c.decodeIfPresent(StaffAttendanceSummary.self, forKey: .attendance)
        serverNow = try? c.decodeIfPresent(Date.self, forKey: .serverNow)
        let early = try? c.decodeIfPresent(Int.self, forKey: .clockInEarlyMinutes)
        // Flutter: `early is int && early >= 0 ? early : null`.
        clockInEarlyMinutes = early.flatMap { $0 >= 0 ? $0 : nil }
        locationEvidence = try? c.decodeIfPresent(StaffLocationEvidenceLimits.self, forKey: .locationEvidence)
    }
}

/// `CheckInState` [TEST-DB] (POST /attendance/check-in, GET
/// /attendance/me/shift/:shiftId/check-in). Arrival evidence only, never
/// worked time. Every instant is the server's.
struct StaffCheckInState: Decodable, Hashable, Sendable {
    struct Window: Decodable, Hashable, Sendable {
        let opensAt: Date?
        let closesAt: Date?

        enum CodingKeys: String, CodingKey { case opensAt, closesAt }

        init(opensAt: Date?, closesAt: Date?) {
            self.opensAt = opensAt
            self.closesAt = closesAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            opensAt = try? c.decodeIfPresent(Date.self, forKey: .opensAt)
            closesAt = try? c.decodeIfPresent(Date.self, forKey: .closesAt)
        }
    }

    let shiftId: String
    let checkInRequired: Bool
    let checkedInAt: Date?
    let checkInSource: String?
    let locationVerified: Bool
    let distanceM: Double?
    let accuracyM: Double?
    /// The venue needs location evidence. When false the app never asks
    /// for location (Flutter default: false when absent).
    let geofenceEnforced: Bool
    let window: Window?
    let clockedIn: Bool
    let alreadyCheckedIn: Bool
    let serverNow: Date?

    enum CodingKeys: String, CodingKey {
        case shiftId, checkInRequired, checkedInAt, checkInSource, locationVerified, distanceM, accuracyM
        case geofenceEnforced, window, clockedIn, alreadyCheckedIn, serverNow
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shiftId = try c.decode(String.self, forKey: .shiftId)
        checkInRequired = try c.decodeIfPresent(Bool.self, forKey: .checkInRequired) ?? false
        checkedInAt = try? c.decodeIfPresent(Date.self, forKey: .checkedInAt)
        checkInSource = try c.decodeIfPresent(String.self, forKey: .checkInSource)
        locationVerified = try c.decodeIfPresent(Bool.self, forKey: .locationVerified) ?? false
        distanceM = try c.decodeIfPresent(Double.self, forKey: .distanceM)
        accuracyM = try c.decodeIfPresent(Double.self, forKey: .accuracyM)
        geofenceEnforced = try c.decodeIfPresent(Bool.self, forKey: .geofenceEnforced) ?? false
        window = try? c.decodeIfPresent(Window.self, forKey: .window)
        clockedIn = try c.decodeIfPresent(Bool.self, forKey: .clockedIn) ?? false
        alreadyCheckedIn = try c.decodeIfPresent(Bool.self, forKey: .alreadyCheckedIn) ?? false
        serverNow = try? c.decodeIfPresent(Date.self, forKey: .serverNow)
    }

    var checkedIn: Bool { checkedInAt != nil }
    var opensAt: Date? { window?.opensAt }
    var closesAt: Date? { window?.closesAt }
}

/// `GET /attendance/me/shift/:shiftId/team` row: first name only (G7), no
/// identifiers, contact or pay.
struct StaffTeamMember: Decodable, Hashable, Sendable {
    let displayName: String
    let startsAt: Date
    let endsAt: Date
    let isYou: Bool
}

// MARK: - Request bodies

/// One device fix as sent with Check In / Clock In / Clock Out. The server
/// judges freshness, accuracy and the geofence; nothing here is ever used as
/// an attendance time.
struct StaffLocationFix: Equatable, Sendable {
    let lat: Double
    let lng: Double
    let accuracyM: Double
    /// Server anchor minus the fix's age (Flutter `LocationFix.fromPosition`):
    /// a wrong device clock cancels out of the age subtraction.
    let capturedAt: Date

    /// - Parameters:
    ///   - timestamp: when the device took the fix (device wall clock).
    ///   - trustedNow: the server-anchored clock; device time when unknown.
    ///   - deviceNow: the device wall clock now (same clock as `timestamp`).
    static func make(latitude: Double, longitude: Double, accuracy: Double, timestamp: Date, trustedNow: Date?, deviceNow: Date) -> StaffLocationFix {
        let age = max(0, deviceNow.timeIntervalSince(timestamp))
        return StaffLocationFix(
            lat: latitude,
            lng: longitude,
            accuracyM: accuracy,
            capturedAt: (trustedNow ?? deviceNow).addingTimeInterval(-age)
        )
    }
}

/// `POST /attendance/check-in`. Location is sent only when the venue
/// enforces its geofence; no QR on Check In (Flutter parity). nil fields are
/// omitted from the JSON (never `null`), so `forbidNonWhitelisted` is happy.
struct StaffCheckInBody: Encodable, Equatable {
    let shiftId: String
    let lat: Double?
    let lng: Double?
    let accuracyM: Double?
    let capturedAt: Date?

    init(shiftId: String, location: StaffLocationFix?) {
        self.shiftId = shiftId
        lat = location?.lat
        lng = location?.lng
        accuracyM = location?.accuracyM
        capturedAt = location?.capturedAt
    }
}

/// `POST /attendance/clock-in`: the scanned QR text verbatim (never parsed).
struct StaffClockInBody: Encodable, Equatable {
    let shiftId: String
    let qrToken: String
    let lat: Double?
    let lng: Double?
    let accuracyM: Double?
    let capturedAt: Date?

    init(shiftId: String, qrToken: String, location: StaffLocationFix?) {
        self.shiftId = shiftId
        self.qrToken = qrToken
        lat = location?.lat
        lng = location?.lng
        accuracyM = location?.accuracyM
        capturedAt = location?.capturedAt
    }
}

/// `POST /attendance/clock-out`. No `shiftId` (contract §2).
struct StaffClockOutBody: Encodable, Equatable {
    let qrToken: String
    let lat: Double?
    let lng: Double?
    let accuracyM: Double?
    let capturedAt: Date?

    init(qrToken: String, location: StaffLocationFix?) {
        self.qrToken = qrToken
        lat = location?.lat
        lng = location?.lng
        accuracyM = location?.accuracyM
        capturedAt = location?.capturedAt
    }
}

// MARK: - Notifications

/// `GET /notifications` row (only the fields the app shows).
struct StaffNotification: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let type: String
    let title: String
    let message: String
    let readAt: Date?
    let createdAt: Date

    var isUnread: Bool { readAt == nil }
}

struct StaffUnreadCount: Decodable, Sendable {
    let count: Int
}

// MARK: - Payroll (`/payroll/me/*`)

/// `{id?, start, end}` with London date-only days.
struct StaffPayPeriod: Decodable, Hashable, Sendable {
    let id: String?
    let start: CalendarDay
    let end: CalendarDay

    /// "12 – 25 Oct 2026" (Flutter `formatPayPeriod`).
    var label: String {
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        let left: String
        if start.year != end.year {
            left = "\(start.day) \(months[start.month - 1]) \(start.year)"
        } else if start.month != end.month {
            left = "\(start.day) \(months[start.month - 1])"
        } else {
            left = "\(start.day)"
        }
        return "\(left) – \(end.day) \(months[end.month - 1]) \(end.year)"
    }
}

/// `StaffShiftStatement` (`GET /payroll/me/statements`): one per
/// payroll-approved shift; figures are the approved values.
struct StaffShiftStatement: Decodable, Identifiable, Hashable, Sendable {
    struct Document: Decodable, Hashable, Sendable {
        /// processing | available | failed
        let state: String
        let fileId: String?
        let filename: String?
    }

    let payrollRecordId: String
    /// approved | processing | paid. Only `paid` is a payment.
    let status: String
    let shiftId: String
    let venueName: String
    let roleName: String
    let startsAt: Date
    let endsAt: Date
    let workedMinutes: Int?
    let payRatePence: Int64?
    let amountPence: Int64?
    let approvedAt: Date
    let payrollPeriod: StaffPayPeriod?
    /// Scheduled payday (date-only), nil while not allocated.
    let payday: CalendarDay?
    let allocationStatus: String?
    let statement: Document?

    var id: String { payrollRecordId }

    enum CodingKeys: String, CodingKey {
        case payrollRecordId, status, shiftId, venueName, roleName, startsAt, endsAt, workedMinutes
        case payRatePence, amountPence, approvedAt, payrollPeriod, payday, allocationStatus, statement
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        payrollRecordId = try c.decode(String.self, forKey: .payrollRecordId)
        status = try c.decode(String.self, forKey: .status)
        shiftId = try c.decode(String.self, forKey: .shiftId)
        venueName = try c.decode(String.self, forKey: .venueName)
        roleName = try c.decode(String.self, forKey: .roleName)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        workedMinutes = try c.decodeIfPresent(Int.self, forKey: .workedMinutes)
        payRatePence = try c.decodeIfPresent(Int64.self, forKey: .payRatePence)
        amountPence = try c.decodeIfPresent(Int64.self, forKey: .amountPence)
        approvedAt = try c.decode(Date.self, forKey: .approvedAt)
        payrollPeriod = try? c.decodeIfPresent(StaffPayPeriod.self, forKey: .payrollPeriod)
        payday = try c.decodeIfPresent(CalendarDay.self, forKey: .payday)
        allocationStatus = try c.decodeIfPresent(String.self, forKey: .allocationStatus)
        statement = try? c.decodeIfPresent(Document.self, forKey: .statement)
    }

    /// Document state; "processing" when the server sent none (Flutter).
    var statementState: String { statement?.state ?? "processing" }
    var documentFileId: String? { statementState == "available" ? statement?.fileId : nil }
    var isAvailable: Bool { documentFileId != nil }
}

struct StaffStatementsPage: Decodable, Sendable {
    let data: [StaffShiftStatement]
    let total: Int?
}

/// `StaffPayslipEntry` (`GET /payroll/me/payslips`). Figures are never
/// calculated in the app; `netPence` only ever comes from the provider
/// document.
struct StaffPayslip: Decodable, Identifiable, Hashable, Sendable {
    struct Document: Decodable, Hashable, Sendable {
        let fileId: String
        let filename: String?
    }

    let payslipId: String?
    let runId: String?
    let period: StaffPayPeriod
    let payday: CalendarDay
    /// upcoming | processing | available | paid
    let status: String
    let shiftCount: Int
    let grossPence: Int64
    let netPence: Int64?
    let document: Document?
    let paidAt: Date?

    var id: String { payslipId ?? "\(period.start)-\(payday)" }
    var hasDocument: Bool { document != nil }

    enum CodingKeys: String, CodingKey {
        case payslipId, runId, period, payday, status, shiftCount, grossPence, netPence, document, paidAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        payslipId = try c.decodeIfPresent(String.self, forKey: .payslipId)
        runId = try c.decodeIfPresent(String.self, forKey: .runId)
        period = try c.decode(StaffPayPeriod.self, forKey: .period)
        payday = try c.decode(CalendarDay.self, forKey: .payday)
        status = try c.decode(String.self, forKey: .status)
        shiftCount = try c.decodeIfPresent(Int.self, forKey: .shiftCount) ?? 0
        grossPence = try c.decodeIfPresent(Int64.self, forKey: .grossPence) ?? 0
        netPence = try c.decodeIfPresent(Int64.self, forKey: .netPence)
        document = try? c.decodeIfPresent(Document.self, forKey: .document)
        paidAt = try? c.decodeIfPresent(Date.self, forKey: .paidAt)
    }
}

struct StaffPayslipsResponse: Decodable, Sendable {
    let data: [StaffPayslip]
}

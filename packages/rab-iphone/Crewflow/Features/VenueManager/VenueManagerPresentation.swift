import Foundation
import SwiftUI

// Pure presentation rules for the Venue Manager screens: a read of server
// state, never an authorisation decision and never a clock-derived status.
// Ported from packages/rab-mobile/lib/features/venue_manager/* (function
// names kept so the two can be read side by side). Unit-tested in
// CrewflowTests/VenueManager.

// MARK: - Text helpers

enum VMText {
    private static let roleIdentifier = try! NSRegularExpression(
        pattern: #"^(?:Role-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#,
        options: [.caseInsensitive]
    )

    /// Flutter `displayRoleName`: a missing catalogue name is never shown as
    /// a database identifier.
    static func displayRoleName(_ name: String) -> String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(value.startIndex..., in: value)
        return value.isEmpty || roleIdentifier.firstMatch(in: value, range: range) != nil ? "Role unavailable" : value
    }

    /// "full_time" → "Full time" (formatting only).
    static func humanizeToken(_ value: String) -> String {
        let words = value.replacingOccurrences(of: #"[_-]+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return value }
        return first.uppercased() + words.dropFirst().lowercased()
    }

    static func yearsLabel(_ years: Int) -> String { years == 1 ? "1 year" : "\(years) years" }

    static func firstName(_ name: String) -> String {
        let parts = name.trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0.isWhitespace })
        return parts.first.map(String.init) ?? name
    }

    static let weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    /// "Tuesday and Sunday" in calendar order.
    static func formatWeekdayList<S: Sequence>(_ days: S) -> String where S.Element == String {
        let set = Set(days)
        let ordered = weekdays.filter(set.contains)
        guard ordered.count > 1 else { return ordered.joined() }
        return ordered.dropLast().joined(separator: ", ") + " and " + ordered[ordered.count - 1]
    }

    static func plural(_ count: Int, _ singular: String, _ pluralForm: String) -> String {
        count == 1 ? singular : pluralForm
    }
}

/// Words that carry a letter or digit: the same count the server applies to
/// on-behalf reasons ("- - -" is not a reason). Enablement only; the server
/// re-checks (`REASON_TOO_SHORT`).
func reasonWordCount(_ text: String) -> Int {
    text.split(whereSeparator: { $0.isWhitespace }).filter { word in
        word.unicodeScalars.contains { scalar in
            switch scalar.properties.generalCategory {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
                 .decimalNumber, .letterNumber, .otherNumber:
                return true
            default:
                return false
            }
        }
    }.count
}

// MARK: - Dates (Europe/London, like CrewflowDateFormat)

enum VMDate {
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = CrewflowDateFormat.displayTimeZone
        calendar.locale = CrewflowDateFormat.locale
        calendar.firstWeekday = 2
        return calendar
    }

    private static func formatter(_ pattern: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = CrewflowDateFormat.locale
        formatter.timeZone = CrewflowDateFormat.displayTimeZone
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = pattern
        return formatter
    }

    private static let weekdayDayYear = formatter("EEE d MMM yyyy")
    private static let weekdayDayTime = formatter("EEE d MMM, HH:mm")
    private static let weekdayDayYearTime = formatter("EEE d MMM yyyy, HH:mm")
    private static let clock12 = formatter("h:mm a")
    private static let monthYear = formatter("MMMM yyyy")

    static func hm(_ date: Date) -> String { CrewflowDateFormat.time(date) }
    /// "Sat 26 Apr 2025"
    static func weekdayDayYear(_ date: Date) -> String { weekdayDayYear.string(from: date) }
    /// "Sat 26 Apr, 18:00"
    static func weekdayDayTime(_ date: Date) -> String { weekdayDayTime.string(from: date) }
    /// "Sat 26 Apr 2025, 18:00"
    static func long(_ date: Date) -> String { weekdayDayYearTime.string(from: date) }
    /// "9:41 am"
    static func clock(_ date: Date) -> String { clock12.string(from: date) }
    static func monthTitle(_ date: Date) -> String { monthYear.string(from: date) }

    static func sameDay(_ a: Date, _ b: Date) -> Bool { calendar.isDate(a, inSameDayAs: b) }
    static func startOfDay(_ date: Date) -> Date { calendar.startOfDay(for: date) }

    /// Flutter `sentShiftTimeRange`: "18:00 - 02:00 (+1)".
    static func sentTimeRange(_ start: Date, _ end: Date) -> String {
        "\(hm(start)) - \(hm(end))\(sameDay(start, end) ? "" : " (+1)")"
    }

    /// Flutter `reportTimeRange`: "18:00–02:00 (+1)".
    static func reportTimeRange(_ start: Date, _ end: Date) -> String {
        "\(hm(start))–\(hm(end))\(sameDay(start, end) ? "" : " (+1)")"
    }

    /// Flutter `eventTime`: "18:00 – 02:00".
    static func eventTime(_ start: Date, _ end: Date) -> String { "\(hm(start)) – \(hm(end))" }

    /// Flutter `sentAgo`. A timestamp ahead of the device clock reads "just
    /// now". Display only.
    static func sentAgo(_ submittedAt: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(submittedAt)
        let minutes = Int(seconds / 60)
        let hours = Int(seconds / 3600)
        let days = Int(seconds / 86_400)
        if minutes < 1 { return "Sent just now" }
        if hours < 1 { return "Sent \(minutes)m ago" }
        if days < 1 { return "Sent \(hours)h ago" }
        if days < 7 { return "Sent \(days)d ago" }
        return "Sent \(CrewflowDateFormat.fullDay(submittedAt))"
    }

    static func greeting(for date: Date) -> String {
        let hour = calendar.component(.hour, from: date)
        return hour < 12 ? "morning" : (hour < 18 ? "afternoon" : "evening")
    }
}

/// Server time anchored to a monotonic clock (CLAUDE.md: never device time
/// for a running timer). `nil` when the server sent no `serverNow`.
struct VMServerClock: Equatable {
    let anchor: Date
    let uptimeAtAnchor: TimeInterval

    init?(serverNow: Date?, uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard let serverNow else { return nil }
        anchor = serverNow
        uptimeAtAnchor = uptime
    }

    func now(uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Date {
        anchor.addingTimeInterval(max(0, uptime - uptimeAtAnchor))
    }
}

// MARK: - Tones (Flutter SentShiftLook)

struct VMTone: Equatable {
    let label: String
    let card: RGBA
    let pill: RGBA
    let pillText: RGBA

    static let peach = VMTone(label: "", card: RGBA(argb: 0xFFFDEEE6), pill: RGBA(argb: 0xFFFCD9CF), pillText: RGBA(argb: 0xFFC2410C))
    static let mint = VMTone(label: "", card: RGBA(argb: 0xFFEAFBF1), pill: RGBA(argb: 0xFFC8F0D8), pillText: RGBA(argb: 0xFF18794E))
    static let blue = VMTone(label: "", card: RGBA(argb: 0xFFEAF2FD), pill: RGBA(argb: 0xFFCFE1FB), pillText: RGBA(argb: 0xFF1D4ED8))
    static let red = VMTone(label: "", card: RGBA(argb: 0xFFFDECEC), pill: RGBA(argb: 0xFFF9D2D2), pillText: RGBA(argb: 0xFFB42318))
    static let grey = VMTone(label: "", card: RGBA(argb: 0xFFF2F2F2), pill: RGBA(argb: 0xFFE2E2E2), pillText: RGBA(argb: 0xFF555555))
    static let neutral = VMTone(label: "", card: RGBA(argb: 0xFFFAF9F6), pill: RGBA(argb: 0xFFECEAE5), pillText: RGBA(argb: 0xFF555555))

    func labelled(_ text: String) -> VMTone { VMTone(label: text, card: card, pill: pill, pillText: pillText) }
}

/// Sent Shifts pill: a pure read of status / counters / offerCounts in the
/// server's `statusLabel` precedence. Never inferred from the clock.
func sentShiftLook(_ shift: SentShift) -> VMTone {
    if shift.actionExpired { return VMTone.grey.labelled("Expired") }
    switch shift.status {
    case "pending_manager_approval": return VMTone.peach.labelled("Pending approval")
    case "declined": return VMTone.red.labelled("Declined")
    case "cancelled": return VMTone.grey.labelled("Cancelled")
    case "completed": return VMTone.grey.labelled("Completed")
    default: break
    }
    if shift.counter("confirmed") { return VMTone.blue.labelled("Confirmed") }
    if shift.counter("accepted") { return VMTone.mint.labelled("Accepted") }
    if shift.count("pending") > 0 { return VMTone.peach.labelled("Pending") }
    if shift.count("declined") > 0 { return VMTone.red.labelled("Declined") }
    if shift.count("cancelled") > 0 { return VMTone.grey.labelled("Staff cancelled") }
    if shift.count("noShow") > 0 { return VMTone.grey.labelled("Staff no-show") }
    let sent = shift.count("sent")
    if sent > 0, shift.count("withdrawn") == sent { return VMTone.grey.labelled("Offers withdrawn") }
    if sent > 0, shift.count("rejected") == sent { return VMTone.grey.labelled("Offers rejected") }
    return VMTone.neutral.labelled("No active offers")
}

/// Event status pill (Event Details, Reports cards): the shift's real status.
func reportEventLook(_ status: String) -> VMTone {
    switch status {
    case "fully_filled": return VMTone.mint.labelled("Fully filled")
    case "confirmed": return VMTone.blue.labelled("Confirmed")
    case "in_progress": return VMTone.peach.labelled("In progress")
    case "partially_filled": return VMTone.peach.labelled("Partially filled")
    case "offered": return VMTone.blue.labelled("Offered")
    case "open": return VMTone.neutral.labelled("Open")
    case "pending_manager_approval": return VMTone.peach.labelled("Pending approval")
    case "declined": return VMTone.red.labelled("Declined")
    case "completed": return VMTone.grey.labelled("Completed")
    case "cancelled": return VMTone.grey.labelled("Cancelled")
    case "draft": return VMTone.neutral.labelled("Draft")
    default: return VMTone.neutral.labelled(status.replacingOccurrences(of: "_", with: " "))
    }
}

/// Reports / History card colours for the server lifecycle; the label is
/// the server's `displayLabel`.
func reportLifecycleLook(_ displayStatus: String, label: String) -> VMTone {
    switch displayStatus {
    case "waiting_clock_in", "upcoming": return VMTone.blue.labelled(label)
    case "in_progress", "waiting_clock_out": return VMTone.peach.labelled(label)
    case "needs_review", "delivery_failed": return VMTone.red.labelled(label)
    case "ready_to_finalise", "sent": return VMTone.mint.labelled(label)
    case "generating", "queued": return VMTone.blue.labelled(label)
    case "action_expired", "cancelled": return VMTone.grey.labelled(label)
    default: return VMTone.neutral.labelled(label)
    }
}

/// Reports card secondary marker.
func reportMarker(_ lifecycle: ReportLifecycle) -> String? {
    if lifecycle.needsAttendanceReview { return "Needs attendance review" }
    if lifecycle.needsAttention { return "Needs attention" }
    return nil
}

/// Offer status words for "Other responses".
func vmOfferLabel(_ status: String) -> String {
    switch status {
    case "pending": return "Pending"
    case "staff_accepted": return "Accepted"
    case "manager_confirmed": return "Confirmed"
    case "declined": return "Declined"
    case "expired": return "Expired"
    case "withdrawn": return "Withdrawn"
    case "manager_rejected": return "Rejected"
    default: return status.replacingOccurrences(of: "_", with: " ")
    }
}

func confirmedEventBadge(_ status: String) -> String {
    switch status {
    case "in_progress": return "Live now"
    case "partially_filled": return "Partially filled"
    default: return "Confirmed"
    }
}

/// Calendar legend status (display only).
enum VMCalendarStatus: Int, CaseIterable, Hashable {
    case confirmed, openRequest, partiallyFilled, filled, awaitingApproval, offered, live, complete, declined, cancelled, draft, other

    init(shiftStatus: String) {
        switch shiftStatus {
        case "open": self = .openRequest
        case "partially_filled": self = .partiallyFilled
        case "fully_filled": self = .filled
        case "confirmed": self = .confirmed
        case "offered": self = .offered
        case "pending_manager_approval": self = .awaitingApproval
        case "declined": self = .declined
        case "in_progress": self = .live
        case "completed": self = .complete
        case "cancelled": self = .cancelled
        case "draft": self = .draft
        default: self = .other
        }
    }

    var label: String {
        switch self {
        case .confirmed: return "Confirmed"
        case .openRequest: return "Open request"
        case .partiallyFilled: return "Partially filled"
        case .filled: return "Filled"
        case .awaitingApproval: return "Awaiting approval"
        case .offered: return "Offers sent"
        case .live: return "Live"
        case .complete: return "Complete"
        case .declined: return "Declined"
        case .cancelled: return "Cancelled"
        case .draft: return "Draft"
        case .other: return "Updating"
        }
    }

    var dot: Color {
        switch self {
        case .confirmed, .filled: return RGBA(argb: 0xFF3B6FD8).color
        case .openRequest, .partiallyFilled, .awaitingApproval, .offered: return RGBA(argb: 0xFF2BA77A).color
        case .live: return RGBA(argb: 0xFF087B5D).color
        default: return ScheduleTokens.muted
        }
    }
}

// MARK: - Confirmed staff / roster

/// One confirmed seat of ONE shift (Flutter `ConfirmedStaffMember`).
struct ConfirmedStaffMember: Hashable, Identifiable {
    let staffProfileId: String
    let name: String
    let role: String
    /// confirmed | completed | no_show; nil when only the offer is known.
    let assignmentStatus: String?
    /// The seat's report row; nil without `report.view`.
    let row: ShiftReportStaffRow?

    var id: String { staffProfileId }
    var isNoShow: Bool { assignmentStatus == "no_show" }

    /// Booking badge: the booking itself. A worker-flagged no-show is
    /// provisional ("Attendance missing") until the manager confirms it.
    var bookingLabel: String {
        guard isNoShow else { return "Confirmed" }
        return row?.noShowConfirmed == true ? "No-show" : "Attendance missing"
    }

    var bookingTone: (background: Color, foreground: Color) {
        if !isNoShow { return (ShiftVisualStyle.mint.badgeSurface, ShiftVisualStyle.mint.badgeText) }
        if row?.noShowConfirmed == true { return (ScheduleTokens.dangerSoft, ScheduleTokens.errorText) }
        return (VMColor.amberSurface, VMColor.amberText)
    }

    static func from(_ row: ShiftReportStaffRow) -> ConfirmedStaffMember {
        ConfirmedStaffMember(staffProfileId: row.staffProfileId, name: row.staffName,
                             role: VMText.displayRoleName(row.roleName), assignmentStatus: row.assignmentStatus, row: row)
    }

    static func from(_ offer: VMOffer) -> ConfirmedStaffMember {
        ConfirmedStaffMember(staffProfileId: offer.staffProfileId, name: offer.staffName,
                             role: VMText.displayRoleName(offer.roleName), assignmentStatus: nil, row: nil)
    }
}

struct ShiftRoster: Hashable {
    let members: [ConfirmedStaffMember]
    let report: ShiftReportDetail?

    /// No-shows are listed but not counted as confirmed.
    var confirmedCount: Int { members.filter { !$0.isNoShow }.count }
    var hasAttendance: Bool { report != nil }

    /// Latest confirmed offer per staff member of THIS shift only.
    static func fromOffers(shiftId: String, offers: [VMOffer]) -> ShiftRoster {
        var seen = Set<String>()
        var members: [ConfirmedStaffMember] = []
        for offer in offers where offer.shiftId == shiftId && offer.status == "manager_confirmed" {
            if seen.insert(offer.staffProfileId).inserted { members.append(.from(offer)) }
        }
        members.sort { $0.name < $1.name }
        return ShiftRoster(members: members, report: nil)
    }

    static func fromReport(_ report: ShiftReportDetail) -> ShiftRoster {
        ShiftRoster(members: report.staff.map(ConfirmedStaffMember.from), report: report)
    }
}

/// Every recipient of a request who is not a confirmed seat, with their
/// latest offer's state (Sent shift "Other responses").
func otherResponses(shiftId: String, offers: [VMOffer], roster: ShiftRoster) -> [(name: String, label: String)] {
    let seated = Set(roster.members.map(\.staffProfileId))
    var latest: [String: VMOffer] = [:]
    for offer in offers where offer.shiftId == shiftId {
        if let previous = latest[offer.staffProfileId], previous.sentAt >= offer.sentAt { continue }
        latest[offer.staffProfileId] = offer
    }
    return latest.values
        .filter { !seated.contains($0.staffProfileId) }
        .map { offer -> (name: String, label: String) in
            // A confirmed offer without a confirmed seat: the booking was
            // later cancelled. Never shown as "Confirmed".
            let label = offer.status == "manager_confirmed" && roster.hasAttendance ? "No longer booked" : vmOfferLabel(offer.status)
            return (name: offer.staffName, label: label)
        }
        .sorted { $0.name < $1.name }
}

/// Confirmed staff card attendance line, from real report data only. A
/// provisional no-show is "Attendance missing", never "No-show recorded"
/// (BACKEND_DEPENDENCIES B8). nil when attendance is unknown.
func vmAttendanceLine(_ row: ShiftReportStaffRow?) -> String? {
    guard let r = row else { return nil }
    if r.isNoShow { return r.noShowConfirmed ? "No-show confirmed" : "Attendance missing · Needs review" }
    if r.isOpen {
        let since = r.clockInAt.map { " \(VMDate.hm($0))" } ?? ""
        return r.attendanceStatus == "on_break" ? "On break · clocked in\(since)" : "Clocked in\(since)"
    }
    if let out = r.clockOutAt {
        let range = r.clockInAt.map { "\(VMDate.hm($0))–\(VMDate.hm(out))" } ?? VMDate.hm(out)
        return r.attendanceReviewed ? "Reviewed · \(range)" : "Clocked out \(VMDate.hm(out)) · Awaiting review"
    }
    if let inAt = r.clockInAt { return "Clocked in \(VMDate.hm(inAt)) · Clock-out missing" }
    if r.attendanceId == nil { return "Attendance not recorded" }
    return r.statusLabel
}

// MARK: - Shift report badges and notices

enum ReportBadgeTone: Equatable {
    case waiting, needsReview, reviewed, neutral, info, awaiting

    var colors: (background: Color, foreground: Color) {
        switch self {
        case .waiting: return (RGBA(argb: 0xFFE2E4FF).color, RGBA(argb: 0xFF4A4FBF).color)
        case .needsReview: return (RGBA(argb: 0xFFFFDDE0).color, RGBA(argb: 0xFFC0263B).color)
        case .reviewed: return (RGBA(argb: 0xFFD9F6E1).color, RGBA(argb: 0xFF1E7B3C).color)
        case .neutral: return (RGBA(argb: 0xFFEDEEF1).color, RGBA(argb: 0xFF4B5563).color)
        case .info: return (RGBA(argb: 0xFFDDEBFB).color, RGBA(argb: 0xFF1D4ED8).color)
        case .awaiting: return (RGBA(argb: 0xFFF3E4D0).color, RGBA(argb: 0xFF8A5A2B).color)
        }
    }
}

struct ReportBadgeState: Equatable {
    let label: String
    let tone: ReportBadgeTone
}

/// Staff badge from persisted server state only (Flutter
/// `staffReportBadge`). Missing attendance — including the worker's
/// PROVISIONAL no-show — is "Attendance missing · Needs review", never a
/// no-show; only a manager-confirmed no-show is "No-show · Confirmed".
func staffReportBadge(_ r: ShiftReportStaffRow, ended: Bool, finalised: Bool = false) -> ReportBadgeState {
    if finalised { return ReportBadgeState(label: "Finalised", tone: .neutral) }
    if r.isOpen { return ReportBadgeState(label: r.attendanceStatus == "on_break" ? "On break" : "Clocked in", tone: .info) }
    if r.noShowConfirmed { return ReportBadgeState(label: "No-show · Confirmed", tone: .reviewed) }
    if r.attendanceMissing, ended || r.isNoShow {
        return ReportBadgeState(label: "Attendance missing · Needs review", tone: .needsReview)
    }
    if r.attendanceReviewed, r.clockOutAt != nil { return ReportBadgeState(label: "Reviewed", tone: .reviewed) }
    if r.clockOutAt == nil, r.attendanceStatus == "missing_clock_out" || ended {
        return ReportBadgeState(label: "Needs review", tone: .needsReview)
    }
    if r.clockInAt == nil { return ReportBadgeState(label: "Waiting", tone: .waiting) }
    if r.clockOutAt != nil {
        return ReportBadgeState(label: r.corrected ? "Corrected · Awaiting review" : "Awaiting review", tone: .awaiting)
    }
    return ReportBadgeState(label: "Clocked in", tone: .info)
}

/// Whether the scheduled end has passed, by SERVER time: the lifecycle was
/// computed against DB `now()`. Without a lifecycle the report's own
/// `serverNow` decides; with neither, "not ended" (never the device clock).
func reportEnded(_ report: ShiftReportDetail) -> Bool {
    if let status = report.lifecycle?.displayStatus {
        return !["upcoming", "waiting_clock_in", "in_progress"].contains(status)
    }
    if let now = report.serverNow { return now >= report.endsAt }
    return false
}

/// The notice under the report summary, from the server lifecycle + counts.
func reportNotice(_ report: ShiftReportDetail) -> (title: String, message: String?)? {
    let missing = report.missingClockOut
    let n = report.staff.count
    switch report.lifecycle?.displayStatus {
    case "upcoming", "waiting_clock_in":
        return ("Waiting staff to Clock-in", "Download the Time-sheet for staff to Clock-in")
    case "in_progress":
        return ("Shift in progress", "\(report.clockedIn) of \(n) staff clocked in")
    case "waiting_clock_out":
        let still = report.stillClockedIn
        return ("Waiting for staff to clock out", "\(still) \(VMText.plural(still, "staff member is", "staff are")) still clocked in")
    case "needs_review":
        if missing == 0 {
            let left = report.reviewsRemaining
            return ("\(left) attendance \(VMText.plural(left, "review", "reviews")) remaining",
                    "Check each staff member's hours and mark them reviewed before finalising.")
        }
        return ("\(missing) clock-out \(VMText.plural(missing, "time needs", "times need")) checking",
                "Review staff hours before finalising this report.")
    case "action_expired":
        if report.lifecycle?.needsAttendanceReview == true, missing > 0 {
            return ("Action expired · needs attendance review",
                    "\(missing) clock-out \(VMText.plural(missing, "time still needs", "times still need")) checking before this report can be finalised.")
        }
        return ("Action expired", "This shift ended more than 5 hours ago. Finalise and send the timesheet.")
    case "generating":
        return ("Generating the final timesheet", "The signed PDF is being prepared.")
    case "queued":
        return ("Queued for delivery", "The final timesheet will be emailed shortly.")
    case "delivery_failed":
        return ("Delivery failed", "The final timesheet email could not be delivered. Download the PDF from Time-sheet.")
    case "cancelled":
        return ("Shift cancelled", nil)
    default:
        return nil
    }
}

extension ShiftReportDetail {
    /// Why Finalise & send is unavailable, most blocking first, from server
    /// data only. nil when finalisable or finalised.
    var finaliseBlockedReason: String? {
        if isFinalised || finalisable { return nil }
        if staff.isEmpty { return "No confirmed staff on this shift" }
        let open = stillClockedIn
        if open > 0 { return "\(open) \(VMText.plural(open, "staff member is", "staff are")) still clocked in" }
        let missing = staff.filter { !$0.isNoShow && $0.clockInAt != nil && $0.clockOutAt == nil }.count
        if missing > 0 { return "\(missing) clock-out \(VMText.plural(missing, "time", "times")) missing" }
        let notIn = staff.filter { !$0.isNoShow && $0.attendanceId == nil }.count
        if notIn > 0 { return "\(notIn) \(VMText.plural(notIn, "staff member has", "staff have")) no attendance yet" }
        if reviewsRemaining > 0 {
            return "\(reviewsRemaining) attendance \(VMText.plural(reviewsRemaining, "review", "reviews")) remaining"
        }
        return nil
    }
}

/// "7h 30m" from the SERVER's `workedMinutes` (never computed here).
func vmWorkedLabel(_ r: ShiftReportStaffRow) -> String {
    if let m = r.workedMinutes { return m % 60 == 0 ? "\(m / 60)h" : "\(m / 60)h \(m % 60)m" }
    if r.assignmentStatus == "no_show" { return "—" }
    return r.clockInAt == nil || r.clockOutAt != nil ? "—" : "Awaiting clock-out"
}

/// Final timesheet delivery pill (`deliveryState`, from the email outbox).
func deliveryBadge(_ state: String) -> (label: String, tone: ReportBadgeTone, systemImage: String?) {
    switch state {
    case "sent": return ("Sent", .reviewed, "checkmark")
    case "queued": return ("Queued for delivery", .info, nil)
    case "generating": return ("Generating PDF", .info, nil)
    case "failed", "no_recipients": return ("Delivery failed", .needsReview, nil)
    default: return ("Finalising", .info, nil)
    }
}

/// Sign & send is enabled only with the break confirmation, a 2+ character
/// name and the SERVER's readiness (`actions.finalise == enabled`, else
/// `finalisable`). Never computed from the client clock.
enum FinaliseGate {
    static func serverReady(_ report: ShiftReportDetail) -> Bool {
        if report.isFinalised { return false }
        return report.actions?.canFinalise ?? report.canFinalise
    }

    static func canSign(_ report: ShiftReportDetail, breaksConfirmed: Bool, name: String) -> Bool {
        breaksConfirmed && name.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 && serverReady(report)
    }
}

// MARK: - Teams (on-behalf punches)

enum TeamChipTone: Equatable { case ok, warning, danger, neutral }

/// One seat's chip, from the report row only (never guessed).
func teamRowState(_ r: ShiftReportStaffRow) -> (label: String, tone: TeamChipTone) {
    if r.isNoShow { return r.noShowConfirmed ? ("No-show", .danger) : ("Attendance missing", .warning) }
    if let out = r.clockOutAt { return ("Clocked out \(VMDate.hm(out))", .neutral) }
    if r.isOpen {
        if r.attendanceStatus == "on_break" { return ("On break", .ok) }
        return (r.clockInAt.map { "Clocked in \(VMDate.hm($0))" } ?? "Clocked in", .ok)
    }
    if r.attendanceId != nil { return (r.statusLabel, .neutral) }
    if let checked = r.checkedInAt { return ("Checked in \(VMDate.hm(checked))", .ok) }
    return ("Not checked in", .warning)
}

enum TeamRowAction: Equatable { case clockIn, clockOut }

/// The on-behalf action a row OFFERS (display hint): needs `attendance.edit`;
/// never on a finalised report, a no-show seat or a seat with attendance.
func teamRowAction(_ r: ShiftReportStaffRow, canEdit: Bool, finalised: Bool) -> TeamRowAction? {
    guard canEdit, !finalised else { return nil }
    if r.isOpen { return .clockOut }
    if r.attendanceId == nil, !r.isNoShow { return .clockIn }
    return nil
}

/// A refusal explained WITHOUT sending anything (Flutter `_blocked`).
struct OnBehalfBlock: Equatable {
    let panelTitle: String
    let panelMessage: String
    /// Offer "Review staff report" (Record attendance) as the way forward.
    let offersReport: Bool
}

/// Known refusals, decided from the report row + `attendancePolicy` (display
/// hints; the server enforces the same rules and remains the authority).
func onBehalfPrecheck(_ r: ShiftReportStaffRow, action: TeamRowAction, policy: ReportAttendancePolicy?) -> OnBehalfBlock? {
    let first = VMText.firstName(r.staffName)
    switch action {
    case .clockIn:
        if !r.checkedIn {
            return OnBehalfBlock(panelTitle: "Staff hasn't checked in yet",
                                 panelMessage: "\(first) must check in before you can clock them in.", offersReport: false)
        }
        if policy?.geofenceEnforced == true, !r.checkInLocationVerified {
            return OnBehalfBlock(
                panelTitle: "Check-in not location-verified",
                panelMessage: "This venue requires location, and \(first)'s check-in was not location-verified. Ask them to clock in on their phone, or record their attendance in the shift report.",
                offersReport: false
            )
        }
        return nil
    case .clockOut:
        if let policy, !policy.onBehalfClockOutAllowed {
            return OnBehalfBlock(
                panelTitle: "Clock-out on behalf isn't available here",
                panelMessage: "This venue requires location for clock-out, which a manager can't provide. Ask \(first) to clock out on their phone, or record the clock-out after the shift in Review staff report → Record attendance.",
                offersReport: true
            )
        }
        return nil
    }
}

/// Confirm is enabled only with enough words (the server re-checks).
func onBehalfReasonAccepted(_ reason: String, policy: ReportAttendancePolicy?) -> Bool {
    reasonWordCount(reason) >= (policy?.onBehalfReasonMinWords ?? 10)
}

/// Manager wording for structured attendance codes (Flutter
/// `AttendanceMessages.forManager`): the server's user-facing text first,
/// else the code's wording, else the one normaliser.
enum VMAttendanceMessages {
    static let manager: [String: String] = [
        "STAFF_NOT_CHECKED_IN": "Staff hasn't checked in yet. They must check in before you can clock them in.",
        "PRESENCE_NOT_VERIFIED": "This venue requires location, and the staff member's check-in was not location-verified. Ask them to clock in on their phone, or record their attendance in the shift report.",
        "PRESENCE_EVIDENCE_REQUIRED": "This venue requires location for clock-out, which a manager cannot provide. Ask the staff member to clock out on their phone, or record the clock-out in Review staff report → Record attendance once the shift has ended.",
        "REASON_TOO_SHORT": "Add a reason of at least 10 words.",
        "ALREADY_CLOCKED_IN": "This staff member has already clocked in.",
        "NOT_CLOCKED_IN": "This staff member is not clocked in.",
        "ATTENDANCE_FLAGGED_MISSING": "This staff member's attendance was flagged as missing. Record their attendance in the shift report instead.",
        "SHIFT_NOT_CONFIRMED": "This staff member is not confirmed for this shift.",
        "SHIFT_NOT_OPEN": "This shift is not open for attendance.",
        "CLOCK_IN_TOO_EARLY": "It is too early to clock in for this shift.",
        "CLOCK_WINDOW_CLOSED": "This shift's clock-in/out window has closed.",
        "GEOFENCE_MISCONFIGURED": "This venue's location check isn't set up correctly. Update the venue's location settings.",
    ]

    static func forManager(_ error: Error) -> String {
        if let api = error as? APIError, let code = api.code, let mapped = manager[code], api.statusCode < 500 {
            return api.payload?.userFacingMessage ?? mapped
        }
        return userMessage(for: error)
    }

    /// The refusal that should send the manager to Record attendance.
    static func guidesToRecordAttendance(_ error: Error) -> Bool {
        (error as? APIError)?.code == "PRESENCE_EVIDENCE_REQUIRED"
    }
}

/// Text shown when a non-repeatable action's result is unknown (timeout,
/// connection lost, 5xx): the screen reloads and NEVER resends.
enum VMUncertain {
    static let message = "We couldn't confirm whether this was saved. The latest state has been reloaded — check it before trying again."
}

// MARK: - Directory

enum VMDirectory {
    struct Option: Hashable {
        let key: String?
        let label: String
    }

    static let employmentFilters: [Option] = [
        Option(key: nil, label: "All"), Option(key: "active", label: "Active"),
        Option(key: "pending_compliance", label: "Pending compliance"),
        Option(key: "inactive", label: "Inactive"), Option(key: "suspended", label: "Suspended"),
    ]

    static let tagChips: [Option] = [
        Option(key: nil, label: "All"), Option(key: "favourite", label: "Favourite"), Option(key: "emergency", label: "Emergency"),
    ]

    static func employmentLabel(_ status: String?) -> String? {
        employmentFilters.first { $0.key == status }?.label
    }

    static let notAssignedMessage = "This staff member is no longer assigned to you"

    static func isNotAssigned(_ error: Error) -> Bool { (error as? APIError)?.statusCode == 404 }

    /// Flutter `staffErrorMessage`. 404 means the assignment ended.
    static func errorMessage(_ error: Error, viewing: Bool) -> String {
        if let api = error as? APIError {
            if api.statusCode == 404 { return notAssignedMessage }
            if api.statusCode == 403 {
                return viewing ? "You do not have permission to view this staff member." : "You do not have permission to change staff tags."
            }
            if api == .offline || api.isTransient { return api.userMessage }
        } else {
            return userMessage(for: error, fallback: viewing ? "Unable to load this staff profile. Please try again." : "Unable to update this staff member. Please try again.")
        }
        return viewing ? "Unable to load this staff profile. Please try again." : "Unable to update this staff member. Please try again."
    }

    /// Applies the server-confirmed tags to the visible rows: a row that no
    /// longer matches the active tag filter leaves the list.
    static func replacing(_ users: [DirectoryUser], total: Int, with next: DirectoryUser, tag: String?) -> (users: [DirectoryUser], total: Int) {
        var rows = users
        var count = total
        let matches = tag == nil || (tag == "favourite" && next.isFavourite) || (tag == "emergency" && next.isEmergency)
        if let index = rows.firstIndex(where: { $0.id == next.id }) {
            if matches {
                rows[index] = next
            } else {
                rows.remove(at: index)
                count = max(count - 1, 0)
            }
        }
        return (rows, count)
    }

    /// Selection cap (UX guard only, never the authorisation boundary).
    static let selectionLimit = 100

    static func emptyTitle(filtered: Bool, tag: String?) -> String {
        if filtered { return "No staff match your search." }
        switch tag {
        case "favourite": return "No favourite staff yet."
        case "emergency": return "No emergency cover staff yet."
        default: return "No staff assigned to you yet"
        }
    }
}

// MARK: - Sent shifts

enum VMSentViews {
    struct Tab: Hashable {
        let key: String
        let label: String
    }

    static let all: [Tab] = [
        Tab(key: "all", label: "All"), Tab(key: "pending", label: "Pending"), Tab(key: "accepted", label: "Accepted"),
        Tab(key: "confirmed", label: "Confirmed"), Tab(key: "declined", label: "Declined"), Tab(key: "expired", label: "Expired"),
    ]

    /// Summary cards: Sent = live requests whose offers reached staff (one
    /// awaiting approval is not "sent"); Accepted/Confirmed = server counts.
    static func summary(sentShifts: [SentShift], counts: [String: Int]) -> (sent: Int, accepted: Int, confirmed: Int) {
        (sentShifts.filter { $0.counter("sent") }.count, counts["accepted"] ?? 0, counts["confirmed"] ?? 0)
    }

    static func chipLabel(_ key: String, label: String, counts: [String: Int]) -> String {
        "\(label) \(counts[key] ?? 0)"
    }

    static func sentLine(_ shift: SentShift) -> String {
        let sent = shift.count("sent")
        return sent == 0 ? "Not sent yet" : "Sent to \(sent) staff"
    }

    static func matches(_ shift: SentShift, query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty || "\(shift.venueName) \(shift.roleName)".lowercased().contains(q)
    }
}

// MARK: - Colours used only by these screens

enum VMColor {
    static let navy = RGBA(argb: 0xFF0F172A).color
    static let reportNavy = RGBA(argb: 0xFF13233A).color
    static let reportPage = RGBA(argb: 0xFFF5F6F8).color
    static let reportInk = RGBA(argb: 0xFF111827).color
    static let reportMuted = RGBA(argb: 0xFF6B7280).color
    static let divider = RGBA(argb: 0xFFE6E7EB).color
    static let rowBorder = RGBA(argb: 0xFFECEAE5).color
    static let avatarFill = RGBA(argb: 0xFFEDEBE6).color
    static let amberSurface = RGBA(argb: 0xFFFFE9C7).color
    static let amberText = RGBA(argb: 0xFF8A4B00).color
    static let noticeSurface = RGBA(argb: 0xFFFFF0DA).color
    static let noticeText = RGBA(argb: 0xFF8A4B08).color
    static let missingText = RGBA(argb: 0xFFB45309).color
    static let favourite = RGBA(argb: 0xFFE11D48).color
    static let emergency = RGBA(argb: 0xFFB45309).color
    static let countdownMint = RGBA(argb: 0xFFE5F5EE).color
    static let countdownGreen = RGBA(argb: 0xFF087B5D).color
    static let countdownPink = RGBA(argb: 0xFFF8E8E8).color
    static let countdownRed = RGBA(argb: 0xFFAD2525).color
    static let nextEvent = RGBA(argb: 0xFFF8ECE1).color
    static let errorPanel = RGBA(argb: 0xFFFDECEC).color
    static let errorPanelBorder = RGBA(argb: 0xFFF3C7C7).color
    static let disabledFill = RGBA(argb: 0xFFE3E5EA).color
    static let disabledInk = RGBA(argb: 0xFF9AA0A8).color
}

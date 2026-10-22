import Foundation

// Pure presentation rules for the Staff app, ported from the Flutter staff
// app (packages/rab-mobile/lib/features/...). None of these change an offer,
// assignment or attendance; they only read server projections. Kept free of
// SwiftUI so they are unit-tested directly (CrewflowTests/Staff).

// MARK: - Server clock

/// The trusted clock: the last `serverNow` the API returned, advanced by a
/// MONOTONIC clock (never the device wall clock). A running timer renders
/// `trustedNow − clockInAt` (CLAUDE.md non-negotiable), so changing the phone's
/// clock can neither fake progress nor inflate hours.
struct StaffServerClock: Equatable {
    private(set) var serverNow: Date?
    private(set) var anchorNanos: UInt64 = 0

    /// Darwin `CLOCK_MONOTONIC` keeps counting while the device sleeps and is
    /// unaffected by wall-clock changes.
    static func systemMonotonicNanos() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_MONOTONIC)
    }

    mutating func anchor(_ date: Date?, monotonicNanos: UInt64) {
        guard let date else { return }
        serverNow = date
        anchorNanos = monotonicNanos
    }

    func now(monotonicNanos: UInt64) -> Date? {
        guard let serverNow else { return nil }
        let elapsed = monotonicNanos >= anchorNanos ? Double(monotonicNanos - anchorNanos) / 1_000_000_000 : 0
        return serverNow.addingTimeInterval(elapsed)
    }
}

// MARK: - Formatting (Europe/London, see CrewflowDateFormat's flagged assumption)

enum StaffFormat {
    static var london: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = CrewflowDateFormat.displayTimeZone
        calendar.locale = CrewflowDateFormat.locale
        calendar.firstWeekday = 2 // Monday (en_GB)
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

    private static let weekdayShortDate = formatter("EEE dd/MM/yy")
    private static let shortDate = formatter("dd/MM/yy")
    private static let weekdayDayMonthYear = formatter("EEE d MMM yyyy")
    private static let longWeekdayDayMonth = formatter("EEEE, d MMMM")
    private static let fullSpoken = formatter("EEEE d MMMM yyyy")
    private static let monthYearLong = formatter("MMMM yyyy")
    private static let weekdayInitial = formatter("EEE")
    private static let longDate = formatter("EEE d MMMM yyyy")

    /// "Tue 21/10/26"
    static func weekdayShort(_ date: Date) -> String { weekdayShortDate.string(from: date) }
    /// "21/10/26"
    static func short(_ date: Date) -> String { shortDate.string(from: date) }
    /// "Tue 21 Oct 2026"
    static func weekdayDayYear(_ date: Date) -> String { weekdayDayMonthYear.string(from: date) }
    /// "Tuesday, 21 October"
    static func dayHeading(_ date: Date) -> String { longWeekdayDayMonth.string(from: date) }
    /// "Tuesday 21 October 2026" (VoiceOver)
    static func spoken(_ date: Date) -> String { fullSpoken.string(from: date) }
    /// "October 2026"
    static func monthYear(_ date: Date) -> String { monthYearLong.string(from: date) }
    /// "Tue"
    static func weekday(_ date: Date) -> String { weekdayInitial.string(from: date) }
    /// "Tue 21 October 2026"
    static func longDay(_ date: Date) -> String { longDate.string(from: date) }

    /// "09:00 – 17:00" (Flutter's en-dash form; no +1 day marker).
    static func timeSpan(_ start: Date, _ end: Date) -> String {
        "\(CrewflowDateFormat.time(start)) – \(CrewflowDateFormat.time(end))"
    }

    /// " (+1d)" when the end falls on a later London day (calendar card).
    static func nextDaySuffix(_ start: Date, _ end: Date) -> String {
        let calendar = london
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: start), to: calendar.startOfDay(for: end)).day ?? 0
        return days > 0 ? " (+\(days)d)" : ""
    }

    /// HH:MM:SS with zero padding; hours may exceed 24.
    static func clock(_ seconds: Int) -> String {
        let value = max(0, seconds)
        return String(format: "%02d:%02d:%02d", value / 3600, (value / 60) % 60, value % 60)
    }

    /// "7h 05m" (History).
    static func hours(_ minutes: Int) -> String {
        "\(minutes / 60)h " + String(format: "%02d", minutes % 60) + "m"
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// A date-only payroll day, formatted without any time-zone shift.
    /// "24 Oct" or, with `year`, "24 Oct 2026".
    static func day(_ day: CalendarDay, year: Bool = false) -> String {
        let base = "\(day.day) \(months[day.month - 1])"
        return year ? "\(base) \(day.year)" : base
    }

    /// Greeting from the trusted clock in London (display only).
    static func greeting(at date: Date) -> String {
        let hour = london.component(.hour, from: date)
        if hour < 12 { return "morning" }
        return hour < 18 ? "afternoon" : "evening"
    }

    static func initials(first: String, last: String) -> String {
        let f = first.trimmingCharacters(in: .whitespaces).first.map(String.init) ?? ""
        let l = last.trimmingCharacters(in: .whitespaces).first.map(String.init) ?? ""
        return (f + l).uppercased()
    }

    /// Whole seconds between two instants, truncated toward zero (Dart `inSeconds`).
    static func seconds(from start: Date, to end: Date) -> Int {
        Int(end.timeIntervalSince(start).rounded(.towardZero))
    }
}

// MARK: - Shift lifecycle (Flutter staff_shift_lifecycle.dart, todays_shift.dart, home_dashboard_data.dart)

enum StaffShiftRules {
    /// Confirmed shifts that are still "current": upcoming, today's or live.
    /// A live shift stays even after its scheduled end (still clocked in).
    static func isCurrentConfirmed(_ offer: StaffOfferSummary, now: Date) -> Bool {
        guard offer.status == StaffStatus.managerConfirmed else { return false }
        if let state = offer.presentation?.state {
            return state == "confirmed" || state == "live"
        }
        // Older servers without a presentation: fall back to the scheduled end.
        return now < offer.endsAt
    }

    /// Live first, then by scheduled start.
    static func currentConfirmed(_ offers: [StaffOfferSummary], now: Date) -> [StaffOfferSummary] {
        offers.filter { isCurrentConfirmed($0, now: now) }.sorted { a, b in
            let aLive = a.presentation?.state == "live" ? 0 : 1
            let bLive = b.presentation?.state == "live" ? 0 : 1
            if aLive != bLive { return aLive < bLive }
            return a.startsAt < b.startsAt
        }
    }

    /// Offers list: pending + awaiting confirmation, by start.
    static func openOffers(_ offers: [StaffOfferSummary]) -> [StaffOfferSummary] {
        offers.filter { $0.status == StaffStatus.pending || $0.status == StaffStatus.staffAccepted }
            .sorted { $0.startsAt < $1.startsAt }
    }

    /// "Today's shift": the server's `isToday && confirmed` projection, or for
    /// an older server the London calendar day / an in-progress window (so an
    /// overnight shift still counts after midnight).
    static func todaysConfirmedOffer(_ offers: [StaffOfferSummary], now: Date) -> StaffOfferSummary? {
        let calendar = StaffFormat.london
        for offer in offers where offer.status == StaffStatus.managerConfirmed {
            if let presentation = offer.presentation {
                if presentation.isToday && presentation.state == "confirmed" { return offer }
                continue
            }
            let sameDay = calendar.isDate(offer.startsAt, inSameDayAs: now)
            let inProgress = now >= offer.startsAt && now < offer.endsAt
            if sameDay || inProgress { return offer }
        }
        return nil
    }

    /// Card badge on Offers / Confirmed.
    static func offerBadge(_ offer: StaffOfferSummary) -> String {
        switch offer.status {
        case StaffStatus.managerConfirmed:
            return offer.presentation?.state == "live" ? "Live now" : "Confirmed"
        case StaffStatus.staffAccepted:
            return "Awaiting confirmation"
        default:
            return "New Offer"
        }
    }

    /// Replacement / standby tag, ONLY from the server's `offerKind`.
    /// ASSUMPTION (flagged, owner decision D4): wording "Replacement shift" /
    /// "Standby"; the standby line repeats the server's own notification text.
    static func offerKindTag(_ offer: StaffOfferSummary) -> (title: String, detail: String?)? {
        if offer.offerKind == StaffStatus.replacement { return ("Replacement shift", nil) }
        if offer.offerKind == StaffStatus.standby {
            return ("Standby", "You will only be booked if a place becomes free.")
        }
        return nil
    }
}

/// Home dashboard projection (never fetches or mutates).
struct StaffHomeDashboard {
    let today: StaffOfferSummary?
    let primary: StaffOfferSummary?
    let pending: Int
    let confirmed: Int
    let upcoming: [StaffOfferSummary]

    init(offers: [StaffOfferSummary], now: Date) {
        today = StaffShiftRules.todaysConfirmedOffer(offers, now: now)
        pending = offers.filter { $0.status == StaffStatus.pending }.count
        // Same rule as the Confirmed page: finished shifts have moved to History.
        confirmed = StaffShiftRules.currentConfirmed(offers, now: now).count
        upcoming = offers.filter { $0.status == StaffStatus.managerConfirmed && $0.startsAt > now }
            .sorted { $0.startsAt < $1.startsAt }
        let live = offers.first { $0.presentation?.state == "live" }
        let todays = offers.filter { $0.presentation?.state == "confirmed" && $0.presentation?.isToday == true }
            .sorted { $0.startsAt < $1.startsAt }
        let post = offers.filter { ["clockedOut", "complete"].contains($0.presentation?.state ?? "") }
            .sorted { $0.endsAt > $1.endsAt }
        primary = live ?? todays.first ?? post.first ?? today ?? upcoming.first
    }
}

/// The Home "clock" tile (lavender). Every branch is a distinct real state.
struct StaffHomeClockTile: Equatable {
    let label: String
    let enabled: Bool

    static func resolve(
        loading: Bool,
        live: Bool,
        today: StaffOfferSummary?,
        dashboardHasToday: Bool,
        isCompletedToday: Bool,
        needsCheckIn: Bool
    ) -> StaffHomeClockTile {
        let clockableToday = today?.presentation?.isToday ?? dashboardHasToday
        let enabled = !loading && (live || (today != nil && !isCompletedToday && clockableToday))
        let label: String
        if loading {
            label = "Loading…"
        } else if live {
            label = "Clock out"
        } else if isCompletedToday, let today {
            label = today.presentation?.label ?? "Completed"
        } else if today != nil {
            label = clockableToday ? (needsCheckIn ? "Check In" : "Clock in") : "Be Ready"
        } else {
            label = "No Shift"
        }
        return StaffHomeClockTile(label: label, enabled: enabled)
    }

    /// A confirmed shift for today that already finished is not clockable.
    static func isCompletedToday(
        loading: Bool,
        live: Bool,
        today: StaffOfferSummary?,
        history: [StaffAttendanceSummary],
        now: Date
    ) -> Bool {
        guard !loading, !live, let today else { return false }
        if let state = today.presentation?.state, ["clockedOut", "complete", "expired", "ended"].contains(state) {
            return true
        }
        if today.presentation == nil && now > today.endsAt { return true }
        return history.contains { $0.shiftId == today.shiftId && $0.hasEnded }
    }
}

// MARK: - Job Details / Clock state (Flutter offer_detail_ui_state.dart)

enum StaffDetailState: Equatable {
    case loading, error, offer, pending, ready, clockIn, clockOut, completed, clockedOut, ended, expired, cancelled, declined, rejected

    var label: String {
        switch self {
        case .loading: return "Loading"
        case .error: return "Unable to refresh"
        case .offer, .pending: return "Pending"
        case .ready, .clockIn, .clockOut: return "Confirmed"
        case .completed: return "Complete"
        case .clockedOut: return "Clocked Out"
        case .ended: return "Ended"
        case .expired: return "Expired"
        case .cancelled: return "Cancelled"
        case .declined: return "Declined"
        case .rejected: return "Not confirmed"
        }
    }

    static func resolve(
        offer: StaffOfferSummary,
        active: StaffAttendanceSummary?,
        history: [StaffAttendanceSummary],
        clockableShiftId: String?,
        loading: Bool = false,
        failed: Bool = false,
        now: Date?
    ) -> StaffDetailState {
        if loading { return .loading }
        if failed { return .error }
        if let projection = offer.presentation {
            if projection.state == "live",
               history.contains(where: { $0.shiftId == offer.shiftId && $0.clockOutAt != nil }) {
                return .loading
            }
            switch projection.state {
            case "live": return .clockOut
            case "clockedOut": return .clockedOut
            case "complete": return .completed
            case "expired": return .expired
            case "cancelled": return .cancelled
            case "declined": return .declined
            case "rejected": return .rejected
            case "ended": return .ended
            case "pending": return offer.status == StaffStatus.pending ? .offer : .pending
            case "confirmed": return active == nil && projection.isToday ? .clockIn : .ready
            default: return .error
            }
        }
        if let active, active.isOpen, active.shiftId == offer.shiftId { return .clockOut }
        if history.contains(where: { $0.shiftId == offer.shiftId && $0.hasEnded }) { return .completed }
        switch offer.status {
        case StaffStatus.pending: return .offer
        case StaffStatus.staffAccepted: return .pending
        case StaffStatus.managerConfirmed:
            if (now ?? Date()) > offer.endsAt { return .ended }
            return active == nil && clockableShiftId == offer.shiftId ? .clockIn : .ready
        case StaffStatus.expired: return .expired
        case StaffStatus.withdrawn: return .cancelled
        case StaffStatus.declined: return .declined
        case StaffStatus.managerRejected: return .rejected
        default: return .error
        }
    }

    /// The clock screen's state (Flutter `_ScheduleClockScreenState._state`).
    /// nil = no shift applies.
    static func clockScreen(
        completedAttendanceId: String?,
        loading: Bool,
        failed: Bool,
        requestedOfferMissing: Bool,
        selected: StaffOfferSummary?,
        active: StaffAttendanceSummary?,
        history: [StaffAttendanceSummary],
        clockableShiftId: String?,
        now: Date?
    ) -> StaffDetailState? {
        // Server success is known even if history is temporarily unavailable.
        if completedAttendanceId != nil { return .completed }
        if loading { return .loading }
        if failed { return .error }
        if requestedOfferMissing { return .error }
        if let active, active.isOpen, selected == nil || active.shiftId == selected?.shiftId {
            return .clockOut
        }
        guard let offer = selected else { return nil }
        if history.contains(where: { $0.shiftId == offer.shiftId && $0.clockOutAt != nil }) {
            return .completed
        }
        let resolved = resolve(offer: offer, active: active, history: history, clockableShiftId: clockableShiftId, now: now)
        // A stale projection must not trigger Clock In while active attendance
        // is being reconciled, nor imply a recorded clock-out.
        if resolved == .clockOut || resolved == .clockedOut || resolved == .completed { return .loading }
        return resolved
    }
}

/// The clock screen's primary action.
enum StaffClockAction: Equatable {
    case loading
    case retry
    case noShift
    case checkIn
    case clockIn
    case clockOut
    case back(String)

    static func resolve(state: StaffDetailState?, noShift: Bool, live: Bool, needsCheckIn: Bool, completed: Bool, teams: Bool) -> StaffClockAction {
        if state == .loading { return .loading }
        if state == .error { return .retry }
        if noShift { return .noShift }
        if needsCheckIn { return .checkIn }
        if state == .clockIn || state == .clockOut { return live ? .clockOut : .clockIn }
        if completed { return .back(teams ? "Back to shift" : "View shift summary") }
        return .back("Back to shifts")
    }
}

// MARK: - Check In (Flutter AttendanceProvider helpers)

enum StaffCheckInRules {
    /// The server's check-in state wins over the offer (which can be a poll behind).
    static func checkedInAt(_ offer: StaffOfferSummary, state: StaffCheckInState?) -> Date? {
        state?.checkedInAt ?? offer.checkedInAt
    }

    static func checkInRequired(_ offer: StaffOfferSummary, state: StaffCheckInState?) -> Bool {
        state?.checkInRequired ?? offer.checkInRequired
    }

    /// Needs a Check In before Clock In and has none yet. Bookings made before
    /// Check In shipped (`checkInRequired: false`) keep the old flow.
    static func needsCheckIn(_ offer: StaffOfferSummary, state: StaffCheckInState?) -> Bool {
        checkInRequired(offer, state: state) && checkedInAt(offer, state: state) == nil
    }

    /// Whether the venue requires location: check-in state, then the offer.
    /// nil = unknown (older server) → keep the previous behaviour and ask.
    static func geofenceEnforced(state: StaffCheckInState?, offer: StaffOfferSummary?) -> Bool? {
        if let state { return state.geofenceEnforced }
        return offer?.geofenceEnforced
    }

    /// When Check In / Clock In opens: the server window, else start − early.
    static func opensAt(offer: StaffOfferSummary, state: StaffCheckInState?, clockInEarlyMinutes: Int?) -> Date? {
        if let opens = state?.opensAt { return opens }
        guard let early = clockInEarlyMinutes else { return nil }
        return offer.startsAt.addingTimeInterval(-TimeInterval(early) * 60)
    }
}

/// A fix the server would certainly refuse is explained without a request.
enum StaffLocationPrecheck {
    static func rejection(_ fix: StaffLocationFix?, limits: StaffLocationEvidenceLimits?, now: Date?) -> String? {
        guard let fix, let limits else { return nil }
        if fix.accuracyM > limits.maxAccuracyM { return "LOCATION_ACCURACY_TOO_LOW" }
        if let now, StaffFormat.seconds(from: fix.capturedAt, to: now) > limits.maxAgeSeconds {
            return "LOCATION_STALE"
        }
        return nil
    }
}

// MARK: - Attendance error text (Flutter core/api/attendance_messages.dart, verbatim)

enum StaffAttendanceMessages {
    static let staff: [String: String] = [
        "CHECK_IN_REQUIRED": "Check in at the venue before you clock in.",
        "CHECK_IN_TOO_EARLY": "It is too early to check in for this shift.",
        "CHECK_IN_WINDOW_CLOSED": "This shift's check-in window has closed.",
        "CLOCK_IN_TOO_EARLY": "It is too early to clock in for this shift.",
        "CLOCK_WINDOW_CLOSED": "This shift's clock-in/out window has closed.",
        "LOCATION_REQUIRED": "This venue needs your location. Turn on location and try again.",
        "LOCATION_STALE": "Your location reading is out of date. Refresh your location and try again.",
        "LOCATION_ACCURACY_TOO_LOW": "We couldn't confirm your location accurately enough. Move to an open area and try again.",
        "OUTSIDE_GEOFENCE": "You're outside the venue's permitted check-in area.",
        "GEOFENCE_MISCONFIGURED": "This venue's location check isn't set up correctly. Ask your manager to update the venue's location settings.",
        "ATTENDANCE_FLAGGED_MISSING": "Your attendance for this shift was flagged as missing. Ask the venue manager to record your attendance.",
        "SHIFT_NOT_CONFIRMED": "This shift is not confirmed for you.",
        "SHIFT_NOT_OPEN": "This shift is not open for attendance.",
        "ALREADY_CLOCKED_IN": "You have already clocked in for this shift.",
        "NOT_CLOCKED_IN": "You are not clocked in for this shift.",
    ]

    /// Code-first wording (some server texts carry raw timestamps), then the
    /// shared normaliser. `INVALID_QR` and plain-text 409s (clock-in sends
    /// "This shift is not confirmed for you." without a code: B6) fall
    /// through to the server's user-facing text.
    static func forStaff(_ error: Error) -> String {
        if let apiError = error as? APIError, let code = apiError.code, let mapped = staff[code] {
            return mapped
        }
        return userMessage(for: error)
    }

    // Client copy for an UNCERTAIN result (timeout / connection lost / 5xx).
    // The action may or may not have been applied, so the state is reloaded
    // first and the person decides; nothing is resent automatically.
    static let uncertainCheckIn = "We couldn't confirm your check-in. Your shift status has been refreshed — check it before trying again."
    static let uncertainClockIn = "We couldn't confirm your clock-in. Your shift status has been refreshed — check it before trying again."
    static let uncertainClockOut = "We couldn't confirm your clock-out. Your shift status has been refreshed — check it before trying again."
    static let uncertainOffer = "We couldn't confirm your response. Your offers have been refreshed — check the offer before trying again."
}

// MARK: - Clock timer (Flutter ClockShiftTimer / ShiftCountdownPanel)

enum StaffCountdownPhase: Equatable {
    case beforeStart, inProgress, onShift, worked, ended

    var heading: String {
        switch self {
        case .beforeStart: return "Your shift starts in"
        case .inProgress: return "Shift in progress"
        case .onShift: return "Time on shift"
        case .worked: return "Time worked"
        case .ended: return "Shift ended"
        }
    }

    /// Red tint before the start, mint once started (owner rule).
    var warning: Bool { self == .beforeStart }
}

struct StaffClockTimerModel: Equatable {
    let label: String
    let seconds: Int?
    let badge: String
    let warning: Bool
    let phase: StaffCountdownPhase?

    /// Every input instant is the server's; `now` is the trusted clock (nil →
    /// "—", never a device-clock fallback). Worked time on a completed shift
    /// is the server's `workedMinutes`.
    static func compute(
        now: Date?,
        startsAt: Date?,
        attendance: StaffAttendanceSummary?,
        live: Bool,
        completed: Bool,
        confirmed: Bool,
        status: String
    ) -> StaffClockTimerModel {
        var overdue = false
        if confirmed, let now, let startsAt, now >= startsAt { overdue = true }
        var delta: Int?
        if live, let attendance, let now {
            delta = StaffFormat.seconds(from: attendance.clockInAt, to: now)
        } else if confirmed, let now, let startsAt {
            delta = overdue ? StaffFormat.seconds(from: startsAt, to: now) : StaffFormat.seconds(from: now, to: startsAt)
        }
        let seconds: Int?
        if completed {
            seconds = attendance?.workedMinutes.map { $0 * 60 }
        } else {
            seconds = delta.map { min(max($0, 0), 999_999_999) }
        }
        let label: String
        if completed { label = "COMPLETED" } else if live { label = "LIVE SHIFT" } else if overdue { label = "CLOCK-IN OVERDUE" } else if confirmed { label = "STARTS IN" } else { label = "SHIFT STATUS" }
        let soon = confirmed && !overdue && (seconds.map { $0 <= 900 } ?? false)
        let badge: String
        if completed {
            badge = "Clocked Out"
        } else if live {
            badge = "Clocked In"
        } else if overdue {
            badge = "Clock-in overdue"
        } else if soon, let seconds {
            badge = "Start in \(Int((Double(seconds) / 60).rounded(.up)))m"
        } else {
            badge = status
        }
        var started = false
        if let now, let startsAt, now >= startsAt { started = true }
        let phase: StaffCountdownPhase?
        if completed { phase = .worked } else if live { phase = .onShift } else if confirmed && started { phase = .inProgress } else if confirmed { phase = .beforeStart } else { phase = nil }
        return StaffClockTimerModel(
            label: label,
            seconds: seconds,
            badge: badge,
            warning: soon || overdue || status == "Shift cancelled",
            phase: phase
        )
    }

    /// Clock screen status text (Flutter `status` switch).
    static func statusText(_ state: StaffDetailState?) -> String {
        switch state {
        case .clockIn?, .ready?: return "Shift confirmed"
        case .clockOut?: return "Clocked In"
        case .completed?: return "Clocked Out"
        case .ended?: return "Shift ended"
        case .cancelled?: return "Shift cancelled"
        case nil: return "No Shift"
        case let other?: return other.label
        }
    }
}

/// Teams list duration from the SCHEDULED window (display only, never worked time).
enum StaffTeamRules {
    static func durationLabel(_ member: StaffTeamMember) -> String {
        let minutes = Int(member.endsAt.timeIntervalSince(member.startsAt) / 60)
        guard minutes > 0 else { return "—" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
    }
}

// MARK: - Calendar (Flutter calendar_presentation.dart, schedule_calendar.dart)

enum StaffCalendarStatus: Equatable {
    case confirmed, open, awaiting, live, clockedOut, complete, ended, declined, rejected, expired, cancelled, other

    var label: String {
        switch self {
        case .confirmed: return "Confirmed"
        case .open: return "Open offer"
        case .awaiting: return "Awaiting confirmation"
        case .live: return "Live"
        case .clockedOut: return "Clocked Out"
        case .complete: return "Complete"
        case .ended: return "Ended"
        case .declined: return "Declined"
        case .rejected: return "Not confirmed"
        case .expired: return "Expired"
        case .cancelled: return "Cancelled"
        case .other: return "Updating"
        }
    }

    /// Status bar / dot colour (`CalendarTokens`).
    var dot: RGBA {
        switch self {
        case .confirmed: return RGBA(argb: 0xFF7CA9E6)
        case .open, .awaiting: return RGBA(argb: 0xFF79CBBB)
        case .live: return RGBA(argb: 0xFF13836B)
        default: return SchedulePalette.muted
        }
    }
}

enum StaffCalendarRules {
    static func includes(_ offer: StaffOfferSummary) -> Bool {
        [StaffStatus.pending, StaffStatus.staffAccepted, StaffStatus.managerConfirmed].contains(offer.status)
    }

    static func status(_ offer: StaffOfferSummary, active: Bool, ended: Bool) -> StaffCalendarStatus {
        if let state = offer.presentation?.state {
            switch state {
            case "confirmed": return .confirmed
            case "pending": return offer.status == StaffStatus.staffAccepted ? .awaiting : .open
            case "live": return .live
            case "clockedOut": return .clockedOut
            case "complete": return .complete
            case "ended": return .ended
            case "declined": return .declined
            case "rejected": return .rejected
            case "expired": return .expired
            case "cancelled": return .cancelled
            default: return .other
            }
        }
        if ended { return .complete }
        if active { return .live }
        switch offer.status {
        case StaffStatus.managerConfirmed: return .confirmed
        case StaffStatus.staffAccepted: return .awaiting
        case StaffStatus.pending: return .open
        default: return .other
        }
    }

    /// Interval overlap with the London calendar day starting at `dayStart`
    /// (an overnight shift appears on both days).
    static func occurs(_ offer: StaffOfferSummary, onDayStarting dayStart: Date, calendar: Calendar = StaffFormat.london) -> Bool {
        guard let next = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return false }
        return offer.startsAt < next && offer.endsAt > dayStart
    }

    static func offers(_ offers: [StaffOfferSummary], onDayStarting dayStart: Date, calendar: Calendar = StaffFormat.london) -> [StaffOfferSummary] {
        offers.filter { occurs($0, onDayStarting: dayStart, calendar: calendar) }.sorted { $0.startsAt < $1.startsAt }
    }

    /// "0 shifts" / "1 shift · 8 hours" / "2 shifts · 7.5 hours" (scheduled
    /// durations, display only).
    static func summary(_ offers: [StaffOfferSummary]) -> String {
        guard !offers.isEmpty else { return "0 shifts" }
        let minutes = offers.reduce(0) { $0 + max(0, Int($1.endsAt.timeIntervalSince($1.startsAt) / 60)) }
        let hours = Double(minutes) / 60
        let value = hours == hours.rounded() ? String(format: "%.0f", hours) : String(format: "%.1f", hours)
        return "\(offers.count) shift\(offers.count == 1 ? "" : "s") · \(value) \(hours == 1 ? "hour" : "hours")"
    }
}

// MARK: - History (Flutter staff_history.dart)

enum StaffHistoryFilter: CaseIterable, Equatable {
    case all, needsAttention, completed

    var label: String {
        switch self {
        case .all: return "All shifts"
        case .needsAttention: return "Needs attention"
        case .completed: return "Completed"
        }
    }

    var emptyTitle: String { self == .needsAttention ? "Nothing needs attention" : "No approved shifts yet" }

    var emptyMessage: String {
        self == .needsAttention
            ? "Approved shifts with a correction or dispute will show up here."
            : "Finished shifts appear here once your payroll has been approved."
    }
}

struct StaffHistoryEntry: Identifiable, Equatable {
    let attendance: StaffAttendanceSummary
    let needsAttention: Bool
    let badge: String
    let attentionMessage: String?
    let venuePhotoFileId: String?

    var id: String { attendance.id }
    var shiftId: String { attendance.shiftId }

    func matches(_ filter: StaffHistoryFilter) -> Bool {
        switch filter {
        case .all: return true
        case .needsAttention: return needsAttention
        case .completed: return !needsAttention
        }
    }
}

enum StaffHistoryRules {
    /// History is payroll-approved work ONLY: Clock out → timesheet → manager
    /// payroll approval → History. Offers never create History rows; they
    /// only supply a venue photo.
    static func build(history: [StaffAttendanceSummary], offers: [StaffOfferSummary]) -> [StaffHistoryEntry] {
        var offerByShift: [String: StaffOfferSummary] = [:]
        for offer in offers { offerByShift[offer.shiftId] = offer }
        return history.filter { $0.payrollApproved && !$0.isOpen }.map { attendance in
            let photo = attendance.venuePhotoFileId ?? offerByShift[attendance.shiftId]?.venuePhotoFileId
            switch attendance.status {
            case StaffStatus.underReview:
                return StaffHistoryEntry(attendance: attendance, needsAttention: true, badge: "Under review",
                                         attentionMessage: "A correction to this approved shift is being reviewed.", venuePhotoFileId: photo)
            case StaffStatus.disputed:
                return StaffHistoryEntry(attendance: attendance, needsAttention: true, badge: "Disputed",
                                         attentionMessage: "These approved hours are disputed. Contact your manager.", venuePhotoFileId: photo)
            default:
                return StaffHistoryEntry(attendance: attendance, needsAttention: false, badge: "Completed",
                                         attentionMessage: nil, venuePhotoFileId: photo)
            }
        }
        .sorted { $0.attendance.startsAt > $1.attendance.startsAt }
    }

    /// Payroll-approved (server) minutes for shifts starting in the London
    /// calendar month of `now`.
    static func verifiedMinutesThisMonth(_ rows: [StaffHistoryEntry], now: Date, calendar: Calendar = StaffFormat.london) -> Int {
        let month = calendar.dateComponents([.year, .month], from: now)
        return rows.filter {
            let c = calendar.dateComponents([.year, .month], from: $0.attendance.startsAt)
            return c.year == month.year && c.month == month.month
        }
        .reduce(0) { $0 + ($1.attendance.workedMinutes ?? 0) }
    }

    /// "Shift completed — Awaiting payroll approval" on Job Details.
    static func awaitingPayroll(shiftId: String, history: [StaffAttendanceSummary]) -> Bool {
        history.contains { $0.shiftId == shiftId && $0.clockOutAt != nil && !$0.payrollApproved }
    }
}

// MARK: - Payroll documents (Flutter payslips_screen.dart)

enum StaffPayrollRules {
    /// (label, surface, text) for a payslip/statement status.
    static func pill(_ status: String) -> (label: String, surface: RGBA, text: RGBA) {
        switch status {
        case "paid": return ("Paid", RGBA(argb: 0xFFD6EFE2), RGBA(argb: 0xFF0B6B47))
        case "available": return ("Available", RGBA(argb: 0xFFDCE4FF), RGBA(argb: 0xFF3B41A8))
        case "upcoming": return ("Upcoming", RGBA(argb: 0xFFEDEEF2), SchedulePalette.muted)
        case "processing": return ("Processing", RGBA(argb: 0xFFFFE9C7), RGBA(argb: 0xFF8A4B00))
        default: return ("Approved", RGBA(argb: 0xFFDCE4FF), RGBA(argb: 0xFF3B41A8))
        }
    }

    static func paydayText(_ payday: CalendarDay?) -> String {
        guard let payday else { return "Payday to be confirmed" }
        return "Payday \(StaffFormat.day(payday, year: true))"
    }

    /// Earliest upcoming/processing payday.
    static func nextPayday(_ payslips: [StaffPayslip]) -> CalendarDay? {
        payslips.filter { $0.status == "upcoming" || $0.status == "processing" }.map(\.payday).min()
    }

    static func statementAction(_ statement: StaffShiftStatement) -> String {
        switch statement.statementState {
        case "available": return "View ›"
        case "failed": return "Unavailable"
        default: return "Preparing…"
        }
    }
}

import Foundation

// Form state + validation for the Venue Manager mutations, kept out of the
// views so the request bodies can be unit-tested. Client checks are UX
// guards only; the server validates every field again.

// MARK: - Record attendance

/// Wire codes + labels of the server's `ATTENDANCE_RECORD_REASONS`.
enum AttendanceRecordReason: String, CaseIterable, Identifiable {
    case forgotClockIn = "forgot_clock_in"
    case forgotClockOut = "forgot_clock_out"
    case appIssue = "app_issue"
    case venueIssue = "venue_issue"
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .forgotClockIn: return "Staff forgot to clock in"
        case .forgotClockOut: return "Staff forgot to clock out"
        case .appIssue: return "Mobile application issue"
        case .venueIssue: return "Venue operational issue"
        case .other: return "Other"
        }
    }
}

/// "Record attendance" for one seat. The date-time fields start EMPTY for a
/// seat without attendance (they are never pre-filled with the scheduled
/// times); an existing recorded value is shown as it is. Worked minutes are
/// NOT previewed here: they are computed only by the server
/// (`@rab/shared` duration.ts) when saved.
struct RecordAttendanceDraft: Equatable {
    enum Field: Hashable { case clockIn, clockOut, breakMinutes, reason, note }

    var clockIn: Date?
    var clockOut: Date?
    var breakText: String
    var reason: AttendanceRecordReason?
    var note: String

    init(row: ShiftReportStaffRow) {
        clockIn = row.clockInAt
        clockOut = row.clockOutAt
        breakText = "\(row.breakMinutes ?? row.scheduledBreakMinutes)"
        reason = nil
        note = ""
    }

    var breakValue: Int? { Int(breakText.trimmingCharacters(in: .whitespaces)) }

    /// - Parameter now: SERVER time (the report's `serverNow` anchored to a
    ///   monotonic clock). nil skips the "not in the future" pre-check; the
    ///   server still refuses future times (`INVALID_ATTENDANCE_TIMES`).
    func validate(now: Date?) -> [Field: String] {
        var errors: [Field: String] = [:]
        if clockIn == nil { errors[.clockIn] = "Select the actual clock-in date and time." }
        if clockOut == nil { errors[.clockOut] = "Select the actual clock-out date and time." }
        if let now, let inAt = clockIn, inAt > now { errors[.clockIn] = "The clock-in time cannot be in the future." }
        if let now, let out = clockOut, out > now { errors[.clockOut] = "The clock-out time cannot be in the future." }
        if let inAt = clockIn, let out = clockOut, out <= inAt {
            errors[.clockOut] = "The clock-out must be after the clock-in. If they finished after midnight, choose the next day."
        }
        if let b = breakValue, (0...1440).contains(b) {
            if let inAt = clockIn, let out = clockOut, out > inAt, b >= Int((out.timeIntervalSince(inAt) / 60).rounded()) {
                errors[.breakMinutes] = "The break must be shorter than the time between clock-in and clock-out."
            }
        } else {
            errors[.breakMinutes] = "Enter the break in whole minutes."
        }
        if reason == nil { errors[.reason] = "Select a reason." }
        if reason == .other, note.trimmingCharacters(in: .whitespacesAndNewlines).count < 10 {
            errors[.note] = "Explain the reason in at least 10 characters."
        }
        return errors
    }

    /// The request body, only for a draft that validates. `expectedVersion`
    /// is the row's `attendanceVersion` echoed unchanged (omitted when the
    /// row had none); the explanation is sent only for "Other".
    func body(expectedVersion: String?, now: Date?) -> RecordAttendanceBody? {
        guard validate(now: now).isEmpty, let reason else { return nil }
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return RecordAttendanceBody(
            clockInAt: clockIn,
            clockOutAt: clockOut,
            breakMinutes: breakValue,
            reasonCode: reason.rawValue,
            reasonNote: reason == .other && !trimmedNote.isEmpty ? trimmedNote : nil,
            expectedVersion: expectedVersion
        )
    }
}

// MARK: - Inline correction (legacy POST /attendance/:id/correct)

enum CorrectionField: String, CaseIterable, Identifiable {
    case clockInAt, clockOutAt, breakMinutes

    var id: String { rawValue }

    var label: String {
        switch self {
        case .clockInAt: return "Clock in"
        case .clockOutAt: return "Clock out"
        case .breakMinutes: return "Break"
        }
    }
}

struct CorrectionDraft: Equatable {
    var field: CorrectionField
    /// The new instant; nil until the manager picks one (never pre-filled
    /// with a scheduled time).
    var value: Date?
    var breakText: String
    var reason: String

    init(row: ShiftReportStaffRow) {
        let missingOut = row.clockInAt != nil && row.clockOutAt == nil && row.assignmentStatus != "no_show"
        field = missingOut ? .clockOutAt : .clockInAt
        value = missingOut ? nil : row.clockInAt
        breakText = "\(row.breakMinutes ?? row.scheduledBreakMinutes)"
        reason = ""
    }

    mutating func select(_ next: CorrectionField, row: ShiftReportStaffRow) {
        field = next
        switch next {
        case .clockInAt: value = row.clockInAt
        case .clockOutAt: value = row.clockOutAt
        case .breakMinutes: value = nil
        }
    }

    func orderProblem(row: ShiftReportStaffRow) -> String? {
        guard let v = value else { return nil }
        if field == .clockOutAt, let ci = row.clockInAt, v < ci {
            return "This is before clock in (\(VMDate.weekdayDayTime(ci))). If they clocked out after midnight, change the date."
        }
        if field == .clockInAt, let co = row.clockOutAt, v > co {
            return "This is after clock out (\(VMDate.weekdayDayTime(co))). Check the date."
        }
        return nil
    }

    enum Outcome: Equatable {
        case invalid(String)
        case body(CorrectAttendanceBody)
    }

    func build(row: ShiftReportStaffRow) -> Outcome {
        let reasonText = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard reasonText.count >= 10 else { return .invalid("Please explain this change in at least 10 characters.") }
        switch field {
        case .breakMinutes:
            guard let minutes = Int(breakText.trimmingCharacters(in: .whitespaces)), minutes >= 0 else {
                return .invalid("Enter a whole number of minutes.")
            }
            return .body(CorrectAttendanceBody(field: field.rawValue, newValue: "\(minutes)", reason: reasonText))
        case .clockInAt, .clockOutAt:
            guard let value else { return .invalid("Pick a time.") }
            if let problem = orderProblem(row: row) { return .invalid(problem) }
            return .body(CorrectAttendanceBody(field: field.rawValue, newValue: ISO8601.string(from: value), reason: reasonText))
        }
    }
}

// MARK: - Performance review

struct ReviewDraft: Equatable {
    var ratings: [StaffReviewCategory: Int] = [:]
    var feedback: String = ""

    init(review: StaffReview?) {
        ratings = review?.ratings ?? [:]
        feedback = review?.feedback ?? ""
    }

    enum Outcome: Equatable {
        case invalid(String)
        case body(StaffReviewBody)
    }

    func build() -> Outcome {
        let missing = StaffReviewCategory.allCases.filter { ratings[$0] == nil }.map(\.label)
        guard missing.isEmpty,
              let g = ratings[.grooming], let a = ratings[.attitude], let s = ratings[.skills],
              let at = ratings[.attendance], let t = ratings[.timeKeeping]
        else { return .invalid("Rate every area before saving (\(missing.joined(separator: ", "))).") }
        let text = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        return .body(StaffReviewBody(grooming: g, attitude: a, skills: s, attendance: at, timeKeeping: t,
                                     feedback: text.isEmpty ? nil : feedback))
    }
}

// MARK: - Send shift

/// One selected staff member's window and break (Flutter
/// `StaffAssignmentDraft`).
struct StaffAssignmentDraft: Equatable, Identifiable {
    let staff: DirectoryUser
    var startsAt: Date
    var endsAt: Date
    var customised = false
    /// nil = inherit the request's break.
    var breakMinutes: Int?

    var id: String { staff.id }

    func effectiveBreak(_ defaultBreak: Int) -> Int { breakMinutes ?? defaultBreak }

    func isValid(defaultBreak: Int) -> Bool {
        let span = Int(endsAt.timeIntervalSince(startsAt) / 60)
        let b = effectiveBreak(defaultBreak)
        return startsAt < endsAt && b >= 0 && b < span
    }

    var body: SubmitShiftRequestBody.Assignment {
        .init(staffProfileId: staff.id, breakMinutes: breakMinutes, startsAt: startsAt, endsAt: endsAt)
    }
}

/// The committed selection, in selection order.
struct ShiftAssignmentDraft: Equatable {
    private(set) var assignments: [StaffAssignmentDraft] = []

    var selected: [DirectoryUser] { assignments.map(\.staff) }
    var selectedIds: [String] { assignments.map(\.staff.id) }

    /// Keeps existing per-person edits; drops the deselected; adds the new
    /// with the request window.
    mutating func select(_ staff: [DirectoryUser], start: Date, end: Date) {
        let ids = Set(staff.map(\.id))
        assignments.removeAll { !ids.contains($0.staff.id) }
        for user in staff where !assignments.contains(where: { $0.staff.id == user.id }) {
            assignments.append(StaffAssignmentDraft(staff: user, startsAt: start, endsAt: end))
        }
    }

    /// Non-customised windows follow the request window.
    mutating func parentChanged(start: Date, end: Date) {
        for index in assignments.indices where !assignments[index].customised {
            assignments[index].startsAt = start
            assignments[index].endsAt = end
        }
    }

    mutating func update(_ assignment: StaffAssignmentDraft) {
        guard let index = assignments.firstIndex(where: { $0.id == assignment.id }) else { return }
        assignments[index] = assignment
    }
}

/// Request window from the picked London day + times; an end at or before
/// the start rolls to the next day (overnight).
enum SendShiftComposer {
    static func compose(day: Date, start: Date, end: Date) -> (startsAt: Date, endsAt: Date) {
        let calendar = VMDate.calendar
        let dayStart = calendar.startOfDay(for: day)
        func at(_ time: Date, on base: Date) -> Date {
            let parts = calendar.dateComponents([.hour, .minute], from: time)
            return calendar.date(bySettingHour: parts.hour ?? 0, minute: parts.minute ?? 0, second: 0, of: base) ?? base
        }
        let startsAt = at(start, on: dayStart)
        var endsAt = at(end, on: dayStart)
        if endsAt <= startsAt, let next = calendar.date(byAdding: .day, value: 1, to: dayStart) {
            endsAt = at(end, on: next)
        }
        return (startsAt, endsAt)
    }

    enum BreakInput: Equatable {
        case serverDefault
        case minutes(Int)
        case invalid
    }

    static func parseBreak(_ text: String) -> BreakInput {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return .serverDefault }
        guard let value = Int(trimmed), value >= 0 else { return .invalid }
        return .minutes(value)
    }

    /// The break each assignment inherits: the typed value, else the
    /// venue's default, else 30 (the server's own fallback). -1 = invalid.
    static func draftBreak(text: String, venue: VenueSummary?) -> Int {
        switch parseBreak(text) {
        case .minutes(let m): return m
        case .invalid: return -1
        case .serverDefault: return venue?.defaultBreakMinutes ?? 30
        }
    }

    enum Problem: Error, Equatable {
        case noStaff, breakInvalid, breakTooLong, invalidAssignments, missingVenueOrRole
        var message: String {
            switch self {
            case .noStaff: return "Select at least one staff member."
            case .breakInvalid: return "Enter zero or more minutes"
            case .breakTooLong: return "Break must be shorter than the shift."
            case .invalidAssignments: return "Edit the highlighted staff times or breaks before sending."
            case .missingVenueOrRole: return "Choose a venue and a role."
            }
        }
    }

    static func body(
        venueId: String?, jobRoleId: String?, day: Date, start: Date, end: Date, breakText: String,
        draft: ShiftAssignmentDraft, venue: VenueSummary?,
        acknowledgements: [SubmitShiftRequestBody.Acknowledgement]?
    ) -> Result<SubmitShiftRequestBody, Problem> {
        guard let venueId, let jobRoleId else { return .failure(.missingVenueOrRole) }
        guard !draft.assignments.isEmpty else { return .failure(.noStaff) }
        let window = compose(day: day, start: start, end: end)
        let breakOverride: Int?
        switch parseBreak(breakText) {
        case .invalid: return .failure(.breakInvalid)
        case .serverDefault: breakOverride = nil
        case .minutes(let m):
            if m >= Int(window.endsAt.timeIntervalSince(window.startsAt) / 60) { return .failure(.breakTooLong) }
            breakOverride = m
        }
        let inherited = draftBreak(text: breakText, venue: venue)
        guard draft.assignments.allSatisfy({ $0.isValid(defaultBreak: inherited) }) else { return .failure(.invalidAssignments) }
        return .success(SubmitShiftRequestBody(
            venueId: venueId,
            jobRoleId: jobRoleId,
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            breakMinutes: breakOverride,
            staffRequired: draft.assignments.count,
            staffProfileIds: draft.selectedIds,
            staffAssignments: draft.assignments.map(\.body),
            acknowledgedAvailabilityConflicts: acknowledgements
        ))
    }
}

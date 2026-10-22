import SwiftUI

/// "Review staff report" (Flutter `ReviewStaffReportScreen`).
///
/// Attendance tab:
/// - Missing attendance (incl. the worker's PROVISIONAL no-show) is NOT a
///   confirmed no-show: it offers "Record attendance" and "Confirm no-show".
/// - A confirmed no-show offers only "Reopen no-show" (reason, audited)
///   before finalisation.
/// - Partial/recorded rows keep the inline audited correction and the
///   explicit "Mark reviewed" (`attendance-review`).
/// Staff review tab: the optional per-shift performance rating.
///
/// The report/row are replaced ONLY by server responses (never edited
/// locally). Errors: inline in forms, error toasts for transient results; no
/// success toasts. Backend: record / confirm / reopen need the dev rebuild (D3).
struct VMReviewStaffReportView: View {
    enum Tab: Hashable { case attendance, review }

    @EnvironmentObject private var store: VenueManagerStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss
    @State private var report: ShiftReportDetail
    @State private var row: ShiftReportStaffRow
    @State private var tab: Tab
    @State private var correction: CorrectionDraft
    @State private var correctionError: String?
    @State private var confirmation: String?
    @State private var saving = false
    @State private var reviewing = false
    @State private var deciding = false
    @State private var reviewDraft = ReviewDraft(review: nil)
    @State private var reviewLoaded = false
    @State private var reviewEditable = false
    @State private var reviewError: String?
    @State private var reviewSavedBy: String?
    @State private var recordSheet: VMSheetItem<ShiftReportStaffRow>?
    @State private var confirmsNoShow = false
    @State private var reopenSheet = false

    private let staffProfileId: String

    init(report: ShiftReportDetail, row: ShiftReportStaffRow, initialTab: Tab = .attendance) {
        _report = State(initialValue: report)
        _row = State(initialValue: row)
        _tab = State(initialValue: initialTab)
        _correction = State(initialValue: CorrectionDraft(row: row))
        staffProfileId = row.staffProfileId
    }

    private var busy: Bool { saving || reviewing || deciding }
    private var locked: Bool { report.isFinalised }

    var body: some View {
        VMPage(title: "Review staff report", background: VMColor.reportPage) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header
                    ReportSegments(values: [Tab.attendance, .review], label: { $0 == .attendance ? "Attendance" : "Staff review" },
                                   selection: $tab, enabled: !busy)
                    if locked {
                        ReportNotice(title: "Report finalised", message: "Attendance and reviews are locked after the timesheet is signed off.")
                    }
                    if tab == .attendance { attendanceTab } else { reviewTab }
                }
                .padding(EdgeInsets(top: 8, leading: 20, bottom: 24, trailing: 20))
                .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .safeAreaInset(edge: .bottom) { bottomBar }
        .task { await loadReview() }
        .sheet(item: $recordSheet) { item in
            VMRecordAttendanceSheet(report: report, row: item.value) { fresh in
                recordSheet = nil
                if let fresh { adopt(fresh) } else { Task { await reloadReport() } }
            }
            .presentationDetents([.large])
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $reopenSheet) {
            VMReopenNoShowSheet { reason in
                reopenSheet = false
                if let reason {
                    Task { await decide { try await store.repository.reopenNoShow(shiftId: report.shiftId, staffProfileId: staffProfileId, reason: reason) } }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .alert("Confirm no-show", isPresented: $confirmsNoShow) {
            Button("Cancel", role: .cancel) {}
            Button("Confirm no-show") {
                Task { await decide { try await store.repository.confirmNoShow(shiftId: report.shiftId, staffProfileId: staffProfileId) } }
            }
        } message: {
            Text("Confirm that this staff member did not attend the shift?")
        }
        .accessibilityIdentifier("vm.reviewStaff")
    }

    private var header: some View {
        ReportCard {
            HStack(spacing: 12) {
                Text(InitialsAvatar.initials(for: row.staffName))
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(VMColor.reportMuted)
                    .frame(width: 44, height: 44)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(RGBA(argb: 0xFFE5E7EB).color))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.staffName).scheduleType(ScheduleType.cardTitle)
                    Text("\(report.venueName) · \(VMText.displayRoleName(row.roleName))").scheduleType(ScheduleType.caption)
                    Text("\(CrewflowDateFormat.weekdayDay(report.startsAt)) · \(VMDate.reportTimeRange(report.startsAt, report.endsAt))")
                        .scheduleType(ScheduleType.caption)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Attendance tab

    @ViewBuilder
    private var attendanceTab: some View {
        VMRecordedAttendanceCard(row: row, finalised: locked)
        if row.attendanceMissing {
            ReportNotice(title: "Attendance requires review",
                         message: "No clock-in or clock-out was recorded for this shift. If the staff member worked, enter their verified attendance times. Otherwise, confirm the no-show.")
                .accessibilityIdentifier("vm.review.missingNotice")
        } else if row.noShowConfirmed {
            ReportNotice(title: "No-show confirmed",
                         message: "\(row.staffName) did not attend this shift. No hours are recorded or paid." + (locked ? "" : " If this was a mistake, reopen it to record their attendance."))
        }
        if let confirmation {
            MessageCard(title: confirmation, kind: .success)
        }
        if row.attendanceId != nil { correctionForm }
    }

    @ViewBuilder
    private var correctionForm: some View {
        let missingOut = row.clockInAt != nil && row.clockOutAt == nil && row.assignmentStatus != "no_show"
        if missingOut {
            ReportNotice(title: "Clock-out time is missing", message: "Add the correct time and a reason for the change.")
        }
        Text("Attendance correction").scheduleType(ScheduleType.cardTitle).padding(.top, 4).accessibilityAddTraits(.isHeader)
        ReportSegments(values: CorrectionField.allCases, label: \.label, selection: Binding(
            get: { correction.field },
            set: { next in
                correction.select(next, row: row)
                correctionError = nil
            }
        ), enabled: !locked)
        if correction.field == .breakMinutes {
            VMField(label: "Break (minutes)") {
                TextField("Minutes", text: $correction.breakText).keyboardType(.numberPad).vmInputBox().disabled(locked)
            }
        } else {
            VMOptionalDateTimeField(
                label: correction.field == .clockInAt ? "Clock-in date and time" : "Clock-out date and time",
                value: $correction.value,
                anchor: (correction.field == .clockOutAt ? row.scheduledEnd : row.scheduledStart) ?? report.startsAt,
                range: pickerRange,
                placeholder: "Select time",
                enabled: !locked
            )
            if let value = correction.value {
                Text("Will be saved as \(VMDate.long(value))").scheduleType(ScheduleType.caption)
            }
        }
        VMField(label: "Reason for correction (required)") {
            TextField("Add a reason for this correction…", text: $correction.reason, axis: .vertical)
                .lineLimit(3...5).vmInputBox().disabled(locked)
        }
        Text("Your changes will be recorded with this report.").scheduleType(ScheduleType.caption)
        if let correctionError {
            MessageCard(title: correctionError, kind: .error)
        }
    }

    /// The day before the scheduled start … two days after (Flutter range).
    private var pickerRange: ClosedRange<Date> {
        let calendar = VMDate.calendar
        let anchor = calendar.startOfDay(for: report.startsAt)
        let lower = calendar.date(byAdding: .day, value: -1, to: anchor) ?? anchor
        let upper = calendar.date(byAdding: .day, value: 3, to: anchor)?.addingTimeInterval(-60) ?? anchor
        return lower...upper
    }

    /// Why "Mark reviewed" is unavailable, from the server row.
    private var reviewBlocked: String? {
        if locked || row.attendanceReviewed { return nil }
        if row.isOpen {
            return "Still clocked in. Review after clock-out, or once the shift has ended record the clock-out as a correction."
        }
        if row.isNoShow { return nil }
        if row.attendanceId == nil { return "No attendance recorded yet. Record the attendance, or confirm the no-show." }
        if row.clockOutAt == nil { return "Add the clock-out time as a correction first." }
        return nil
    }

    // MARK: Bottom bars

    @ViewBuilder
    private var bottomBar: some View {
        VStack(spacing: 10) {
            if tab == .review {
                HStack(spacing: 12) {
                    ReportButton(title: "Cancel", secondary: true, enabled: !busy) { dismiss() }
                    ReportButton(title: "Save review", busy: saving, enabled: !locked && !busy && reviewEditable) {
                        Task { await saveReview() }
                    }
                    .accessibilityIdentifier("vm.review.savePerformance")
                }
            } else if !locked && row.attendanceMissing {
                PrimaryButton("Record attendance", background: ScheduleTokens.navy) { recordSheet = VMSheetItem(value: row) }
                    .disabled(busy)
                    .accessibilityIdentifier("vm.review.record")
                PrimaryButton("Confirm no-show", variant: .light, isBusy: deciding) { confirmsNoShow = true }
                    .disabled(busy)
                    .accessibilityIdentifier("vm.review.confirmNoShow")
            } else if !locked && row.noShowConfirmed {
                PrimaryButton("Reopen no-show", variant: .light, isBusy: deciding) { reopenSheet = true }
                    .disabled(busy)
                    .accessibilityIdentifier("vm.review.reopen")
            } else {
                if let blocked = reviewBlocked, !locked {
                    Text(blocked).scheduleType(ScheduleType.caption).multilineTextAlignment(.center)
                }
                let canReview = !locked && !row.attendanceReviewed && row.attendanceResolved
                let reviewButton = ReportButton(title: row.attendanceReviewed ? "Reviewed" : (row.isNoShow ? "Confirm no-show" : "Mark reviewed"),
                                                busy: reviewing, enabled: canReview && !busy) { Task { await markReviewed() } }
                if row.attendanceId == nil {
                    reviewButton.accessibilityIdentifier("vm.review.markReviewed")
                } else {
                    HStack(spacing: 12) {
                        ReportButton(title: "Save correction", secondary: true, busy: saving, enabled: !locked && !busy) {
                            Task { await saveCorrection() }
                        }
                        reviewButton.accessibilityIdentifier("vm.review.markReviewed")
                    }
                }
            }
        }
        .padding(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20))
        .frame(maxWidth: .infinity)
        .background(VMColor.reportPage.opacity(0.97).ignoresSafeArea())
    }

    // MARK: Server round trips (render only what the server returns)

    private func adopt(_ fresh: ShiftReportDetail) {
        report = fresh
        if let next = fresh.row(for: staffProfileId) { row = next }
        correction = CorrectionDraft(row: row)
    }

    @MainActor
    private func reloadReport() async {
        if let fresh = try? await store.report(for: report.shiftId) { adopt(fresh) }
    }

    @MainActor
    private func saveCorrection() async {
        guard !busy, let attendanceId = row.attendanceId else { return }
        confirmation = nil
        let body: CorrectAttendanceBody
        switch correction.build(row: row) {
        case .invalid(let message):
            correctionError = message
            return
        case .body(let value):
            body = value
        }
        saving = true
        correctionError = nil
        defer { saving = false }
        do {
            try await store.repository.correctAttendance(attendanceId: attendanceId, body: body)
        } catch let failure as APIError where failure.isUncertainOutcome {
            await reloadReport()
            correctionError = VMUncertain.message
            return
        } catch {
            let api = error as? APIError
            if api == .cancelled || api == .sessionChanged { return }
            correctionError = userMessage(for: error)
            return
        }
        // Confirmed by the server: show what it STORED, not what was typed.
        do {
            adopt(try await store.report(for: report.shiftId))
            confirmation = Self.savedMessage(body.field, row)
        } catch {
            confirmation = "Correction saved. The report could not be refreshed. Go back and pull to refresh."
        }
    }

    static func savedMessage(_ field: String, _ row: ShiftReportStaffRow) -> String {
        func at(_ date: Date?) -> String { date.map(VMDate.weekdayDayTime) ?? "—" }
        let what: String
        switch field {
        case "clockOutAt": what = "Clock-out saved: \(at(row.clockOutAt))."
        case "clockInAt": what = "Clock-in saved: \(at(row.clockInAt))."
        default: what = "Break saved: \(row.breakMinutes ?? row.scheduledBreakMinutes) min."
        }
        return "\(what) Mark the attendance as reviewed when the hours are right."
    }

    @MainActor
    private func markReviewed() async {
        guard !busy else { return }
        reviewing = true
        defer { reviewing = false }
        do {
            let fresh = try await store.repository.reviewAttendance(shiftId: report.shiftId, staffProfileId: staffProfileId)
            adopt(fresh)
            guard row.attendanceReviewed else {
                // Never claim a success the server's own report does not show.
                toasts.show("The review was not recorded. Please try again.", kind: .error)
                return
            }
            // No success toast: the report shows "Reviewed" itself.
            dismiss()
        } catch {
            if (error as? APIError)?.isUncertainOutcome == true { await reloadReport() }
            toasts.showError(error)
        }
    }

    /// One seat decision; renders only the server's answer.
    @MainActor
    private func decide(_ call: () async throws -> ShiftReportDetail) async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        do {
            adopt(try await call())
        } catch {
            if (error as? APIError)?.isUncertainOutcome == true { await reloadReport() }
            toasts.showError(error)
        }
    }

    // MARK: Staff review tab

    @ViewBuilder
    private var reviewTab: some View {
        if !reviewLoaded {
            VMInlineLoading(label: "Loading review")
        } else {
            Text("Staff performance").scheduleType(ScheduleType.cardTitle).accessibilityAddTraits(.isHeader)
            Text("Rate each area from 1 (poor) to 5 (excellent).").scheduleType(ScheduleType.caption)
            ForEach(StaffReviewCategory.allCases, id: \.self) { category in
                ViewThatFits(in: .horizontal) {
                    HStack { ratingLabel(category); ratingBoxes(category) }
                    VStack(alignment: .leading, spacing: 6) { ratingLabel(category); ratingBoxes(category) }
                }
            }
            VMField(label: "Feedback (optional)") {
                TextField("Add feedback for this staff member…", text: $reviewDraft.feedback, axis: .vertical)
                    .lineLimit(3...6)
                    .vmInputBox()
                    .disabled(!reviewEditable)
                    .onChange(of: reviewDraft.feedback) { value in
                        if value.count > 2000 { reviewDraft.feedback = String(value.prefix(2000)) }
                    }
            }
            if let reviewSavedBy { Text("Last saved by \(reviewSavedBy).").scheduleType(ScheduleType.caption) }
            if let reviewError { MessageCard(title: reviewError, kind: .error) }
        }
    }

    private func ratingLabel(_ category: StaffReviewCategory) -> some View {
        Text(category.label).scheduleType(ScheduleType.bodyStrong).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func ratingBoxes(_ category: StaffReviewCategory) -> some View {
        HStack(spacing: 6) {
            ForEach(1...5, id: \.self) { value in
                let selected = reviewDraft.ratings[category] == value
                Button { reviewDraft.ratings[category] = value } label: {
                    Text("\(value)")
                        .scheduleType(ScheduleType.bodyStrong.colored(selected ? .white : VMColor.reportMuted))
                        .frame(width: 44, height: 44)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(selected ? VMColor.reportNavy : .white))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(selected ? VMColor.reportNavy : VMColor.divider, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(!reviewEditable)
                .accessibilityLabel("\(category.label) \(value) of 5")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    @MainActor
    private func loadReview() async {
        guard !reviewLoaded else { return }
        do {
            let envelope = try await store.repository.review(shiftId: report.shiftId, staffProfileId: staffProfileId)
            reviewEditable = envelope.editable
            reviewDraft = ReviewDraft(review: envelope.review)
            reviewSavedBy = envelope.review?.reviewerName
        } catch {
            let api = error as? APIError
            if api != .cancelled, api != .sessionChanged { reviewError = vmMessage(error, fallback: "Could not load the review.") }
        }
        reviewLoaded = true
    }

    @MainActor
    private func saveReview() async {
        guard reviewEditable, !busy else { return }
        let body: StaffReviewBody
        switch reviewDraft.build() {
        case .invalid(let message):
            reviewError = message
            return
        case .body(let value):
            body = value
        }
        saving = true
        reviewError = nil
        defer { saving = false }
        do {
            try await store.repository.saveReview(shiftId: report.shiftId, staffProfileId: staffProfileId, body: body)
            dismiss()
        } catch {
            let api = error as? APIError
            if api == .cancelled || api == .sessionChanged { return }
            reviewError = api?.isUncertainOutcome == true ? VMUncertain.message : userMessage(for: error)
        }
    }
}

/// What the server currently holds for this seat.
struct VMRecordedAttendanceCard: View {
    let row: ShiftReportStaffRow
    let finalised: Bool

    var body: some View {
        let badge = staffReportBadge(row, ended: true, finalised: finalised)
        let missingOut = !row.isNoShow && !row.isOpen && row.clockInAt != nil && row.clockOutAt == nil
        ReportCard(padding: EdgeInsets(top: 14, leading: 18, bottom: 12, trailing: 18)) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Recorded attendance").scheduleType(ScheduleType.bodyStrong)
                // Own line: "Corrected · Awaiting review" never truncates.
                ReportBadge(badge).padding(.vertical, 8).accessibilityIdentifier("vm.review.badge")
                ReportField("Clock in", row.clockInAt.map(VMDate.hm) ?? "—")
                ReportField("Clock out", row.clockOutAt.map(VMDate.hm) ?? (missingOut ? "Missing" : "—"),
                            valueColor: missingOut ? VMColor.missingText : nil)
                ReportField("Break", "\(row.breakMinutes ?? row.scheduledBreakMinutes) min")
                ReportField("Worked", vmWorkedLabel(row))
                if row.manuallyEntered { ReportField("Source", "Entered by manager") }
                if row.attendanceReviewed && !row.noShowConfirmed { ReportField("Reviewed by", row.attendanceReviewedByName ?? "Manager") }
                if row.noShowConfirmed { ReportField("Confirmed by", row.attendanceReviewedByName ?? "Manager") }
            }
        }
    }
}

/// Reason-required confirmation for reopening a confirmed no-show.
private struct VMReopenNoShowSheet: View {
    let done: (String?) -> Void
    @State private var reason = ""
    @State private var error: String?

    var body: some View {
        VMSheet {
            Text("Reopen no-show").scheduleType(ScheduleType.heading)
            Text("The seat goes back to \"Attendance missing\" so you can record attendance or confirm the no-show again.")
                .scheduleType(ScheduleType.body).padding(.top, 8)
            VMField(label: "Reason", error: error) {
                TextField("Why is this being reopened?", text: $reason, axis: .vertical)
                    .lineLimit(2...4)
                    .vmInputBox()
                    .onChange(of: reason) { value in
                        error = nil
                        if value.count > 500 { reason = String(value.prefix(500)) }
                    }
                    .accessibilityIdentifier("vm.reopen.reason")
            }
            .padding(.top, 12)
            HStack(spacing: 12) {
                PrimaryButton("Cancel", variant: .light) { done(nil) }
                PrimaryButton("Reopen", background: ScheduleTokens.navy) {
                    let text = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard text.count >= 10 else {
                        error = "Explain the reason in at least 10 characters."
                        return
                    }
                    done(text)
                }
            }
            .padding(.top, 20)
        }
    }
}

/// "Record attendance" (Flutter `AttendanceEntrySheet`): the manager's
/// VERIFIED actual clock-in / clock-out (date + time, never pre-filled with
/// the scheduled times), the break, a reason code (+ explanation for Other),
/// and `expectedVersion` = the row's `attendanceVersion` echoed unchanged.
/// Submits once; an uncertain result locks the sheet and reloads. No worked
/// time preview: hours and pay are computed only by the server.
struct VMRecordAttendanceSheet: View {
    let report: ShiftReportDetail
    let row: ShiftReportStaffRow
    let done: (ShiftReportDetail?) -> Void

    @EnvironmentObject private var store: VenueManagerStore
    @State private var draft: RecordAttendanceDraft
    @State private var errors: [RecordAttendanceDraft.Field: String] = [:]
    @State private var saving = false
    @State private var serverError: (title: String, message: String)?
    @State private var uncertain = false
    private let clock: VMServerClock?

    init(report: ShiftReportDetail, row: ShiftReportStaffRow, done: @escaping (ShiftReportDetail?) -> Void) {
        self.report = report
        self.row = row
        self.done = done
        _draft = State(initialValue: RecordAttendanceDraft(row: row))
        clock = VMServerClock(serverNow: report.serverNow)
    }

    private var range: ClosedRange<Date> {
        let calendar = VMDate.calendar
        let first = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: row.scheduledStart ?? report.startsAt)) ?? report.startsAt
        let lastDay = calendar.date(byAdding: .day, value: 2, to: calendar.startOfDay(for: row.scheduledEnd ?? report.endsAt)) ?? report.endsAt
        return first...lastDay.addingTimeInterval(-60)
    }

    var body: some View {
        let scheduledStart = row.scheduledStart ?? report.startsAt
        let scheduledEnd = row.scheduledEnd ?? report.endsAt
        VMSheet {
            Text("Record attendance").scheduleType(ScheduleType.cardTitle)
            Text("Enter the times you have verified. Do not copy the scheduled times unless they are what happened.")
                .scheduleType(ScheduleType.caption).padding(.top, 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.staffName).scheduleType(ScheduleType.bodyStrong)
                Text("\(report.venueName) · \(VMText.displayRoleName(row.roleName))").scheduleType(ScheduleType.caption)
                Text("\(CrewflowDateFormat.weekdayDay(scheduledStart)) · Scheduled \(VMDate.reportTimeRange(scheduledStart, scheduledEnd))")
                    .scheduleType(ScheduleType.caption)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(VMColor.reportPage))
            .padding(.top, 14)
            .accessibilityElement(children: .combine)

            VStack(alignment: .leading, spacing: 14) {
                // The pickers only START at the scheduled day; nothing is stored until confirmed.
                VMOptionalDateTimeField(label: "Actual clock-in", value: $draft.clockIn, anchor: scheduledStart, range: range,
                                        enabled: !saving && !uncertain, error: errors[.clockIn])
                    .accessibilityIdentifier("vm.record.clockIn")
                VMOptionalDateTimeField(label: "Actual clock-out", value: $draft.clockOut, anchor: scheduledEnd, range: range,
                                        enabled: !saving && !uncertain, error: errors[.clockOut])
                    .accessibilityIdentifier("vm.record.clockOut")
                VMField(label: "Break (minutes)", error: errors[.breakMinutes]) {
                    TextField("Minutes", text: $draft.breakText).keyboardType(.numberPad).vmInputBox().disabled(saving || uncertain)
                    Text("Scheduled: \(row.scheduledBreakMinutes) min").scheduleType(ScheduleType.caption)
                }
                Text("Hours and pay are calculated by the server when you save.").scheduleType(ScheduleType.caption)
                VMField(label: "Reason for recording attendance", error: errors[.reason]) {
                    Menu {
                        ForEach(AttendanceRecordReason.allCases) { reason in
                            Button(reason.label) {
                                draft.reason = reason
                                errors[.reason] = nil
                                errors[.note] = nil
                            }
                        }
                    } label: {
                        HStack {
                            Text(draft.reason?.label ?? "Select a reason")
                                .scheduleType(draft.reason == nil ? ScheduleType.secondary : ScheduleType.body)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.down").accessibilityHidden(true)
                        }
                        .foregroundStyle(ScheduleTokens.ink)
                        .vmInputBox()
                    }
                    .disabled(saving || uncertain)
                    .accessibilityIdentifier("vm.record.reason")
                }
                if draft.reason == .other {
                    VMField(label: "Explanation", error: errors[.note]) {
                        TextField("Explain what happened…", text: $draft.note, axis: .vertical)
                            .lineLimit(2...4)
                            .vmInputBox()
                            .disabled(saving || uncertain)
                            .onChange(of: draft.note) { value in
                                errors[.note] = nil
                                if value.count > 500 { draft.note = String(value.prefix(500)) }
                            }
                    }
                }
                if let serverError {
                    VMErrorPanel(title: serverError.title, message: serverError.message)
                }
            }
            .padding(.top, 16)
            .onChange(of: draft) { _ in
                if !errors.isEmpty { errors = [:] }
            }

            PrimaryButton(uncertain ? "Close and reload" : "Save attendance", isBusy: saving, background: ScheduleTokens.navy) {
                if uncertain { done(nil) } else { Task { await save() } }
            }
            .padding(.top, 20)
            .accessibilityIdentifier("vm.record.save")
            if !uncertain {
                Button("Cancel") { done(nil) }
                    .scheduleType(ScheduleType.button.colored(ScheduleTokens.ink))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(saving)
            }
        }
    }

    @MainActor
    private func save() async {
        guard !saving, !uncertain else { return }
        let now = clock?.now()
        let validation = draft.validate(now: now)
        guard validation.isEmpty, let body = draft.body(expectedVersion: row.attendanceVersion, now: now) else {
            errors = validation
            return
        }
        saving = true
        serverError = nil
        defer { saving = false }
        do {
            let fresh = try await store.repository.recordAttendance(shiftId: report.shiftId, staffProfileId: row.staffProfileId, body: body)
            // No success toast: the review screen shows the saved attendance.
            done(fresh)
        } catch let failure as APIError where failure.isUncertainOutcome {
            uncertain = true
            serverError = (title: "Attendance not confirmed", message: VMUncertain.message)
        } catch {
            let api = error as? APIError
            if api == .cancelled || api == .sessionChanged { return }
            let invalid = api?.code == "INVALID_ATTENDANCE_TIMES" || api?.statusCode == 400
            serverError = (title: invalid ? "Invalid attendance times" : "Attendance not saved",
                           message: invalid ? userMessage(for: error, fallback: "Check the clock-in, clock-out and break values.") : userMessage(for: error))
        }
    }
}

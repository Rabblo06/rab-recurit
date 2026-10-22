import SwiftUI

/// Shift report (Flutter `ShiftReportScreen`): staff cards with badges from
/// persisted server state, the lifecycle notice, and ONE footer rendered from
/// the server's `actions` (Time-sheet; Finalise & send gated by
/// `actions.finalise` / `finalisable`, never by the client clock). One
/// finalisation at a time; success shows in place (no toast).
struct VMShiftReportView: View {
    let shiftId: String

    private enum Destination {
        case review(ShiftReportDetail, ShiftReportStaffRow)
        case document
    }

    @EnvironmentObject private var store: VenueManagerStore
    @State private var report: ShiftReportDetail?
    @State private var error: String?
    @State private var loading = true
    @State private var finalising = false
    @State private var signOff: VMSheetItem<ShiftReportDetail>?
    @State private var destination: Destination?

    var body: some View {
        VMPage(title: "Shift report", background: VMColor.reportPage) {
            if let report {
                content(report)
            } else if loading {
                VMInlineLoading(label: "Loading report")
            } else {
                VStack(spacing: 12) {
                    MessageCard(title: error ?? "Could not load this report.", kind: .error)
                    ReportButton(title: "Retry") { Task { await load() } }
                }
                .padding(24)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let report { actionBar(report) }
        }
        .task { await load() }
        .sheet(item: $signOff, onDismiss: { finalising = false }) { item in
            VMSignOffSheet(report: item.value) { finalised in
                signOff = nil
                if let finalised { report = finalised }
                Task { await load() }
            }
            .presentationDetents([.large])
        }
        .vmDestination($destination, onReturn: { Task { await load() } }) { destination in
            switch destination {
            case .review(let report, let row): VMReviewStaffReportView(report: report, row: row)
            case .document: VMReportDocumentView(shiftId: shiftId, preShift: false)
            }
        }
        .accessibilityIdentifier("vm.shiftReport")
    }

    @MainActor
    private func load() async {
        loading = true
        error = nil
        do {
            report = try await store.report(for: shiftId)
        } catch {
            let api = error as? APIError
            if api != .cancelled, api != .sessionChanged {
                self.error = vmMessage(error, fallback: "Could not load this report.")
            }
        }
        loading = false
    }

    private func content(_ report: ShiftReportDetail) -> some View {
        let ended = reportEnded(report)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(report.venueName).scheduleType(ScheduleType.pageTitle).frame(maxWidth: .infinity, alignment: .leading)
                        Text(CrewflowDateFormat.weekdayDay(report.startsAt)).scheduleType(ScheduleType.secondary)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(report.venueName).scheduleType(ScheduleType.pageTitle)
                        Text(CrewflowDateFormat.weekdayDay(report.startsAt)).scheduleType(ScheduleType.secondary)
                    }
                }
                ReportCard {
                    HStack(alignment: .top) {
                        summary(VMDate.reportTimeRange(report.startsAt, report.endsAt), "Scheduled shift")
                        summary("\(report.staff.count) staff", report.isFinalised ? "Finalised" : "To review")
                    }
                }
                .padding(.top, 16)
                if let notice = reportNotice(report) {
                    ReportNotice(title: notice.title, message: notice.message).padding(.top, 14)
                }
                HStack {
                    Text("Staff reports").scheduleType(ScheduleType.cardTitle).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Text("\(report.reviewedCount) of \(report.staff.count) reviewed").scheduleType(ScheduleType.caption)
                }
                .padding(.top, 22)
                if report.staff.isEmpty {
                    MessageCard(title: "No confirmed staff for this shift.").padding(.top, 12)
                }
                ForEach(report.staff) { row in
                    VMStaffReportCard(row: row, ended: ended, finalised: report.isFinalised) {
                        destination = .review(report, row)
                    }
                    .padding(.top, 14)
                }
                if let signOff = report.signOff {
                    Text("Signed off as \"\(signOff.name)\"" + (signOff.signedAt.map { " on \(CrewflowDateFormat.dayTime($0))" } ?? ""))
                        .scheduleType(ScheduleType.caption).padding(.top, 14)
                }
            }
            .padding(EdgeInsets(top: 8, leading: 20, bottom: 24, trailing: 20))
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await load() }
    }

    private func summary(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).scheduleType(ScheduleType.bodyStrong)
            Text(label).scheduleType(ScheduleType.caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// The ONE footer, from the server's `actions`; none before the
    /// pre-shift window.
    @ViewBuilder
    private func actionBar(_ report: ShiftReportDetail) -> some View {
        if let actions = report.actions {
            let showFinalise = actions.showFinalise && store.allows(.reportExport)
            if actions.showTimesheet || showFinalise {
                VStack(spacing: 10) {
                    if showFinalise, !actions.canFinalise, let reason = report.finaliseBlockedReason {
                        Text(reason).scheduleType(ScheduleType.caption).multilineTextAlignment(.center)
                            .accessibilityIdentifier("vm.report.blockedReason")
                    }
                    HStack(spacing: 12) {
                        if actions.showTimesheet {
                            ReportButton(title: "Time-sheet") { destination = .document }
                                .accessibilityIdentifier("vm.report.timesheet")
                        }
                        if showFinalise {
                            ReportButton(title: "Finalise & send", busy: finalising, enabled: FinaliseGate.serverReady(report) && actions.canFinalise) {
                                guard !finalising else { return }
                                finalising = true
                                signOff = VMSheetItem(value: report)
                            }
                            .accessibilityIdentifier("vm.report.finalise")
                        }
                    }
                }
                .padding(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20))
                .frame(maxWidth: .infinity)
                .background(VMColor.reportPage.opacity(0.97).ignoresSafeArea())
            }
        }
    }
}

/// One staff card on the shift report.
struct VMStaffReportCard: View {
    let row: ShiftReportStaffRow
    let ended: Bool
    let finalised: Bool
    let onReview: () -> Void

    var body: some View {
        let badge = staffReportBadge(row, ended: ended, finalised: finalised)
        let missingOut = ended && row.clockInAt != nil && row.clockOutAt == nil && row.assignmentStatus != "no_show"
        ReportCard {
            VStack(alignment: .leading, spacing: 0) {
                ViewThatFits(in: .horizontal) {
                    HStack {
                        Text(row.staffName).scheduleType(ScheduleType.cardTitle).frame(maxWidth: .infinity, alignment: .leading)
                        ReportBadge(badge)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(row.staffName).scheduleType(ScheduleType.cardTitle)
                        ReportBadge(badge)
                    }
                }
                .padding(.bottom, 12)
                ReportField("Scheduled", row.scheduledStart.flatMap { s in row.scheduledEnd.map { VMDate.reportTimeRange(s, $0) } } ?? "—")
                ReportField("Clock in", row.clockInAt.map(VMDate.hm) ?? "—")
                ReportField("Clock out", row.clockOutAt.map(VMDate.hm) ?? (missingOut ? "Missing" : "—"),
                            valueColor: missingOut ? VMColor.missingText : nil)
                ReportField("Break", "\(row.breakMinutes ?? row.scheduledBreakMinutes) min\(row.breakMinutes == nil ? " (scheduled)" : "")")
                ReportField("Worked", vmWorkedLabel(row))
                if row.corrected { ReportField("", "Corrected", valueColor: VMColor.reportMuted) }
                if row.attendanceReviewed {
                    ReportField("Reviewed by", ([row.attendanceReviewedByName ?? "Manager"] + (row.attendanceReviewedAt.map { [CrewflowDateFormat.dayTime($0)] } ?? [])).joined(separator: " · "))
                }
                ReportButton(title: row.attendanceReviewed || finalised ? "View hours" : "Review hours", action: onReview)
                    .padding(.top, 8)
                    .accessibilityIdentifier("vm.report.review.\(row.staffProfileId)")
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Manager sign-off (Flutter `SignOffSheet`): break confirmation + typed
/// full name; "Sign & send" stays disabled until both are given AND the
/// SERVER says the report is ready. One request at a time (the route is
/// repeat-safe anyway). Returns the server's report on success.
struct VMSignOffSheet: View {
    let report: ShiftReportDetail
    let done: (ShiftReportDetail?) -> Void

    @EnvironmentObject private var store: VenueManagerStore
    @State private var name = ""
    @State private var breaksConfirmed = false
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        let missing = report.missingClockOut
        let ready = FinaliseGate.serverReady(report)
        VMSheet {
            Text("Sign off the timesheet").scheduleType(ScheduleType.heading)
            Text("Confirm the report details before sending.").scheduleType(ScheduleType.secondary).padding(.top, 4)
            if missing > 0 || !ready {
                ReportNotice(title: missing > 0
                             ? "\(missing) staff \(VMText.plural(missing, "has", "have")) no clock-out recorded."
                             : "Attendance still needs attention.",
                             message: "Review these entries before sending.")
                    .padding(.top, 16)
            }
            Button { breaksConfirmed.toggle() } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: breaksConfirmed ? "checkmark.square.fill" : "square")
                        .font(.system(size: 22)).foregroundStyle(breaksConfirmed ? VMColor.reportNavy : VMColor.reportMuted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("I confirm break details are accurate").scheduleType(ScheduleType.body)
                        Text("and any exceptions are recorded.").scheduleType(ScheduleType.caption)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(sending)
            .padding(.top, 16)
            .accessibilityAddTraits(breaksConfirmed ? .isSelected : [])
            .accessibilityIdentifier("vm.signoff.breaks")

            Text("Manager signature").scheduleType(ScheduleType.caption).padding(.top, 14)
            TextField("Type your full name to sign", text: $name)
                .textInputAutocapitalization(.words)
                .multilineTextAlignment(.center)
                .font(.system(.title3).italic())
                .padding(.vertical, 24)
                .padding(.horizontal, 14)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(RGBA(argb: 0xFFF3F4F6).color))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(VMColor.divider, lineWidth: 1))
                .disabled(sending)
                .onChange(of: name) { value in if value.count > 120 { name = String(value.prefix(120)) } }
                .padding(.top, 6)
                .accessibilityIdentifier("vm.signoff.name")
            Text("Your account, the time and this typed name are recorded with the report. It is not a handwritten signature.")
                .scheduleType(ScheduleType.caption).padding(.top, 6)
            if let error {
                MessageCard(title: error, kind: .error).padding(.top, 12)
            }
            ReportButton(title: "Sign & send", busy: sending,
                         enabled: FinaliseGate.canSign(report, breaksConfirmed: breaksConfirmed, name: name)) {
                Task { await send() }
            }
            .padding(.top, 18)
            .accessibilityIdentifier("vm.signoff.send")
            Button("Back to report") { done(nil) }
                .scheduleType(ScheduleType.body.colored(VMColor.reportMuted))
                .frame(maxWidth: .infinity, minHeight: 44)
                .disabled(sending)
        }
        .interactiveDismissDisabled(sending)
    }

    @MainActor
    private func send() async {
        guard !sending, FinaliseGate.canSign(report, breaksConfirmed: breaksConfirmed, name: name) else { return }
        sending = true
        error = nil
        defer { sending = false }
        do {
            let fresh = try await store.repository.finalise(shiftId: report.shiftId,
                                                            signedOffName: name.trimmingCharacters(in: .whitespacesAndNewlines))
            done(fresh)
        } catch let failure as APIError where failure.isUncertainOutcome {
            // Repeat-safe on the server, but never assumed: close and reload
            // so the report shows what the server holds.
            _ = failure
            done(nil)
        } catch {
            let api = error as? APIError
            if api == .cancelled || api == .sessionChanged { return }
            self.error = userMessage(for: error)
        }
    }
}

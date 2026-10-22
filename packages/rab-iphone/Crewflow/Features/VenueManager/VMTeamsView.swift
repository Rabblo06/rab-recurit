import SwiftUI

/// Venue Manager "Teams" for one shift (Flutter `VenueTeamsScreen`). The
/// Team Leader row is the signed-in Venue Manager (a label, never an
/// authority). "Your team" is the shift report's seats with each one's real
/// Check In / attendance state. With `attendance.edit` (display hint) a row
/// offers Clock-In (only after the staff member's own Check In) or Clock-out
/// ON BEHALF, each with a ≥ 10-word reason; the server enforces every rule.
/// No success toast: the row itself shows the server's new state.
///
/// Backend: on-behalf routes + check-in fields need migration 1786719450000
/// (D1/D2, not yet on dev).
struct VMTeamsView: View {
    let event: VenueEvent

    private enum Sheet: Identifiable {
        case blocked(ShiftReportStaffRow, TeamRowAction, OnBehalfBlock)
        case reason(ShiftReportDetail, ShiftReportStaffRow, TeamRowAction)

        var id: String {
            switch self {
            case .blocked(let row, _, _): return "blocked-\(row.staffProfileId)"
            case .reason(_, let row, _): return "reason-\(row.staffProfileId)"
            }
        }
    }

    @EnvironmentObject private var store: VenueManagerStore
    @EnvironmentObject private var session: SessionCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @State private var report: ShiftReportDetail?
    @State private var clock: VMServerClock?
    @State private var error: String?
    @State private var loading = true
    @State private var generation = 0
    @State private var sheet: Sheet?
    @State private var openReviewAfterSheet: ShiftReportStaffRow?
    @State private var review: (ShiftReportDetail, ShiftReportStaffRow)?
    @State private var visible = false

    var body: some View {
        VStack(spacing: 0) {
            NavHeader("Teams", backgroundColor: .white).padding(.horizontal, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    summaryCard
                    sectionTitle("Team Leader", count: 1).padding(.top, 22)
                    leaderRow.padding(.top, 8)
                    sectionTitle("Your team", count: report?.staff.count).padding(.top, 22)
                    teamContent.padding(.top, 8)
                }
                .padding(EdgeInsets(top: 8, leading: 20, bottom: 32, trailing: 20))
                .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await load(silent: false) }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityIdentifier("vm.teams")
        .task { await load(silent: false) }
        .task(id: visible) { await poll() }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await load(silent: true) } }
        }
        .sheet(item: $sheet, onDismiss: sheetDismissed) { sheet in
            switch sheet {
            case .blocked(let row, let action, let block):
                VMBlockedSheet(row: row, action: action, block: block) { openReport in
                    if openReport { openReviewAfterSheet = row }
                    self.sheet = nil
                }
                .presentationDetents([.medium, .large])
            case .reason(let report, let row, let action):
                VMOnBehalfReasonSheet(report: report, row: row, action: action, venue: event.venue) { outcome in
                    switch outcome {
                    case .saved(let fresh):
                        if fresh.shiftId == event.id { apply(fresh) }
                    case .openReport:
                        openReviewAfterSheet = row
                    case .cancelled:
                        break
                    }
                    self.sheet = nil
                }
                .presentationDetents([.large])
                .interactiveDismissDisabled()
            }
        }
        .vmDestination($review, onReturn: { Task { await load(silent: true) } }) { item in
            VMReviewStaffReportView(report: item.0, row: item.1)
        }
    }

    // MARK: Loading

    private func apply(_ fresh: ShiftReportDetail) {
        report = fresh
        if let next = VMServerClock(serverNow: fresh.serverNow) { clock = next }
    }

    @MainActor
    private func load(silent: Bool) async {
        generation += 1
        let stamp = generation
        if !silent {
            loading = true
            error = nil
        }
        do {
            let fresh = try await store.report(for: event.id, background: silent)
            guard stamp == generation else { return }
            apply(fresh)
            error = nil
        } catch {
            guard stamp == generation else { return }
            let api = error as? APIError
            // A silent refresh never replaces good rows with an error.
            if api != .cancelled, api != .sessionChanged, !silent || report == nil {
                self.error = vmMessage(error, fallback: "Unable to load your team.")
            }
        }
        if stamp == generation { loading = false }
    }

    /// Staff check in on their own phones: keep rows current while visible
    /// (30 s, background-flagged so it never keeps an idle session alive).
    @MainActor
    private func poll() async {
        guard visible else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled, visible, scenePhase == .active else { continue }
            await load(silent: true)
        }
    }

    private func sheetDismissed() {
        if let row = openReviewAfterSheet, let report {
            openReviewAfterSheet = nil
            review = (report, report.row(for: row.staffProfileId) ?? row)
        } else {
            // Cancelled or refused: the seat may have changed meanwhile.
            Task { await load(silent: true) }
        }
    }

    private func onAction(_ row: ShiftReportStaffRow, _ action: TeamRowAction) {
        guard let report else { return }
        // Known refusals are explained without sending anything.
        if let block = onBehalfPrecheck(row, action: action, policy: report.attendancePolicy) {
            sheet = .blocked(row, action, block)
        } else {
            sheet = .reason(report, row, action)
        }
    }

    // MARK: Pieces

    private var summaryCard: some View {
        let now = clock?.now()
        let day = now.map { VMDate.sameDay(event.start, $0) } == true ? "Today" : CrewflowDateFormat.weekdayDay(event.start)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                VMVenuePhoto(fileId: event.shift.venuePhotoFileId, size: 44, placeholder: ScheduleTokens.lavender, label: "\(event.venue) photo")
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.venue).scheduleType(ScheduleType.cardTitle.colored(.white))
                    Text("\(day) · \(VMDate.hm(event.start)) – \(VMDate.hm(event.end))")
                        .scheduleType(ScheduleType.secondary.colored(.white.opacity(0.8)))
                }
            }
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                countdown
            }
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(ScheduleTokens.navy))
    }

    /// Server-anchored; no device-clock fallback.
    @ViewBuilder
    private var countdown: some View {
        let start = report?.startsAt ?? event.start
        let end = report?.endsAt ?? event.end
        if let now = clock?.now() {
            if now < start {
                VMCountdownPanel(heading: "Your shift starts in", seconds: Int(start.timeIntervalSince(now)), warning: true)
            } else if now < end {
                VMCountdownPanel(heading: "Shift in progress", seconds: Int(now.timeIntervalSince(start)))
            } else {
                VMCountdownPanel(heading: "Shift ended", seconds: nil)
            }
        } else {
            VMCountdownPanel(heading: "Shift time", seconds: nil)
        }
    }

    private func sectionTitle(_ title: String, count: Int?) -> some View {
        HStack(alignment: .lastTextBaseline) {
            Text(title).scheduleType(ScheduleType.cardTitle).accessibilityAddTraits(.isHeader)
            Spacer()
            if let count { Text("\(count) \(VMText.plural(count, "person", "people"))").scheduleType(ScheduleType.caption) }
        }
    }

    private var leaderRow: some View {
        let name = session.user?.fullName ?? "You"
        return HStack(spacing: 14) {
            InitialsAvatar(name: name, size: 42, background: RGBA(argb: 0xFFD6EFE2).color)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(name).scheduleType(ScheduleType.bodyStrong)
                    Text("You").scheduleType(ScheduleType.badge.colored(VMColor.countdownGreen))
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 6).fill(RGBA(argb: 0xFFD6EFE2).color))
                }
                Text(VMDate.eventTime(event.start, event.end)).scheduleType(ScheduleType.caption)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(RGBA(argb: 0xFFEFF8F3).color))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(VMColor.rowBorder, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Team Leader, \(name), you")
    }

    @ViewBuilder
    private var teamContent: some View {
        if report == nil && loading {
            VMInlineLoading(label: "Loading your team")
        } else if let report {
            if report.staff.isEmpty {
                MessageCard(title: "No confirmed staff yet.")
            } else {
                let canEdit = store.allows(.attendanceEdit)
                VStack(spacing: 0) {
                    ForEach(Array(report.staff.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Divider() }
                        VMTeamRow(
                            row: row,
                            tone: [ScheduleTokens.lavender, RGBA(argb: 0xFFEDEEF2).color, ScheduleTokens.homeMint][index % 3],
                            start: row.scheduledStart ?? report.startsAt,
                            end: row.scheduledEnd ?? report.endsAt,
                            action: teamRowAction(row, canEdit: canEdit, finalised: report.isFinalised)
                        ) { action in onAction(row, action) }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(ScheduleTokens.border, lineWidth: 1))
            }
        } else {
            MessageCard(title: "Team unavailable", message: error ?? "Unable to load your team.", kind: .error, actionTitle: "Retry") {
                Task { await load(silent: false) }
            }
        }
    }
}

private struct VMTeamRow: View {
    let row: ShiftReportStaffRow
    let tone: Color
    let start: Date
    let end: Date
    let action: TeamRowAction?
    let onAction: (TeamRowAction) -> Void

    var body: some View {
        let state = teamRowState(row)
        let byManager = row.clockInMethod == "manager_on_behalf" ? row.clockInByName : nil
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                InitialsAvatar(name: row.staffName, size: 42, background: tone)
                details(state, byManager: byManager).frame(maxWidth: .infinity, alignment: .leading)
                actionButton
            }
            HStack(alignment: .top, spacing: 12) {
                InitialsAvatar(name: row.staffName, size: 42, background: tone)
                VStack(alignment: .leading, spacing: 8) {
                    details(state, byManager: byManager)
                    actionButton
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
    }

    private func details(_ state: (label: String, tone: TeamChipTone), byManager: String?) -> some View {
        let colors: (Color, Color) = {
            switch state.tone {
            case .ok: return (VMColor.countdownMint, VMColor.countdownGreen)
            case .warning: return (VMColor.amberSurface, VMColor.amberText)
            case .danger: return (ScheduleTokens.dangerSoft, ScheduleTokens.errorText)
            case .neutral: return (RGBA(argb: 0xFFEDEEF2).color, ScheduleTokens.ink)
            }
        }()
        return VStack(alignment: .leading, spacing: 4) {
            Text(row.staffName).scheduleType(ScheduleType.bodyStrong).lineLimit(2)
            Text("\(VMDate.hm(start)) – \(VMDate.hm(end))").scheduleType(ScheduleType.caption)
            VMPill(state.label, background: colors.0, foreground: colors.1)
                .accessibilityIdentifier("vm.team.chip.\(row.staffProfileId)")
            if let byManager { Text("Clocked in by \(byManager)").scheduleType(ScheduleType.caption) }
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        if let action {
            Button { onAction(action) } label: {
                Text(action == .clockIn ? "Clock-In" : "Clock-out")
                    .scheduleType(ScheduleType.badge.colored(.white))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(ScheduleTokens.accent))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel(action == .clockIn ? "Clock in \(row.staffName)" : "Clock out \(row.staffName)")
            .accessibilityIdentifier("vm.team.action.\(row.staffProfileId)")
        }
    }
}

/// A refusal explained without sending anything.
private struct VMBlockedSheet: View {
    let row: ShiftReportStaffRow
    let action: TeamRowAction
    let block: OnBehalfBlock
    let close: (_ openReport: Bool) -> Void

    var body: some View {
        let first = VMText.firstName(row.staffName)
        VMSheet {
            Text(action == .clockIn ? "Clock in \(first)?" : "Clock out \(first)?").scheduleType(ScheduleType.heading)
            Text(action == .clockIn ? "Clock in on behalf of this team member." : "Clock out on behalf of this team member.")
                .scheduleType(ScheduleType.secondary).padding(.top, 6)
            VMErrorPanel(title: block.panelTitle, message: block.panelMessage).padding(.top, 18)
            VStack(spacing: 10) {
                if block.offersReport {
                    PrimaryButton("Review staff report", variant: .light) { close(true) }
                }
                PrimaryButton("Back") { close(false) }
            }
            .padding(.top, 24)
        }
        .accessibilityIdentifier("vm.team.blocked")
    }
}

enum OnBehalfOutcome {
    case saved(ShiftReportDetail)
    case openReport
    case cancelled
}

/// "Clock in Lucy?" / "Clock out Lucy?" with a required reason of at least
/// `onBehalfReasonMinWords` words (server re-checks). A refusal stays in the
/// sheet; PRESENCE_EVIDENCE_REQUIRED guides to Record attendance. A
/// non-repeatable request whose result is unknown is never resent.
struct VMOnBehalfReasonSheet: View {
    let report: ShiftReportDetail
    let row: ShiftReportStaffRow
    let action: TeamRowAction
    let venue: String
    let finish: (OnBehalfOutcome) -> Void

    @EnvironmentObject private var store: VenueManagerStore
    @State private var reason = ""
    @State private var busy = false
    @State private var error: String?
    @State private var guidesToReport = false
    @State private var uncertain = false

    private var minWords: Int { report.attendancePolicy?.onBehalfReasonMinWords ?? 10 }

    var body: some View {
        let first = VMText.firstName(row.staffName)
        let clockIn = action == .clockIn
        let words = reasonWordCount(reason)
        let enough = onBehalfReasonAccepted(reason, policy: report.attendancePolicy)
        VMSheet {
            Text(clockIn ? "Clock in \(first)?" : "Clock out \(first)?").scheduleType(ScheduleType.heading)
            Text(clockIn ? "Clock in on behalf of this team member." : "Clock out on behalf of this team member.")
                .scheduleType(ScheduleType.secondary).padding(.top, 6)
            HStack(spacing: 12) {
                InitialsAvatar(name: row.staffName, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.staffName).scheduleType(ScheduleType.bodyStrong)
                    Text("\(venue) · \(VMDate.hm(row.scheduledStart ?? report.startsAt))–\(VMDate.hm(row.scheduledEnd ?? report.endsAt))")
                        .scheduleType(ScheduleType.caption)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ScheduleTokens.homeBackground))
            .padding(.top, 16)
            .accessibilityElement(children: .combine)

            Text("Reason*").scheduleType(ScheduleType.bodyStrong).padding(.top, 18)
            TextField(clockIn ? "Add a \(minWords) words reason for this manual clock-in…" : "Add a \(minWords) words reason for this manual clock-out…",
                      text: $reason, axis: .vertical)
                .lineLimit(3...6)
                .textInputAutocapitalization(.sentences)
                .disabled(busy || uncertain)
                .vmInputBox()
                .padding(.top, 8)
                .onChange(of: reason) { value in
                    if value.count > 1000 { reason = String(value.prefix(1000)) }
                }
                .accessibilityLabel("Reason, required, at least \(minWords) words")
                .accessibilityIdentifier("vm.team.reason")
            Text(enough ? "\(words) words" : "\(words) of \(minWords) words — add at least \(minWords) words.")
                .scheduleType(ScheduleType.caption.colored(enough || words == 0 ? ScheduleTokens.muted : ScheduleTokens.errorText))
                .padding(.top, 6)
                .accessibilityIdentifier("vm.team.reasonCount")

            if let error {
                VMErrorPanel(title: clockIn ? "Clock-in not recorded" : "Clock-out not recorded", message: error).padding(.top, 12)
                if guidesToReport {
                    PrimaryButton("Record attendance in the report", variant: .light) { finish(.openReport) }.padding(.top, 10)
                }
            }

            HStack(spacing: 10) {
                PrimaryButton(uncertain ? "Close" : "Cancel", variant: .light) { finish(.cancelled) }
                    .disabled(busy)
                    .frame(maxWidth: .infinity)
                PrimaryButton(clockIn ? "Confirm clock-in" : "Confirm clock-out", isBusy: busy) { Task { await submit() } }
                    .disabled(!enough || uncertain)
                    .frame(maxWidth: .infinity)
                    .layoutPriority(1)
                    .accessibilityIdentifier("vm.team.confirm")
            }
            .padding(.top, 24)
        }
    }

    @MainActor
    private func submit() async {
        guard !busy, !uncertain, onBehalfReasonAccepted(reason, policy: report.attendancePolicy) else { return }
        busy = true
        error = nil
        guidesToReport = false
        defer { busy = false }
        let repository = store.repository
        do {
            let fresh = action == .clockIn
                ? try await repository.clockInOnBehalf(shiftId: report.shiftId, staffProfileId: row.staffProfileId, reason: reason)
                : try await repository.clockOutOnBehalf(shiftId: report.shiftId, staffProfileId: row.staffProfileId, reason: reason)
            finish(.saved(fresh))
        } catch let failure as APIError where failure.isUncertainOutcome {
            // The punch may have been applied: never resend; the team reloads on close.
            uncertain = true
            error = VMUncertain.message
        } catch {
            if (error as? APIError)?.isCancellation == true || (error as? APIError) == .sessionChanged { return }
            self.error = VMAttendanceMessages.forManager(error)
            guidesToReport = VMAttendanceMessages.guidesToRecordAttendance(error)
        }
    }
}

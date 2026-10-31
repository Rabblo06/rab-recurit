import SwiftUI
import UIKit

/// Check In → Clock In → Clock Out (Flutter `ScheduleClockScreen`), and its
/// Teams variant (`teams: true`: navy countdown card + team list).
///
/// Every time shown is server time (`StaffStore.attendanceNow` = serverNow +
/// monotonic elapsed). Nothing is optimistic: the screen changes only after
/// the server answered. Clock-in/out are never resent automatically.
struct StaffClockScreen: View {
    let snapshot: StaffOfferSummary?
    let teams: Bool

    @EnvironmentObject private var store: StaffStore

    var body: some View {
        StaffClockContent(snapshot: snapshot, teams: teams, store: store)
    }
}

private struct StaffClockContent: View {
    let snapshot: StaffOfferSummary?
    let teams: Bool

    @ObservedObject private var store: StaffStore
    @StateObject private var prompts: StaffAttendancePrompts
    @StateObject private var flow: StaffClockFlow
    @EnvironmentObject private var navigator: StaffNavigator
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.shellTabActive) private var tabActive

    @State private var expanded = false
    /// The team list keeps its rows across refreshes (Phase C1).
    @StateObject private var teamLoader = StaffTeamLoader()
    /// Teams screen: 30 s ±20 % silent team refresh while this screen is on
    /// screen in the selected tab and the app is in the foreground
    /// (background-flagged). Resume reloads the team on its own below.
    @StateObject private var teamPoll = PollScheduler(interval: 30, refreshOnResume: false)
    @State private var onScreen = false
    @State private var resumeToken = 0

    init(snapshot: StaffOfferSummary?, teams: Bool, store: StaffStore) {
        self.snapshot = snapshot
        self.teams = teams
        _store = ObservedObject(wrappedValue: store)
        let prompts = StaffAttendancePrompts()
        _prompts = StateObject(wrappedValue: prompts)
        _flow = StateObject(wrappedValue: StaffClockFlow(store: store, location: StaffCoreLocationProvider(), prompts: prompts))
    }

    // MARK: Derived state (recomputed from the store on every render)

    private var active: StaffAttendanceSummary? { store.liveAttendance }

    private var selected: StaffOfferSummary? {
        if let snapshot { return store.offer(id: snapshot.id) }
        if let active { return store.offer(forShift: active.shiftId) }
        return StaffShiftRules.todaysConfirmedOffer(store.offers, now: store.displayNow)
    }

    private var state: StaffDetailState? {
        StaffDetailState.clockScreen(
            completedAttendanceId: flow.completedAttendanceId,
            loading: store.activeLoading || store.historyLoading || store.offersLoading,
            failed: store.activeError != nil || store.historyError != nil || store.offersError != nil,
            requestedOfferMissing: snapshot != nil && selected == nil,
            selected: selected,
            active: store.active,
            history: store.history,
            clockableShiftId: StaffShiftRules.todaysConfirmedOffer(store.offers, now: store.displayNow)?.shiftId,
            now: store.attendanceNow
        )
    }

    private struct Snapshot {
        let state: StaffDetailState?
        let selected: StaffOfferSummary?
        let live: StaffAttendanceSummary?
        let record: StaffAttendanceSummary?
        let completed: Bool
        let awaitingMetrics: Bool
        let starts: Date?
        let ends: Date?
        let style: ShiftVisualStyle
        let photoFileId: String?
        let confirmed: Bool
        let noShift: Bool
        let status: String
        let canTeam: Bool
        let needsCheckIn: Bool
        let showCheckInNote: Bool
        let checkedInAt: Date?
        let action: StaffClockAction
        let error: String?
        let venue: String
        let address: String?
        let schedule: String?
        let isToday: Bool
    }

    private func snapshotState() -> Snapshot {
        let state = self.state
        let selected = self.selected
        let live = state == .clockOut ? active : nil
        let record: StaffAttendanceSummary?
        if let completedId = flow.completedAttendanceId {
            record = store.history.first { $0.id == completedId && $0.clockOutAt != nil }
        } else {
            record = live ?? store.history.first { $0.shiftId == selected?.shiftId && $0.clockOutAt != nil }
        }
        let completed = state == .completed
        let starts = record?.startsAt ?? selected?.startsAt
        let ends = record?.endsAt ?? selected?.endsAt
        let shiftId = selected?.shiftId ?? record?.shiftId
        let confirmed = state == .clockIn || state == .ready
        let clockable = state == .clockIn && live == nil
        let checkInRequired = selected.map { store.checkInRequired($0) } ?? false
        let checkedInAt = selected.flatMap { store.checkedInAt($0) }
        let needsCheckIn = clockable && checkInRequired && checkedInAt == nil
        let noShift = state == nil && selected == nil && record == nil
        var errorText = store.attendanceError?.message
        if errorText == nil, state == .error {
            errorText = store.activeError ?? store.historyError ?? store.offersError ?? "Unable to check shift."
        }
        var isToday = selected?.presentation?.isToday ?? false
        if selected?.presentation == nil, let now = store.attendanceNow, let starts {
            isToday = StaffFormat.london.isDate(now, inSameDayAs: starts)
        }
        let address = selected?.venueAddress?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Snapshot(
            state: state,
            selected: selected,
            live: live,
            record: record,
            completed: completed,
            awaitingMetrics: completed && record?.workedMinutes == nil,
            starts: starts,
            ends: ends,
            style: shiftId.map { ShiftVisualStyle.forShift($0) } ?? .mint,
            photoFileId: selected?.venuePhotoFileId ?? record?.venuePhotoFileId,
            confirmed: confirmed,
            noShift: noShift,
            status: StaffClockTimerModel.statusText(state),
            canTeam: selected != nil && (confirmed || live != nil),
            needsCheckIn: needsCheckIn,
            showCheckInNote: clockable && checkInRequired,
            checkedInAt: checkedInAt,
            action: StaffClockAction.resolve(state: state, noShift: noShift, live: live != nil, needsCheckIn: needsCheckIn, completed: completed, teams: teams),
            error: errorText,
            venue: record?.venueName ?? selected?.venueName ?? "Your shift",
            address: (address?.isEmpty ?? true) ? nil : address,
            schedule: (starts != nil && ends != nil) ? StaffFormat.timeSpan(starts!, ends!) : nil,
            isToday: isToday
        )
    }

    private var busy: Bool { flow.busy || flow.confirming || store.attendanceBusy }

    // MARK: Body

    var body: some View {
        let s = snapshotState()
        VStack(spacing: 0) {
            StaffScreenHeader(title: teams ? "Teams" : (s.live != nil ? "Clock out" : (s.needsCheckIn ? "Check in" : "Clock in")))
            if teams {
                teamsBody(s)
            } else {
                clockBody(s)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomArea(s) }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .staffPushedScreen()
        .accessibilityIdentifier(teams ? "staff.teams" : "staff.clock")
        .onAppear {
            store.clearAttendanceError()
            onScreen = true
            teamPoll.setVisible(tabActive)
        }
        .onDisappear {
            onScreen = false
            teamPoll.setVisible(false)
        }
        .onChange(of: tabActive) { active in teamPoll.setVisible(onScreen && active) }
        .task { await store.loadHistory(silent: !store.history.isEmpty) }
        .task(id: teamKey(s)) { await loadTeamIfNeeded(s) }
        .task { await startTeamPolling() }
        .task(id: checkInKey(s)) {
            if checkInKey(s) != nil, let shiftId = s.selected?.shiftId {
                await store.loadCheckIn(shiftId: shiftId)
            }
        }
        .task(id: nextBoundary(s)) { await refreshAtBoundary(nextBoundary(s)) }
        .onChange(of: scenePhase) { phase in
            teamPoll.setForeground(phase != .background)
            guard phase == .active else { return }
            resumeToken += 1
            Task { @MainActor in
                await refresh()
                if let shiftId = s.selected?.shiftId, s.canTeam { await loadTeam(shiftId) }
            }
        }
        .sheet(item: $prompts.sheet) { sheet in
            StaffAttendanceSheet(sheet: sheet, prompts: prompts)
                .environmentObject(store)
                .onDisappear { prompts.sheetDisappeared(sheet) }
        }
        .fullScreenCover(isPresented: $prompts.scannerVisible, onDismiss: { prompts.resolveToken(nil) }) {
            StaffQRScanScreen(title: "Scan venue QR") { token in prompts.resolveToken(token) }
        }
    }

    // MARK: Clock body

    private func clockBody(_ s: Snapshot) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    if s.awaitingMetrics {
                        StaffClockStatusBadge(label: "Clocked Out")
                    } else {
                        StaffHeroTimer(snapshot: timerInput(s))
                    }
                    Spacer(minLength: 8)
                    if s.selected != nil || s.record != nil {
                        StaffVenuePhoto(fileId: s.photoFileId, size: 96, circle: true, placeholder: s.style.badgeSurface, iconScale: 0.4, label: "\(s.venue) photo")
                    }
                }
                clockCard(s)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
        .refreshable { await refresh() }
    }

    private func clockCard(_ s: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                StaffVenuePhoto(fileId: s.photoFileId, size: 44, radius: 14, placeholder: s.style.badgeSurface, label: "\(s.venue) photo")
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.venue).scheduleType(ScheduleType.venueTitle).lineLimit(2)
                    if let address = s.address {
                        Text(address).scheduleType(ScheduleType.caption).lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                Button { toggleExpanded() } label: {
                    Image(systemName: expanded ? "arrow.down.right" : "arrow.up.right")
                        .staffFont(18, .semibold)
                        .foregroundStyle(ScheduleTokens.ink)
                        .frame(width: 48, height: 48)
                        .background(Circle().fill(Color.white))
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(expanded ? "Collapse details" : "Expand details")
            }
            Divider().overlay(s.style.cardBorder)
            HStack(alignment: .top, spacing: 12) {
                field("ROLE", s.record?.roleName ?? s.selected?.roleName ?? "No shift assigned today.")
                if let selected = s.selected {
                    Spacer(minLength: 8)
                    field("PAY RATE", Money.payRateLabel(selected.payRatePence), trailing: true)
                }
            }
            if expanded, let schedule = s.schedule {
                HStack(spacing: 8) {
                    Image(systemName: "clock").accessibilityHidden(true)
                    Text(schedule).scheduleType(ScheduleType.bodyStrong)
                }
            }
            if s.canTeam, let selected = s.selected {
                Button { navigator.push(.teams(selected)) } label: {
                    HStack {
                        Text("Your team").scheduleType(ScheduleType.secondary)
                        Spacer()
                        if !teamLoader.members.isEmpty, teamLoader.shiftId == selected.shiftId {
                            StaffAvatarStack(names: teamLoader.members.map(\.displayName))
                        }
                        Image(systemName: "chevron.right").foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
                    }
                    .frame(minHeight: ScheduleTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityIdentifier("staff.clock.team")
            }
            if !expanded {
                Button { toggleExpanded() } label: {
                    Text("View shift details & dress code")
                        .scheduleType(ScheduleType.bodyStrong)
                        .frame(maxWidth: .infinity, minHeight: ScheduleTokens.touchTarget, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                StaffNoteCard(notes: s.selected?.shiftNotes, style: s.style).padding(.top, 4)
            }
            if s.completed {
                MessageCard(
                    title: "Shift completed",
                    message: s.awaitingMetrics ? "Updating worked time…" : "\(s.record?.workedMinutes ?? 0) minutes worked",
                    kind: .success
                )
                .accessibilityIdentifier("staff.clock.completed")
                if s.awaitingMetrics {
                    Button("Refresh worked time") { Task { await store.loadHistory() } }
                        .disabled(store.historyLoading)
                        .frame(minHeight: 44)
                }
            }
        }
        .padding(EdgeInsets(top: 16, leading: 18, bottom: 18, trailing: 18))
        .background(
            RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous)
                .fill(LinearGradient(colors: [s.style.strongBackground, s.style.card], startPoint: .top, endPoint: .bottom))
        )
        .overlay(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).stroke(s.style.cardBorder, lineWidth: 1))
        .shadow(color: s.style.shadowColor, radius: 9, x: 0, y: 5)
    }

    private func field(_ label: String, _ value: String, trailing: Bool = false) -> some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 4) {
            Text(label).scheduleType(ScheduleType.overline)
            Text(value)
                .scheduleType(ScheduleType.cardTitle)
                .multilineTextAlignment(trailing ? .trailing : .leading)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Teams body

    private func teamsBody(_ s: Snapshot) -> some View {
        let day: String? = s.starts.map { s.isToday ? "Today" : CrewflowDateFormat.weekdayDay($0) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                StaffNavySummaryCard(
                    venue: s.venue,
                    schedule: (day != nil && s.schedule != nil) ? "\(day!) · \(s.schedule!)" : nil,
                    photoFileId: s.photoFileId,
                    placeholder: s.style.badgeSurface
                ) {
                    StaffTeamCountdown(snapshot: timerInput(s))
                }
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Your team").scheduleType(ScheduleType.cardTitle).accessibilityAddTraits(.isHeader)
                        Text("Working together on this shift").scheduleType(ScheduleType.caption)
                    }
                    Spacer()
                    if s.canTeam, !teamLoader.loading, teamLoader.error == nil {
                        Text("\(teamLoader.members.count) \(teamLoader.members.count == 1 ? "person" : "people")").scheduleType(ScheduleType.caption)
                    }
                }
                .padding(.top, 24)
                .padding(.bottom, 12)
                teamContent(s)
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 16)
        }
        .refreshable {
            await refresh()
            if let shiftId = s.selected?.shiftId { await loadTeam(shiftId) }
        }
    }

    @ViewBuilder
    private func teamContent(_ s: Snapshot) -> some View {
        if teamLoader.loading {
            ProgressView().frame(maxWidth: .infinity).padding(24)
        } else if let teamError = teamLoader.error {
            MessageCard(title: "Team unavailable", message: teamError, kind: .error, actionTitle: s.selected == nil ? nil : "Retry") {
                if let shiftId = s.selected?.shiftId { Task { await loadTeam(shiftId) } }
            }
        } else if !s.canTeam {
            MessageCard(title: "Team unavailable", message: "Team visibility requires a current confirmed assignment.")
        } else {
            if teamLoader.stale { StaleRefreshNotice() }
            if teamLoader.members.isEmpty {
                MessageCard(title: "No confirmed teammates yet")
            } else {
                StaffTeamList(members: teamLoader.members)
            }
        }
    }

    // MARK: Bottom area

    private func bottomArea(_ s: Snapshot) -> some View {
        VStack(spacing: 8) {
            if let error = s.error {
                MessageCard(title: "Attendance update unsuccessful", message: error, kind: .error)
                    .accessibilityIdentifier("staff.clock.error")
            }
            if s.showCheckInNote {
                StaffCheckInNote(checkedInAt: s.checkedInAt)
            }
            if !teams, expanded, s.canTeam, let selected = s.selected {
                HStack(spacing: 10) {
                    PrimaryButton("Teams", variant: .light) { navigator.push(.teams(selected)) }
                        .disabled(busy)
                    actionButton(s)
                }
            } else {
                actionButton(s)
            }
        }
        .padding(.horizontal, ScheduleTokens.actionInset)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(ScheduleTokens.background.opacity(0.96).ignoresSafeArea(edges: .bottom))
    }

    @ViewBuilder
    private func actionButton(_ s: Snapshot) -> some View {
        let working = flow.busy || store.attendanceBusy
        switch s.action {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: ScheduleTokens.actionHeight)
                .accessibilityLabel("Loading")
        case .retry:
            PrimaryButton("Retry") { Task { await refresh() } }
        case .noShift:
            // No applicable shift: clearly disabled; sends nothing, goes nowhere.
            PrimaryButton("No Shift") {}
                .disabled(true)
                .accessibilityIdentifier("staff.clock.noShift")
        case .checkIn:
            PrimaryButton("Check In", isBusy: working) {
                guard let selected = s.selected else { return }
                Task { await flow.checkIn(selected) }
            }
            .disabled(busy)
            .accessibilityIdentifier("staff.clock.checkIn")
        case .clockIn:
            PrimaryButton("Clock in", isBusy: working) {
                guard let selected = s.selected else { return }
                Task { await flow.clockIn(selected) }
            }
            .disabled(busy)
            .accessibilityIdentifier("staff.clock.primary")
        case .clockOut:
            PrimaryButton("Clock out", isBusy: working) {
                Task { await flow.clockOut() }
            }
            .disabled(busy)
            .accessibilityIdentifier("staff.clock.primary")
        case .back(let title):
            PrimaryButton(title) {
                if s.completed && !teams {
                    toggleExpanded(to: true)
                } else {
                    dismiss()
                }
            }
        }
    }

    // MARK: Helpers

    private func timerInput(_ s: Snapshot) -> StaffTimerInput {
        StaffTimerInput(
            startsAt: s.starts,
            endsAt: s.ends,
            attendance: s.record,
            live: s.live != nil,
            completed: s.completed,
            confirmed: s.confirmed,
            status: s.status,
            isToday: s.isToday
        )
    }

    private func toggleExpanded(to value: Bool? = nil) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.38)) {
            expanded = value ?? !expanded
        }
    }

    private func teamKey(_ s: Snapshot) -> String? {
        s.canTeam ? s.selected?.shiftId : nil
    }

    private func checkInKey(_ s: Snapshot) -> String? {
        guard let selected = s.selected, store.checkInRequired(selected) else { return nil }
        guard s.state == .clockIn || s.state == .ready else { return nil }
        // Re-requested after every resume (the state may have changed meanwhile).
        return "\(selected.shiftId)#\(resumeToken)"
    }

    private func nextBoundary(_ s: Snapshot) -> Date? {
        guard let now = store.attendanceNow else { return nil }
        let opensAt: Date? = {
            guard let starts = s.starts, let early = store.clockInEarlyMinutes else { return nil }
            return starts.addingTimeInterval(-TimeInterval(early) * 60)
        }()
        return [opensAt, s.starts, s.ends].compactMap { $0 }.first { $0 > now }
    }

    /// A timer-driven reload at the next server boundary (window opens,
    /// shift starts/ends): background traffic.
    private func refreshAtBoundary(_ boundary: Date?) async {
        guard let boundary, let now = store.attendanceNow else { return }
        let wait = boundary.timeIntervalSince(now) + 0.01
        guard wait > 0 else { return }
        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        guard !Task.isCancelled else { return }
        await refresh(background: true)
    }

    private func refresh(background: Bool = false) async {
        async let offers: Void = store.loadOffers(silent: true, background: background)
        async let active: Void = store.refreshActive(silent: true, background: background)
        async let history: Void = store.loadHistory(silent: true, background: background)
        _ = await (offers, active, history)
    }

    private func loadTeamIfNeeded(_ s: Snapshot) async {
        guard let shiftId = teamKey(s), teamLoader.shiftId != shiftId else { return }
        await loadTeam(shiftId)
    }

    /// The person's own (or resume) reload: never background-flagged. Rows
    /// of the same shift stay on screen while it runs and if it fails.
    private func loadTeam(_ shiftId: String) async {
        try? await teamLoader.load(shiftId: shiftId, using: store)
    }

    /// Only the Teams variant polls its team list.
    @MainActor
    private func startTeamPolling() async {
        guard teams else { return }
        let loader = teamLoader
        let store = self.store
        let api = store.repository.api
        await teamPoll.start(
            foreground: scenePhase != .background,
            identity: { await api.currentGeneration() },
            task: { trigger in
                guard let shiftId = loader.shiftId else { return }
                try await loader.load(shiftId: shiftId, background: trigger.isBackground, using: store)
            }
        )
    }
}

// MARK: - Timers

struct StaffTimerInput: Equatable {
    let startsAt: Date?
    let endsAt: Date?
    let attendance: StaffAttendanceSummary?
    let live: Bool
    let completed: Bool
    let confirmed: Bool
    let status: String
    let isToday: Bool
}

/// HH:MM:SS hero timer. Only this subtree ticks (once a second). The value is
/// `attendanceNow − clockInAt` (or the countdown to the start); with no server
/// time yet it shows "—", never a device-clock guess.
struct StaffHeroTimer: View {
    let snapshot: StaffTimerInput
    @EnvironmentObject private var store: StaffStore

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { _ in
            let model = StaffClockTimerModel.compute(
                now: store.attendanceNow,
                startsAt: snapshot.startsAt,
                attendance: snapshot.attendance,
                live: snapshot.live,
                completed: snapshot.completed,
                confirmed: snapshot.confirmed,
                status: snapshot.status
            )
            VStack(alignment: .leading, spacing: 8) {
                Text(model.label).scheduleType(ScheduleType.timerLabel)
                if let start = snapshot.startsAt, let end = snapshot.endsAt {
                    Text("\(snapshot.isToday ? "Today" : CrewflowDateFormat.weekdayDay(start)) · \(StaffFormat.timeSpan(start, end))")
                        .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                }
                timerText(model.seconds)
                StaffClockStatusBadge(label: model.badge, warning: model.warning)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("staff.clock.timer")
        }
    }

    @ViewBuilder
    private func timerText(_ seconds: Int?) -> some View {
        if let seconds {
            let clock = StaffFormat.clock(seconds)
            let hours = String(clock.prefix(while: { $0 != ":" }))
            let rest = String(clock.dropFirst(hours.count))
            (Text(hours).font(.system(size: 60).monospacedDigit()) + Text(rest).font(.system(size: 32).monospacedDigit()))
                .foregroundColor(ScheduleTokens.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .accessibilityLabel("\(seconds / 3600) hours \((seconds / 60) % 60) minutes \(seconds % 60) seconds")
        } else {
            Text("—")
                .staffFont(60)
                .foregroundColor(ScheduleTokens.ink)
                .accessibilityLabel("Not available")
        }
    }
}

/// Teams HOURS / MINUTES / SECONDS panel ("Your shift starts in" before the
/// start on red, "Shift in progress" / "Time on shift" on mint).
struct StaffTeamCountdown: View {
    let snapshot: StaffTimerInput
    @EnvironmentObject private var store: StaffStore

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { _ in
            let model = StaffClockTimerModel.compute(
                now: store.attendanceNow,
                startsAt: snapshot.startsAt,
                attendance: snapshot.attendance,
                live: snapshot.live,
                completed: snapshot.completed,
                confirmed: snapshot.confirmed,
                status: snapshot.status
            )
            if let phase = model.phase {
                StaffCountdownPanel(phase: phase, seconds: model.seconds)
            } else {
                StaffCountdownPanel(heading: snapshot.status, seconds: nil)
            }
        }
    }
}

// MARK: - Pieces

/// Before Check In: why the step exists. After it: "Checked in · HH:mm" (the
/// server's time); Clock in is then unlocked.
struct StaffCheckInNote: View {
    let checkedInAt: Date?

    var body: some View {
        if let checkedInAt {
            StaffClockStatusBadge(label: "Checked in · \(CrewflowDateFormat.time(checkedInAt))")
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("staff.clock.checkedIn")
        } else {
            Text("Confirm your arrival at the venue before starting your shift.")
                .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("staff.clock.checkInHelper")
        }
    }
}

/// Confirmed team for the shift (first names only, scheduled windows).
struct StaffTeamList: View {
    let members: [StaffTeamMember]

    var body: some View {
        StaffGroup {
            ForEach(Array(members.enumerated()), id: \.offset) { index, member in
                if index > 0 { Divider().overlay(ScheduleTokens.border) }
                HStack(spacing: 14) {
                    InitialsAvatar(
                        name: member.displayName,
                        size: 42,
                        background: member.isYou ? StaffPalette.youAvatar : StaffPalette.teamTones[index % StaffPalette.teamTones.count]
                    )
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text(member.displayName).scheduleType(ScheduleType.bodyStrong).lineLimit(1)
                            if member.isYou {
                                Text("You")
                                    .scheduleType(ScheduleType.badge.colored(StaffPalette.green))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 2)
                                    .background(RoundedRectangle(cornerRadius: 6).fill(StaffPalette.youAvatar))
                            }
                        }
                        Text(StaffFormat.timeSpan(member.startsAt, member.endsAt)).scheduleType(ScheduleType.caption)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(StaffTeamRules.durationLabel(member)).scheduleType(ScheduleType.bodyStrong)
                        Text("shift").scheduleType(ScheduleType.caption)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(member.isYou ? StaffPalette.youSurface : Color.clear)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// The attendance sheets (explain-first location, location unavailable,
/// clock-out confirmation, early).
struct StaffAttendanceSheet: View {
    let sheet: StaffAttendancePrompts.Sheet
    @ObservedObject var prompts: StaffAttendancePrompts
    @EnvironmentObject private var store: StaffStore
    @Environment(\.openURL) private var openURL
    @State private var submitted = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                content
            }
            .padding(ScheduleTokens.sheetInset)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var content: some View {
        switch sheet {
        case .explainLocation:
            Image(systemName: "location")
                .staffFont(20)
                .foregroundStyle(ScheduleTokens.ink)
                .frame(width: 48, height: 48)
                .background(Circle().fill(ScheduleTokens.mint))
                .accessibilityHidden(true)
            Text("Confirm you're on site").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
            Text("We use your location only at the moment you check in, clock in or clock out, to confirm you're at the venue. Your location isn't tracked in the background.")
                .scheduleType(ScheduleType.body)
            PrimaryButton("Continue") { prompts.resolve(true) }
                .accessibilityIdentifier("staff.location.continue")
            PrimaryButton("Not now", variant: .light) { prompts.resolve(false) }
        case .locationUnavailable:
            MessageCard(
                title: "Location unavailable",
                message: "We couldn't confirm your location. Please enable location access for this app in Settings, then try again.",
                kind: .warning,
                actionTitle: "Open Settings"
            ) {
                prompts.resolve(false)
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            PrimaryButton("Cancel", variant: .light) { prompts.resolve(false) }
        case .confirmClockOut:
            Text("End your shift?").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
            Text("Ending your shift records your worked time when clock-out is confirmed.")
                .scheduleType(ScheduleType.body)
            PrimaryButton("Clock out") {
                guard !submitted else { return }
                submitted = true
                prompts.resolve(true)
            }
            .accessibilityIdentifier("staff.clock.confirmClockOut")
            PrimaryButton("Keep working", variant: .light) { prompts.resolve(false) }
        case .early(let availableAt, let checkIn):
            StaffEarlyContent(availableAt: availableAt, checkIn: checkIn) { prompts.resolve(false) }
        }
    }
}

/// "Your shift hasn't started yet" (Flutter `ClockEarlySheet`); minutes from
/// the server-anchored clock, ticking once a second.
struct StaffEarlyContent: View {
    let availableAt: Date
    let checkIn: Bool
    let onBack: () -> Void
    @EnvironmentObject private var store: StaffStore

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { _ in
            let minutes: Int? = store.attendanceNow.map { now in
                max(0, Int((availableAt.timeIntervalSince(now) / 60).rounded(.up)))
            }
            let verb = checkIn ? "check in" : "clock in"
            let hyphen = checkIn ? "check-in" : "clock-in"
            let button = checkIn ? "Check In" : "Clock in"
            VStack(spacing: 24) {
                Text(minutes == 0 ? "You can \(verb) now" : "Your shift hasn’t started yet!")
                    .scheduleType(ScheduleType.cardTitle)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Group {
                    if let minutes {
                        if minutes == 0 {
                            Text("Go back and tap \(button) to start.")
                        } else {
                            Text("You can’t \(verb) just yet. You can \(hyphen)\nin \(minutes) \(minutes == 1 ? "minute" : "minutes")")
                        }
                    } else {
                        Text("Checking when you can \(verb)…")
                    }
                }
                .scheduleType(ScheduleType.bodyStrong)
                .multilineTextAlignment(.center)
                PrimaryButton("Back", action: onBack)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 8)
        }
    }
}

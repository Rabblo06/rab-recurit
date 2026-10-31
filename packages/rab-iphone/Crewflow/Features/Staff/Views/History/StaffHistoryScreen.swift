import SwiftUI

/// History (Flutter `HistoryScreen`): payroll-approved shifts ONLY
/// (`payrollStatus ∈ approved|processing|paid`, a client filter on
/// `/attendance/me/history`). Hours are the server's `workedMinutes`; pay is
/// the server's `payrollApprovedPence`, never an estimate. A load failure
/// shows a Retry card and never an empty "no shifts" state.
struct StaffHistoryScreen: View {
    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator
    @State private var filter: StaffHistoryFilter = .all

    var body: some View {
        let rows = StaffHistoryRules.build(history: store.history, offers: store.offers)
        let visible = rows.filter { $0.matches(filter) }
        let attention = rows.filter(\.needsAttention).count
        let verified = StaffHistoryRules.verifiedMinutesThisMonth(rows, now: store.displayNow)
        let loading = store.historyLoading && store.history.isEmpty
        VStack(spacing: 0) {
            StaffScreenHeader(title: "History", onBack: { navigator.select(.home) })
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let error = store.historyError {
                        MessageCard(title: "History unavailable", message: error, kind: .error, actionTitle: "Retry") {
                            Task { await store.loadHistory() }
                        }
                        .accessibilityIdentifier("staff.history.error")
                    }
                    HStack(spacing: 12) {
                        summaryCard(value: loading ? "—" : StaffFormat.hours(verified), label: "Verified hours this month")
                        summaryCard(
                            value: loading ? "—" : "\(attention)",
                            label: attention == 1 ? "Shift needs attention" : "Shifts need attention",
                            warning: attention > 0
                        )
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(StaffHistoryFilter.allCases, id: \.label) { option in
                                filterChip(option)
                            }
                        }
                    }
                    if loading {
                        ProgressView().frame(maxWidth: .infinity).padding(40)
                    } else if visible.isEmpty, store.historyError == nil {
                        EmptyStateView(systemImage: "clock.arrow.circlepath", title: filter.emptyTitle, message: filter.emptyMessage)
                            .frame(minHeight: 260)
                            .accessibilityIdentifier("staff.history.empty")
                    } else {
                        ForEach(visible) { entry in
                            historyCard(entry)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .refreshable {
                async let history: Void = store.loadHistory(silent: true)
                async let offers: Void = store.loadOffers(silent: true, full: true)
                _ = await (history, offers)
            }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .task { await store.loadHistory(silent: !store.history.isEmpty) }
        .onAppear { ShiftVisualStyle.registerGroup(rows.map(\.shiftId)) }
        .accessibilityIdentifier("staff.history")
    }

    private func summaryCard(value: String, label: String, warning: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .scheduleType(ScheduleType.pageTitle.colored(warning ? ScheduleTokens.errorText : ScheduleTokens.ink))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label).scheduleType(ScheduleType.caption)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 12))
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).stroke(ScheduleTokens.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func filterChip(_ option: StaffHistoryFilter) -> some View {
        let selected = filter == option
        return Button { filter = option } label: {
            Text(option.label)
                .staffFont(14, .semibold)
                .foregroundStyle(selected ? Color.white : ScheduleTokens.ink)
                .padding(.horizontal, 18)
                .frame(minHeight: 44)
                .background(Capsule().fill(selected ? ScheduleTokens.navy : Color.white))
                .overlay(Capsule().stroke(selected ? ScheduleTokens.navy : ScheduleTokens.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func historyCard(_ entry: StaffHistoryEntry) -> some View {
        let attendance = entry.attendance
        let style = ShiftVisualStyle.forShift(entry.shiftId)
        var open: (() -> Void)?
        if let offer = store.offer(forShift: entry.shiftId) {
            open = { navigator.push(.jobDetail(offer)) }
        }
        return PastelShiftCard(
            style: style,
            badge: entry.badge,
            badgeWarning: entry.needsAttention,
            role: attendance.roleName,
            venue: attendance.venueName,
            startsAt: attendance.startsAt,
            endsAt: attendance.endsAt,
            onOpen: open
        ) {
            HStack(alignment: .top) {
                metric("Hours worked", attendance.workedMinutes.map(StaffFormat.hours) ?? "—")
                Spacer()
                // Approved payroll amount only; never an estimate.
                metric("Earned pay", attendance.payrollApprovedPence.map(Money.formatPence) ?? "—", trailing: true)
            }
            if let message = entry.attentionMessage {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(ScheduleTokens.errorText).accessibilityHidden(true)
                    Text(message).scheduleType(ScheduleType.secondary.colored(ScheduleTokens.errorText))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(ScheduleTokens.dangerSoft))
            }
        }
        .accessibilityIdentifier("staff.history.card.\(attendance.id)")
    }

    private func metric(_ label: String, _ value: String, trailing: Bool = false) -> some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 2) {
            Text(label).scheduleType(ScheduleType.caption)
            Text(value).scheduleType(ScheduleType.cardTitle)
        }
        .accessibilityElement(children: .combine)
    }
}

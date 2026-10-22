import SwiftUI

/// Venue Manager Calendar (Flutter `VenueCalendarScreen`): a month grid
/// marking days with events, then the selected day's agenda. Statuses are a
/// display-only read of the shift status; cancelled shifts are hidden.
struct VMCalendarView: View {
    @EnvironmentObject private var store: VenueManagerStore
    @State private var month = VMDate.startOfDay(Date())
    @State private var selectedDay = VMDate.startOfDay(Date())
    @State private var open: VenueEvent?

    private var events: [VenueEvent] {
        store.events.filter { $0.status != "cancelled" }.sorted { $0.start < $1.start }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Calendar").scheduleType(ScheduleType.pageTitle).accessibilityAddTraits(.isHeader).padding(.top, 12)
                if store.loading && store.updatedAt == nil {
                    VMInlineLoading(label: "Loading schedule")
                } else if store.error != nil {
                    VMLoadFailure(message: "Could not load your schedule. Please try again.", title: "Calendar unavailable") {
                        Task { await store.refresh() }
                    }
                } else {
                    monthHeader
                    grid
                    legend
                    agenda
                }
            }
            .padding(.horizontal, ScheduleTokens.homeInset)
            .padding(.bottom, 24)
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await store.refresh() }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .vmDestination($open) { VMEventDetailView(event: $0) }
        .accessibilityIdentifier("vm.calendar")
    }

    private var calendar: Calendar { VMDate.calendar }

    private var monthHeader: some View {
        HStack {
            VMCircleButton(systemImage: "chevron.left", label: "Previous month") { shiftMonth(-1) }
            Text(VMDate.monthTitle(month)).scheduleType(ScheduleType.cardTitle).frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            VMCircleButton(systemImage: "chevron.right", label: "Next month") { shiftMonth(1) }
        }
    }

    private func shiftMonth(_ delta: Int) {
        guard let next = calendar.date(byAdding: .month, value: delta, to: month) else { return }
        month = next
        if let first = calendar.dateInterval(of: .month, for: next)?.start { selectedDay = first }
    }

    /// The month's days, padded to whole Monday-first weeks.
    private var days: [Date?] {
        guard let interval = calendar.dateInterval(of: .month, for: month),
              let count = calendar.range(of: .day, in: .month, for: month)?.count
        else { return [] }
        let weekday = calendar.component(.weekday, from: interval.start) // 1 = Sunday
        let leading = (weekday + 5) % 7
        var cells: [Date?] = Array(repeating: nil, count: leading)
        for offset in 0..<count {
            cells.append(calendar.date(byAdding: .day, value: offset, to: interval.start))
        }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    private func eventsOn(_ day: Date) -> [VenueEvent] {
        events.filter { calendar.isDate($0.start, inSameDayAs: day) }
    }

    private var grid: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)
        return LazyVGrid(columns: columns, spacing: 6) {
            ForEach(["M", "T", "W", "T", "F", "S", "S"].indices, id: \.self) { index in
                Text(["M", "T", "W", "T", "F", "S", "S"][index]).scheduleType(ScheduleType.caption).accessibilityHidden(true)
            }
            ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                if let day {
                    dayCell(day)
                } else {
                    Color.clear.frame(height: 44)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(Color.white))
    }

    private func dayCell(_ day: Date) -> some View {
        let selected = calendar.isDate(day, inSameDayAs: selectedDay)
        let today = calendar.isDateInToday(day)
        let dayEvents = eventsOn(day)
        return Button { selectedDay = day } label: {
            VStack(spacing: 3) {
                Text("\(calendar.component(.day, from: day))")
                    .scheduleType(ScheduleType.body.colored(selected ? .white : ScheduleTokens.ink))
                HStack(spacing: 2) {
                    ForEach(Array(Set(dayEvents.map { VMCalendarStatus(shiftStatus: $0.status) })).sorted { $0.rawValue < $1.rawValue }.prefix(3), id: \.self) { status in
                        Circle().fill(selected ? Color.white : status.dot).frame(width: 5, height: 5)
                    }
                }
                .frame(height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(selected ? ScheduleTokens.accent : .clear))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(today && !selected ? ScheduleTokens.accent : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(CrewflowDateFormat.fullDay(day)), \(dayEvents.count) \(VMText.plural(dayEvents.count, "event", "events"))")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var legend: some View {
        let statuses = events.isEmpty
            ? [VMCalendarStatus.confirmed, .openRequest]
            : Array(Set(events.map { VMCalendarStatus(shiftStatus: $0.status) })).sorted { $0.rawValue < $1.rawValue }
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(statuses, id: \.self) { status in
                    HStack(spacing: 6) {
                        Circle().fill(status.dot).frame(width: 8, height: 8).accessibilityHidden(true)
                        Text(status.label).scheduleType(ScheduleType.caption)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var agenda: some View {
        let dayEvents = eventsOn(selectedDay)
        Text(CrewflowDateFormat.weekdayDay(selectedDay)).scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
        if dayEvents.isEmpty {
            MessageCard(title: events.isEmpty ? "No scheduled events" : "No events on this day.")
        }
        ForEach(Array(dayEvents.enumerated()), id: \.element.id) { _, event in
            let team = store.team(event).map(\.staffName)
            VMEventRecordCard(
                event: event,
                style: store.style(event),
                team: team,
                metric: event.shift.payRatePence.map { (label: "Pay rate", value: Money.payRateLabel($0)) },
                schedule: "\(VMDate.eventTime(event.start, event.end)) · \(VMCalendarStatus(shiftStatus: event.status).label)"
            ) { open = event }
        }
    }
}

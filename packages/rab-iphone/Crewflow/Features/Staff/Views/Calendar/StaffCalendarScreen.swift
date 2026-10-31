import SwiftUI

/// Staff Calendar (Flutter `CalendarScreen` + shared `ScheduleCalendar`,
/// agenda style): a "Today" week agenda and a "Month" grid, both built only
/// from `/offers/mine` (open offers, awaiting confirmation, confirmed). Days
/// are London calendar days; an overnight shift shows on both days. Tapping
/// a shift opens Job Details. Read-only presentation.
struct StaffCalendarScreen: View {
    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var month = false
    @State private var selected: Date?
    @State private var weekStart: Date?
    @State private var viewedMonth: Date?

    private var calendar: Calendar { StaffFormat.london }
    private var today: Date { calendar.startOfDay(for: store.offersNow ?? store.displayNow) }
    private var selectedDay: Date { selected ?? today }
    private var currentWeekStart: Date { weekStart ?? calendar.date(byAdding: .day, value: -3, to: selectedDay) ?? selectedDay }
    private var currentMonth: Date { viewedMonth ?? monthStart(selectedDay) }

    private var entries: [StaffOfferSummary] {
        store.offers.filter(StaffCalendarRules.includes)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                toggle
                if month {
                    monthGrid
                } else {
                    weekStrip
                }
                if store.offersLoading && store.offers.isEmpty {
                    LoadingView("Loading schedule").frame(minHeight: 200)
                } else if store.offersError != nil {
                    MessageCard(
                        title: "Calendar unavailable",
                        message: "Could not load your schedule. Please try again.",
                        kind: .error,
                        actionTitle: "Retry"
                    ) {
                        Task { await store.loadOffers(full: true) }
                    }
                } else if month {
                    dayContent(selectedDay)
                } else {
                    agenda
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .refreshable { await store.loadOffers(silent: true, full: true) }
        .background(StaffPalette.calendarBackground.ignoresSafeArea())
        .accessibilityIdentifier("staff.calendar")
    }

    // MARK: Header and toggle

    private var header: some View {
        HStack {
            Text(StaffFormat.monthYear(month ? currentMonth : selectedDay))
                .staffFont(22, .bold)
                .foregroundStyle(ScheduleTokens.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button { navigator.select(.profile) } label: {
                Image(systemName: "person")
                    .staffFont(19)
                    .foregroundStyle(ScheduleTokens.ink)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.white).scheduleCardShadow())
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel("Profile")
        }
    }

    private var toggle: some View {
        HStack(spacing: 0) {
            toggleSegment(isMonth: false, title: "Today", icon: "person")
            toggleSegment(isMonth: true, title: "Month", icon: "calendar")
        }
        .padding(3)
        .frame(height: 48)
        .background(Capsule().fill(Color.white))
    }

    private func toggleSegment(isMonth: Bool, title: String, icon: String) -> some View {
        let active = month == isMonth
        return Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.24)) {
                month = isMonth
                if !isMonth {
                    selected = today
                    viewedMonth = nil
                    weekStart = nil
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon).staffFont(14).accessibilityHidden(true)
                Text(title).staffFont(13, .semibold)
            }
            .foregroundStyle(active ? Color.white : ScheduleTokens.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Capsule().fill(active ? StaffPalette.selectedDay : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // MARK: Week agenda

    private var weekDays: [Date] {
        (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: currentWeekStart) }
    }

    private var weekStrip: some View {
        HStack(spacing: 2) {
            stepButton(label: "Previous week", icon: "chevron.left") { shiftWeek(-7) }
            ForEach(weekDays, id: \.self) { day in
                let isSelected = calendar.isDate(day, inSameDayAs: selectedDay)
                Button { selected = day } label: {
                    VStack(spacing: 3) {
                        Text(StaffFormat.weekday(day)).staffFont(10)
                            .foregroundStyle(isSelected ? Color.white : ScheduleTokens.muted)
                        Text("\(calendar.component(.day, from: day))").staffFont(14, .bold)
                            .foregroundStyle(isSelected ? Color.white : ScheduleTokens.ink)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(isSelected ? StaffPalette.selectedDay : Color.clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(StaffFormat.spoken(day))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
            stepButton(label: "Next week", icon: "chevron.right") { shiftWeek(7) }
        }
    }

    private func shiftWeek(_ days: Int) {
        guard let next = calendar.date(byAdding: .day, value: days, to: currentWeekStart) else { return }
        weekStart = next
        if !weekDays.contains(where: { calendar.isDate($0, inSameDayAs: selectedDay) }) {
            selected = calendar.date(byAdding: .day, value: 3, to: next)
        }
    }

    private var agenda: some View {
        VStack(alignment: .leading, spacing: 16) {
            if weekDays.allSatisfy({ StaffCalendarRules.offers(entries, onDayStarting: $0, calendar: calendar).isEmpty }) {
                Text("No shifts scheduled")
                    .scheduleType(ScheduleType.caption)
                    .padding(.leading, 44)
            }
            ForEach(weekDays, id: \.self) { day in
                let dayEntries = StaffCalendarRules.offers(entries, onDayStarting: day, calendar: calendar)
                HStack(alignment: .top, spacing: 4) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(StaffFormat.weekday(day)).staffFont(10).foregroundStyle(ScheduleTokens.muted)
                        Text("\(calendar.component(.day, from: day))").staffFont(15, .bold)
                    }
                    .frame(width: 40, alignment: .leading)
                    .accessibilityLabel(StaffFormat.spoken(day))
                    VStack(spacing: 12) {
                        if dayEntries.isEmpty {
                            Color.clear.frame(height: 64)
                        }
                        ForEach(dayEntries) { offer in
                            card(offer)
                        }
                    }
                }
            }
        }
    }

    // MARK: Month grid

    private func monthStart(_ date: Date) -> Date {
        calendar.date(from: calendar.dateComponents([.year, .month], from: date)) ?? date
    }

    private var monthCells: [Date?] {
        let start = currentMonth
        guard let range = calendar.range(of: .day, in: .month, for: start) else { return [] }
        // Monday-first offset (en_GB).
        let weekday = calendar.component(.weekday, from: start) // 1 = Sunday
        let offset = (weekday + 5) % 7
        var cells: [Date?] = Array(repeating: nil, count: offset)
        for day in range {
            cells.append(calendar.date(byAdding: .day, value: day - 1, to: start))
        }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    private var monthGrid: some View {
        VStack(spacing: 6) {
            HStack {
                Text(StaffFormat.monthYear(currentMonth)).staffFont(15, .semibold)
                Spacer()
                stepButton(label: "Previous month", icon: "chevron.left") { moveMonth(-1) }
                stepButton(label: "Next month", icon: "chevron.right") { moveMonth(1) }
            }
            HStack(spacing: 0) {
                ForEach(["M", "T", "W", "T", "F", "S", "S"].indices, id: \.self) { index in
                    Text(["M", "T", "W", "T", "F", "S", "S"][index])
                        .staffFont(11, .medium)
                        .foregroundStyle(ScheduleTokens.muted)
                        .frame(maxWidth: .infinity)
                        .accessibilityHidden(true)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 4) {
                ForEach(Array(monthCells.enumerated()), id: \.offset) { _, cell in
                    if let day = cell {
                        monthCell(day)
                    } else {
                        Color.clear.frame(height: 40)
                    }
                }
            }
            legend
        }
        .padding(EdgeInsets(top: 6, leading: 12, bottom: 10, trailing: 12))
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color.white).scheduleCardShadow())
    }

    private func monthCell(_ day: Date) -> some View {
        let isSelected = calendar.isDate(day, inSameDayAs: selectedDay)
        let isToday = calendar.isDate(day, inSameDayAs: today)
        let statuses = statusesOn(day)
        return Button { selected = day } label: {
            VStack(spacing: 3) {
                Text("\(calendar.component(.day, from: day))")
                    .font(.system(size: 14, weight: isToday ? .bold : .regular))
                    .foregroundStyle(isSelected ? Color.white : ScheduleTokens.ink)
                HStack(spacing: 2) {
                    ForEach(Array(statuses.prefix(3).enumerated()), id: \.offset) { _, status in
                        Circle().fill(status.dot.color).frame(width: 4, height: 4)
                    }
                }
                .frame(height: 4)
            }
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(Circle().fill(isSelected ? StaffPalette.selectedDay : Color.clear).frame(width: 38, height: 38))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            StaffFormat.spoken(day) + (isToday ? ", Today" : "") + (statuses.isEmpty ? "" : ", " + statuses.map(\.label).joined(separator: ", "))
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var legend: some View {
        HStack(spacing: 14) {
            ForEach([StaffCalendarStatus.confirmed, .open], id: \.label) { status in
                HStack(spacing: 5) {
                    Circle().fill(status.dot.color).frame(width: 6, height: 6)
                    Text(status.label).staffFont(10).foregroundStyle(ScheduleTokens.muted)
                }
            }
            Spacer()
        }
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }

    private func moveMonth(_ delta: Int) {
        guard let next = calendar.date(byAdding: .month, value: delta, to: currentMonth) else { return }
        viewedMonth = next
        selected = next
    }

    // MARK: Selected day (month mode)

    private func dayContent(_ day: Date) -> some View {
        let dayEntries = StaffCalendarRules.offers(entries, onDayStarting: day, calendar: calendar)
        let statuses = Set(dayEntries.map { status(for: $0).label })
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(StaffFormat.dayHeading(day)).staffFont(16, .bold).foregroundStyle(ScheduleTokens.ink)
                    Text(StaffCalendarRules.summary(dayEntries)).staffFont(11).foregroundStyle(ScheduleTokens.muted)
                }
                Spacer()
                if statuses.count == 1, let badge = statuses.first {
                    Text("• \(badge)")
                        .staffFont(10, .semibold)
                        .foregroundStyle(StaffPalette.calendarGreen)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(StaffPalette.calendarStatusSurface))
                }
            }
            if dayEntries.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No shifts scheduled").staffFont(15, .semibold)
                    Text("Your confirmed shifts and open offers will appear here.").staffFont(12).foregroundStyle(ScheduleTokens.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
                .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white))
            } else {
                ForEach(dayEntries) { offer in card(offer) }
            }
        }
    }

    // MARK: Card

    private func statusesOn(_ day: Date) -> [StaffCalendarStatus] {
        var seen: [StaffCalendarStatus] = []
        for offer in StaffCalendarRules.offers(entries, onDayStarting: day, calendar: calendar) {
            let value = status(for: offer)
            if !seen.contains(value) { seen.append(value) }
        }
        return seen
    }

    private func status(for offer: StaffOfferSummary) -> StaffCalendarStatus {
        StaffCalendarRules.status(
            offer,
            active: store.active?.shiftId == offer.shiftId,
            ended: store.history.contains { $0.shiftId == offer.shiftId && $0.hasEnded }
        )
    }

    private func card(_ offer: StaffOfferSummary) -> some View {
        let cardStatus = status(for: offer)
        let style = ShiftVisualStyle.forShift(offer.shiftId)
        return Button { navigator.push(.jobDetail(offer)) } label: {
            HStack(spacing: 0) {
                Rectangle().fill(cardStatus.dot.color).frame(width: 5)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top) {
                        Text(offer.roleName).staffFont(18, .bold).foregroundStyle(ScheduleTokens.ink).lineLimit(2)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right")
                            .staffFont(13, .semibold)
                            .foregroundStyle(ScheduleTokens.ink)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Color.white))
                    }
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(offer.venueName).staffFont(13, .semibold).foregroundStyle(ScheduleTokens.ink).lineLimit(2)
                            if let address = offer.venueAddress?.trimmingCharacters(in: .whitespacesAndNewlines), !address.isEmpty {
                                meta("mappin", address)
                            }
                            meta("clock", "\(CrewflowDateFormat.time(offer.startsAt)) – \(CrewflowDateFormat.time(offer.endsAt))\(StaffFormat.nextDaySuffix(offer.startsAt, offer.endsAt))")
                        }
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("Pay rate").staffFont(10).foregroundStyle(ScheduleTokens.muted)
                            Text(Money.payRateLabel(offer.payRatePence)).staffFont(12, .bold).foregroundStyle(ScheduleTokens.ink)
                        }
                    }
                }
                .padding(EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 12))
            }
            .multilineTextAlignment(.leading)
            .background(style.card)
            .clipShape(RoundedRectangle(cornerRadius: 21, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("View \(offer.roleName) details, \(cardStatus.label)")
        .accessibilityIdentifier("staff.calendar.shift.\(offer.id)")
    }

    private func meta(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).staffFont(11).foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
            Text(text).staffFont(11).foregroundStyle(ScheduleTokens.muted).lineLimit(2)
        }
    }

    private func stepButton(label: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .staffFont(15, .semibold)
                .foregroundStyle(ScheduleTokens.muted)
                .frame(width: 32, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

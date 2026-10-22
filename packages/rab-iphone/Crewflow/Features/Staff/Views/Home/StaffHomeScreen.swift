import SwiftUI

/// Staff Home (Flutter `ScheduleHomeScreen`): greeting header, the
/// organisation / My Space selector, the primary today/next/live card, the
/// open-offers and clock tiles, and the upcoming deck. Presentation of the
/// store only: no API call or mutation is owned here.
struct StaffHomeScreen: View {
    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator
    @EnvironmentObject private var session: SessionCoordinator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var mySpace = false
    @State private var dismissedSteps: Set<String> = []
    @State private var explanation: StaffExplanation?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.bottom, 16)
                StaffSpaceSelector(mySpace: $mySpace)
                    .padding(.bottom, ScheduleTokens.homeSectionGap)
                Group {
                    if let error = store.offersError, store.offers.isEmpty {
                        MessageCard(title: "Offers unavailable", message: error, kind: .error, actionTitle: "Retry") {
                            Task { await store.loadOffers() }
                        }
                    } else if mySpace {
                        personal
                    } else {
                        organisation
                    }
                }
                .transition(.opacity)
                .animation(reduceMotion ? nil : .easeOut(duration: ScheduleTokens.styleMotion), value: mySpace)
            }
            .padding(.horizontal, ScheduleTokens.homeInset)
            .padding(.top, 16)
            .padding(.bottom, 24)
        }
        .refreshable { await store.refreshAll() }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .sheet(item: $explanation) { item in
            StaffExplanationSheet(item: item)
        }
        // A container keeps its children's own identifiers (tabs, rows).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("staff.home")
    }

    private var loading: Bool { store.offersLoading || store.activeLoading }

    // MARK: Header

    private var header: some View {
        let first = session.user?.firstName.trimmingCharacters(in: .whitespaces) ?? ""
        let initials = StaffFormat.initials(first: session.user?.firstName ?? "", last: session.user?.lastName ?? "")
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Good \(StaffFormat.greeting(at: store.displayNow)),")
                    .staffFont(24)
                    .foregroundStyle(ScheduleTokens.muted)
                Text(first.isEmpty ? "Welcome" : first)
                    .staffFont(36, .bold)
                    .foregroundStyle(ScheduleTokens.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Button { navigator.push(.inbox) } label: {
                Image(systemName: "bell")
                    .staffFont(20)
                    .foregroundStyle(ScheduleTokens.ink)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.white).scheduleCardShadow())
                    .overlay(alignment: .topTrailing) {
                        if store.unreadCount > 0 {
                            Text("\(store.unreadCount)")
                                .staffFont(11, .bold)
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(ScheduleTokens.errorText))
                                .offset(x: 4, y: -4)
                        }
                    }
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel(store.unreadCount > 0 ? "Notifications, \(store.unreadCount) unread" : "Notifications")
            .accessibilityIdentifier("staff.home.notifications")
            Button { navigator.select(.profile) } label: {
                Text(initials.isEmpty ? "—" : initials)
                    .staffFont(15, .semibold)
                    .foregroundStyle(ScheduleTokens.ink)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(ScheduleTokens.mint))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel("Profile")
        }
        .frame(minHeight: 72)
    }

    // MARK: Organisation view

    private var organisation: some View {
        let now = store.displayNow
        let data = StaffHomeDashboard(offers: store.offers, now: now)
        let live = store.liveAttendance
        // A live clock-in always wins, so the card never contradicts its label.
        let today: StaffOfferSummary?
        if let live {
            today = store.offer(forShift: live.shiftId)
        } else {
            today = data.primary
        }
        let isCompletedToday = StaffHomeClockTile.isCompletedToday(loading: loading, live: live != nil, today: today, history: store.history, now: now)
        let tile = StaffHomeClockTile.resolve(
            loading: loading,
            live: live != nil,
            today: today,
            dashboardHasToday: data.today != nil,
            isCompletedToday: isCompletedToday,
            needsCheckIn: today.map { store.needsCheckIn($0) } ?? false
        )
        return VStack(alignment: .leading, spacing: 0) {
            Text("Offer Details").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
            Text(loading ? "Updating your offers…" : "Your latest offers")
                .scheduleType(ScheduleType.caption)
                .padding(.top, 2)
                .padding(.bottom, 14)
            HStack(alignment: .top, spacing: 12) {
                primaryCard(today: today, live: live, dashboardHasToday: data.today != nil)
                    .frame(maxWidth: .infinity)
                    .layoutPriority(6)
                VStack(spacing: 10) {
                    offersTile(data)
                    clockTile(tile)
                }
                .frame(maxWidth: .infinity)
                .layoutPriority(5)
            }
            .fixedSize(horizontal: false, vertical: true)
            StaffUpcomingDeck(offers: data.upcoming, loading: loading)
                .padding(.top, 14)
        }
    }

    private func primaryCard(today: StaffOfferSummary?, live: StaffAttendanceSummary?, dashboardHasToday: Bool) -> some View {
        let role = live?.roleName ?? today?.roleName
        let venue = live?.venueName ?? today?.venueName
        let start = live?.startsAt ?? today?.startsAt
        let end = live?.endsAt ?? today?.endsAt
        // Supplementary fields only when they belong to the displayed shift.
        let details = (live == nil || live?.shiftId == today?.shiftId) ? today : nil
        let heading = today?.presentation?.homeLabel
            ?? (live != nil ? "Live Shift" : (!dashboardHasToday && today != nil ? "Next Shift" : "Today's Shift"))
        let tappable = !loading && (live != nil || today != nil)
        return Button {
            if live != nil {
                navigator.push(.clock(nil))
            } else if let today {
                navigator.push(.jobDetail(today))
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(heading).scheduleType(ScheduleType.caption)
                Divider().overlay(ScheduleTokens.border)
                if loading {
                    Text("Loading…").scheduleType(ScheduleType.caption).frame(maxWidth: .infinity, minHeight: 120)
                } else if let venue {
                    Text(role ?? "")
                        .scheduleType(ScheduleType.bodyStrong)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Text(venue).scheduleType(ScheduleType.bodyStrong).lineLimit(2)
                    if let start {
                        Text(StaffFormat.weekdayShort(start)).scheduleType(ScheduleType.caption)
                    }
                    if let details {
                        (Text("Pay rate : ").foregroundColor(ScheduleTokens.muted) + Text(Money.payRateLabel(details.payRatePence)))
                            .staffFont(12)
                    }
                    if let start, let end {
                        Text(StaffFormat.timeSpan(start, end)).scheduleType(ScheduleType.caption)
                    }
                } else {
                    Text("No Shift")
                        .scheduleType(ScheduleType.body)
                        .frame(maxWidth: .infinity, minHeight: 120)
                }
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(ScheduleTokens.homePeach))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(!tappable)
        .accessibilityElement(children: .combine)
        .accessibilityHint(tappable ? "Opens the shift" : "")
        .accessibilityIdentifier("staff.home.primary")
    }

    private func offersTile(_ data: StaffHomeDashboard) -> some View {
        Button { navigator.push(.offers) } label: {
            VStack(alignment: .leading, spacing: 12) {
                Text("Open Shift Offers").scheduleType(ScheduleType.caption)
                Text(loading ? "Loading…" : "\(data.pending) \(data.pending == 1 ? "offer" : "offers") – View")
                    .staffFont(18, .bold)
                    .foregroundStyle(ScheduleTokens.ink)
                Spacer(minLength: 0)
                Text(loading ? "Checking shifts…" : "\(data.confirmed) confirmed").scheduleType(ScheduleType.caption)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(ScheduleTokens.homeMint))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(loading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("staff.home.offers")
    }

    private func clockTile(_ tile: StaffHomeClockTile) -> some View {
        Button { navigator.push(.clock(nil)) } label: {
            Text(tile.label)
                .staffFont(17)
                .foregroundStyle(tile.enabled ? ScheduleTokens.ink : ScheduleTokens.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: ScheduleTokens.actionHeight)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ScheduleTokens.lavender))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(!tile.enabled)
        .accessibilityLabel(tile.label)
        .accessibilityHint(tile.enabled ? "Opens the clock screen" : "Not available")
        .accessibilityIdentifier("staff.home.clockTile")
    }

    // MARK: My Space

    private var personal: some View {
        let data = StaffHomeDashboard(offers: store.offers, now: store.displayNow)
        return VStack(alignment: .leading, spacing: 14) {
            if dismissedSteps.count < 2 {
                Text("First steps").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
                if !dismissedSteps.contains("discover") {
                    step(id: "discover", title: "Discover the app", icon: "play.circle", explanation: StaffExplanation(
                        title: "Discover the app",
                        message: "Review invitations in Offers, see confirmed shifts in Calendar, and check completed work in History. Use the Home clock action for your scheduled shift."
                    ))
                }
                if !dismissedSteps.contains("availability") {
                    step(id: "availability", title: "My availability", icon: "checkmark.circle", explanation: StaffExplanation(
                        title: "My availability",
                        message: "Availability editing is not available in the staff app yet. Contact your organization to update your availability."
                    ))
                }
            }
            Text("Overview").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader).padding(.top, 6)
            StaffGroup {
                overviewRow("Offers", icon: "calendar.badge.plus", value: loading ? "—" : "\(data.pending)") { navigator.push(.offers) }
                Divider().overlay(ScheduleTokens.border)
                overviewRow("Confirmed", icon: "calendar", value: loading ? "—" : "\(data.confirmed)") { navigator.push(.confirmed) }
                Divider().overlay(ScheduleTokens.border)
                overviewRow("Upcoming shift", icon: "clock", value: loading ? "—" : "\(data.upcoming.count)") { navigator.select(.calendar) }
                Divider().overlay(ScheduleTokens.border)
                // Flutter shows no figure for Payslip; the row opens the documents.
                overviewRow("Payslip", icon: "doc.text", value: "—") { navigator.push(.payslips) }
            }
        }
    }

    private func step(id: String, title: String, icon: String, explanation: StaffExplanation) -> some View {
        HStack(spacing: 12) {
            Button { self.explanation = explanation } label: {
                HStack(spacing: 14) {
                    Image(systemName: icon).foregroundStyle(ScheduleTokens.ink).accessibilityHidden(true)
                    Text(title).scheduleType(ScheduleType.body)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 64)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button { dismissedSteps.insert(id) } label: {
                Image(systemName: "xmark")
                    .staffFont(14, .semibold)
                    .foregroundStyle(ScheduleTokens.muted)
                    .staffTouchTarget()
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss \(title)")
        }
        .padding(.horizontal, 16)
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(Color.white).scheduleCardShadow())
    }

    private func overviewRow(_ title: String, icon: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).foregroundStyle(ScheduleTokens.ink).frame(width: 22).accessibilityHidden(true)
                Text(title).scheduleType(ScheduleType.body)
                Spacer()
                Text(value).scheduleType(ScheduleType.caption.colored(ScheduleTokens.ink))
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

/// organization / My Space segmented control (Flutter `ScheduleSpaceSelector`).
struct StaffSpaceSelector: View {
    @Binding var mySpace: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var indicator

    var body: some View {
        HStack(spacing: 0) {
            segment(space: false, title: "organization", icon: "person.2")
            segment(space: true, title: "My Space", icon: "touchid")
        }
        .padding(3)
        .frame(minHeight: 50)
        .background(Capsule().fill(ScheduleTokens.surface))
        .overlay(Capsule().stroke(ScheduleTokens.border, lineWidth: 1))
    }

    private func segment(space: Bool, title: String, icon: String) -> some View {
        let selected = mySpace == space
        return Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: ScheduleTokens.segmentMotion)) { mySpace = space }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).staffFont(16).accessibilityHidden(true)
                Text(title).staffFont(14)
            }
            .foregroundStyle(selected ? ScheduleTokens.surface : ScheduleTokens.ink)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background {
                if selected {
                    Capsule().fill(ScheduleTokens.accent).matchedGeometryEffect(id: "space", in: indicator)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct StaffExplanation: Identifiable, Equatable {
    let title: String
    let message: String
    var id: String { title }
}

struct StaffExplanationSheet: View {
    let item: StaffExplanation
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(item.title).scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
            Text(item.message).scheduleType(ScheduleType.body)
            PrimaryButton("Got it", variant: .light) { dismiss() }
                .padding(.top, 4)
        }
        .padding(ScheduleTokens.sheetInset)
        .presentationDetents([.medium])
    }
}

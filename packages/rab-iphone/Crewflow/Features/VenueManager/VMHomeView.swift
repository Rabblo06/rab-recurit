import SwiftUI

/// Venue Manager Home (Flutter `VenueManagerHome`): "Organisation" shows the
/// next event, open positions, the Report shortcut and upcoming events;
/// "My Space" shows first steps, My venues and the Overview counts. Every
/// figure is a server count or a presentation filter over server-scoped
/// shifts; nothing is seeded.
struct VMHomeView: View {
    private enum Destination {
        case event(VenueEvent)
        case upcoming, confirmed, myVenues, sentShifts, users, reports, history
    }

    @EnvironmentObject private var store: VenueManagerStore
    @EnvironmentObject private var session: SessionCoordinator
    @State private var mySpace = false
    @State private var destination: Destination?
    @State private var showsDiscover = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                VMSpaceSelector(mySpace: $mySpace)
                if store.loading && store.updatedAt == nil {
                    VMInlineLoading(label: "Loading your venues")
                } else if let error = store.error {
                    VMLoadFailure(message: error) { Task { await store.refresh() } }
                } else if mySpace {
                    personal
                } else {
                    organisation
                }
            }
            .padding(.horizontal, ScheduleTokens.homeInset)
            .padding(.top, 16)
            .padding(.bottom, 24)
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await store.refresh() }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        // A container keeps its children's own identifiers (tabs, rows).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("vm.home")
        .sheet(isPresented: $showsDiscover) {
            VMSheet {
                Text("Discover the app").scheduleType(ScheduleType.heading).padding(.bottom, 12)
                Text("Manage staffing for your assigned venues. Review events, staff and staffing requests from My Space. Staff acceptance waits for Manager confirmation.")
                    .scheduleType(ScheduleType.body)
                PrimaryButton("Close") { showsDiscover = false }.padding(.top, 20)
            }
            .presentationDetents([.medium])
        }
        .vmDestination($destination) { destination in
            switch destination {
            case .event(let event): VMEventDetailView(event: event)
            case .upcoming: VMEventsListScreen(kind: .upcoming)
            case .confirmed: VMEventsListScreen(kind: .confirmed)
            case .myVenues: VMMyVenuesScreen()
            case .sentShifts: VMSentShiftsScreen()
            case .users: VMUsersScreen(mode: .browse)
            case .reports: VMReportBucketScreen(bucket: .current, isRoot: false)
            case .history: VMReportBucketScreen(bucket: .history, isRoot: false)
            }
        }
    }

    private var header: some View {
        let name = session.user?.fullName ?? ""
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Good \(VMDate.greeting(for: Date())),").scheduleType(ScheduleType.secondary)
                Text(session.user?.firstName ?? "").scheduleType(ScheduleType.pageTitle).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            InitialsAvatar(name: name, size: 48)
        }
    }

    // MARK: Organisation

    @ViewBuilder
    private var organisation: some View {
        let upcoming = store.upcoming()
        let next = upcoming.first
        let needed = upcoming.reduce(0) { $0 + $1.vacancies }
        VStack(alignment: .leading, spacing: 4) {
            Text("Event Details").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
            if let updated = store.updatedAt {
                Text("Updated at \(VMDate.clock(updated))").scheduleType(ScheduleType.caption)
            }
        }
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                nextEventPanel(next).frame(maxWidth: .infinity)
                rightColumn(needed: needed).frame(maxWidth: .infinity)
            }
            VStack(spacing: 12) {
                nextEventPanel(next)
                rightColumn(needed: needed)
            }
        }
        if upcoming.isEmpty {
            Text("Upcoming Event").scheduleType(ScheduleType.heading).padding(.top, 8).accessibilityAddTraits(.isHeader)
            MessageCard(title: "No upcoming events in your assigned venues.")
        } else {
            HStack {
                Text("Upcoming Event").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
                Spacer()
                if upcoming.count > 3 {
                    Button("See all") { destination = .upcoming }
                        .scheduleType(ScheduleType.bodyStrong)
                        .frame(minHeight: 44)
                }
            }
            .padding(.top, 8)
            ForEach(upcoming.prefix(3)) { event in
                VMEventRecordCard(event: event, style: store.style(event), team: store.team(event).map(\.staffName)) {
                    destination = .event(event)
                }
            }
        }
    }

    private func nextEventPanel(_ next: VenueEvent?) -> some View {
        let today = next.map { VMDate.sameDay($0.start, Date()) } ?? false
        return Button {
            if let next { destination = .event(next) }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Text(today ? "Today's Event" : "Next Event").scheduleType(ScheduleType.caption)
                Divider()
                Text(next?.role ?? "No upcoming events").scheduleType(ScheduleType.cardTitle)
                if let next {
                    Text(next.venue).scheduleType(ScheduleType.bodyStrong)
                    if !next.address.isEmpty { Text(next.address).scheduleType(ScheduleType.caption) }
                    Text("Staff joined: \(next.filled) / \(next.required)").scheduleType(ScheduleType.caption).padding(.top, 8)
                    Text(VMDate.eventTime(next.start, next.end)).scheduleType(ScheduleType.body).padding(.top, 8)
                    if !today { Text(CrewflowDateFormat.day(next.start)).scheduleType(ScheduleType.caption) }
                }
            }
            .multilineTextAlignment(.leading)
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(VMColor.nextEvent))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(next == nil)
        .accessibilityHint(next == nil ? "" : "Opens the event")
    }

    private func rightColumn(needed: Int) -> some View {
        VStack(spacing: 12) {
            Button { destination = .upcoming } label: {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Open positions").scheduleType(ScheduleType.caption)
                    Text("\(needed) staff needed").scheduleType(ScheduleType.heading)
                    Text("\(store.venues.count) assigned \(VMText.plural(store.venues.count, "venue", "venues"))")
                        .scheduleType(ScheduleType.caption)
                }
                .multilineTextAlignment(.leading)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(ScheduleTokens.homeMint))
            }
            .buttonStyle(PressableButtonStyle())
            if store.allows(.reportView) {
                Button { destination = .reports } label: {
                    Text("Report").scheduleType(ScheduleType.body)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(ScheduleTokens.lavender))
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityIdentifier("vm.home.report")
            }
        }
    }

    // MARK: My Space

    @ViewBuilder
    private var personal: some View {
        Text("First steps").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
        VMListRow(title: "Discover the app", systemImage: "play.circle", count: nil) { showsDiscover = true }
        VMListRow(title: "My venues", systemImage: "storefront", count: store.venues.count) { destination = .myVenues }
        Text("Overview").scheduleType(ScheduleType.heading).padding(.top, 8).accessibilityAddTraits(.isHeader)
        VStack(spacing: 0) {
            // Distinct submitted staffing requests (server counts.submitted).
            VMOverviewRow(title: "Staffing requests", systemImage: "calendar", count: store.sentSubmitted) { destination = .sentShifts }
            if store.allows(.staffView) {
                VMOverviewRow(title: "Users", systemImage: "person.2", count: store.userCount) { destination = .users }
                    .accessibilityIdentifier("vm.home.users")
            }
            VMOverviewRow(title: "Confirmed events", systemImage: "calendar.badge.checkmark", count: store.confirmedEvents().count) { destination = .confirmed }
            VMOverviewRow(title: "Upcoming Events", systemImage: "clock", count: store.upcoming().count) { destination = .upcoming }
            if store.allows(.reportView) {
                VMOverviewRow(title: "Reports", systemImage: "doc.text", count: store.currentReportCount) { destination = .reports }
                VMOverviewRow(title: "History", systemImage: "clock.arrow.circlepath", count: store.historyReportCount) { destination = .history }
            }
        }
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.panelRadius, style: .continuous).fill(Color.white))
        if store.directoryError != nil {
            Text("Users count unavailable. Open Users to retry.").scheduleType(ScheduleType.caption)
        }
    }
}

/// Organisation / My Space switch.
struct VMSpaceSelector: View {
    @Binding var mySpace: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            segment(false, "Organisation", "person.2")
            segment(true, "My Space", "touchid")
        }
        .padding(4)
        .background(Capsule().fill(Color.white))
    }

    private func segment(_ value: Bool, _ title: String, _ icon: String) -> some View {
        let selected = mySpace == value
        return Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: ScheduleTokens.segmentMotion)) { mySpace = value }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).accessibilityHidden(true)
                Text(title).scheduleType(ScheduleType.body.colored(selected ? .white : ScheduleTokens.ink)).lineLimit(1)
            }
            .foregroundStyle(selected ? Color.white : ScheduleTokens.ink)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Capsule().fill(selected ? ScheduleTokens.accent : .clear))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct VMListRow: View {
    let title: String
    let systemImage: String
    let count: Int?
    let action: (() -> Void)?

    var body: some View {
        Button { action?() } label: {
            HStack(spacing: 14) {
                Image(systemName: systemImage).frame(width: 24).accessibilityHidden(true)
                Text(title).scheduleType(ScheduleType.body).frame(maxWidth: .infinity, alignment: .leading)
                if let count {
                    Text("\(count)").scheduleType(ScheduleType.bodyStrong)
                } else if action != nil {
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).accessibilityHidden(true)
                }
            }
            .foregroundStyle(ScheduleTokens.ink)
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).fill(Color.white))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(action == nil)
    }
}

/// Overview row: the count is the server's; "—" when not loaded (never 0).
struct VMOverviewRow: View {
    let title: String
    let systemImage: String
    let count: Int?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: systemImage).frame(width: 24).accessibilityHidden(true)
                Text(title).scheduleType(ScheduleType.body).frame(maxWidth: .infinity, alignment: .leading)
                Text(count.map(String.init) ?? "—").scheduleType(ScheduleType.bodyStrong)
                    .accessibilityLabel(count.map(String.init) ?? "Unavailable")
            }
            .foregroundStyle(ScheduleTokens.ink)
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Event card (Flutter `VenueEventCard` / `ScheduleRecordCard`).
struct VMEventRecordCard: View {
    let event: VenueEvent
    let style: ShiftVisualStyle
    let team: [String]
    var metric: (label: String, value: String)?
    var schedule: String?
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.role).scheduleType(ScheduleType.cardTitle)
                        Text(event.venue).scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                        if !event.address.isEmpty { Text(event.address).scheduleType(ScheduleType.caption) }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 38, height: 38)
                        .background(Circle().fill(Color.white))
                        .accessibilityHidden(true)
                }
                if let schedule { Text(schedule).scheduleType(ScheduleType.caption) }
                Divider().overlay(style.cardBorder)
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(metric?.label ?? "Staff joined").scheduleType(ScheduleType.caption)
                        Text(metric?.value ?? "\(event.filled)/\(event.required)").scheduleType(ScheduleType.bodyStrong)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(team.isEmpty ? "No team assigned" : VMText.plural(team.count, "Team Member", "Staff Members"))
                            .scheduleType(ScheduleType.caption)
                        if !team.isEmpty {
                            Text(team.prefix(3).joined(separator: ", ") + (team.count > 3 ? " +\(team.count - 3)" : ""))
                                .scheduleType(ScheduleType.caption.colored(ScheduleTokens.ink))
                                .multilineTextAlignment(.trailing)
                        }
                    }
                }
            }
            .foregroundStyle(ScheduleTokens.ink)
            .multilineTextAlignment(.leading)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).fill(style.card))
            .overlay(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).stroke(style.cardBorder, lineWidth: 1))
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the event")
    }
}

/// "Upcoming Events" and "Confirmed events" lists.
struct VMEventsListScreen: View {
    enum Kind { case upcoming, confirmed }
    let kind: Kind

    @EnvironmentObject private var store: VenueManagerStore
    @State private var open: VenueEvent?

    var body: some View {
        VMPage(title: kind == .upcoming ? "Upcoming Events" : "Confirmed events") {
            if store.loading && store.updatedAt == nil {
                VMInlineLoading()
            } else if let error = store.error {
                VMLoadFailure(message: error) { Task { await store.refresh() } }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        switch kind {
                        case .upcoming: upcomingRows
                        case .confirmed: confirmedRows
                        }
                    }
                    .padding(ScheduleTokens.homeInset)
                    .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await store.refresh() }
            }
        }
        .vmDestination($open) { VMEventDetailView(event: $0) }
    }

    @ViewBuilder
    private var upcomingRows: some View {
        let events = store.upcoming()
        if events.isEmpty { MessageCard(title: "No events for this period.") }
        ForEach(events) { event in
            VStack(alignment: .leading, spacing: 8) {
                Text("\(CrewflowDateFormat.weekdayDay(event.start)) · \(VMDate.eventTime(event.start, event.end))")
                    .scheduleType(ScheduleType.caption)
                VMEventRecordCard(event: event, style: store.style(event), team: store.team(event).map(\.staffName)) { open = event }
            }
        }
    }

    @ViewBuilder
    private var confirmedRows: some View {
        let events = store.confirmedEvents()
        if events.isEmpty {
            MessageCard(title: "No confirmed events", message: "Upcoming shifts with confirmed staff appear here. Finished events move to Reports.")
        }
        ForEach(events) { event in
            PastelShiftCard(style: store.style(event), badge: confirmedEventBadge(event.status), role: event.role,
                            venue: event.venue, startsAt: event.start, endsAt: event.end, onOpen: { open = event }) {
                ShiftCardFooterLine("\(event.filled) / \(event.required) staff confirmed" + (event.vacancies > 0 ? " · \(event.vacancies) open" : ""))
            }
        }
    }
}

struct VMMyVenuesScreen: View {
    @EnvironmentObject private var store: VenueManagerStore

    var body: some View {
        VMPage(title: "My venues") {
            ScrollView {
                VStack(spacing: 10) {
                    if store.venues.isEmpty { MessageCard(title: "No venues assigned.") }
                    ForEach(store.venues) { venue in
                        VMListRow(title: venue.name, systemImage: "storefront", count: nil, action: nil)
                    }
                }
                .padding(ScheduleTokens.homeInset)
            }
        }
    }
}

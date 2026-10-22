import SwiftUI

/// Sent Shifts (Flutter `VenueSentShiftsScreen`): the Venue Manager's own
/// staffing requests. Views (All / Pending / Accepted / Confirmed /
/// Declined / Expired) are filtered and counted by the SERVER
/// (`/shifts/sent?view=`); pill text/colours come only from
/// `sentShiftLook`. Polls every 5 s while visible (background-flagged).
struct VMSentShiftsScreen: View {
    @EnvironmentObject private var store: VenueManagerStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var query = ""
    @State private var view = "all"
    @State private var viewRows: [SentShift]?
    @State private var viewError = false
    @State private var viewLoadedFor: Date?
    @State private var open: String?
    @State private var showsSend: Bool?
    @State private var visible = false

    var body: some View {
        VMPage(title: "Sent Shifts", trailing: {
            VMCircleButton(systemImage: "plus", label: "Send Shift", background: ScheduleTokens.accent, foreground: .white) {
                showsSend = true
            }
            .accessibilityIdentifier("vm.sent.new")
        }) {
            if store.loading && store.updatedAt == nil {
                VMInlineLoading(label: "Loading sent shifts")
            } else if let error = store.error {
                VMLoadFailure(message: error) { Task { await store.refresh() } }
            } else {
                list
            }
        }
        .task(id: visible) { await poll() }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .onChange(of: store.updatedAt) { _ in
            // A tab other than All re-queries whenever the store refreshes.
            if view != "all" { Task { await loadView() } }
        }
        .vmDestination($open) { VMSentShiftDetailView(shiftId: $0) }
        .vmDestination($showsSend, onReturn: { Task { await store.refresh() } }) { _ in
            VMSendShiftView(initialStaff: [])
        }
        .accessibilityIdentifier("vm.sentShifts")
    }

    private var source: [SentShift] { view == "all" ? store.sentShifts : (viewRows ?? []) }

    private var list: some View {
        let summary = VMSentViews.summary(sentShifts: store.sentShifts, counts: store.sentCounts)
        let rows = source.filter { VMSentViews.matches($0, query: query) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Track submitted staffing requests").scheduleType(ScheduleType.caption)
                HStack(spacing: 8) {
                    summaryCard("Sent", summary.sent, RGBA(argb: 0xFFFFF2E8).color, "paperplane.fill")
                    summaryCard("Accepted", summary.accepted, RGBA(argb: 0xFFECFDF5).color, "checkmark.circle.fill")
                    summaryCard("Confirmed", summary.confirmed, RGBA(argb: 0xFFEEF2FF).color, "checkmark.seal.fill")
                }
                HStack(spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
                        TextField("Search shifts…", text: $query).autocorrectionDisabled()
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(Color.white))
                    Menu {
                        ForEach(VMSentViews.all, id: \.self) { tab in
                            Button(tab.key == "all" ? "All shifts" : tab.label) { select(tab.key) }
                        }
                    } label: {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(ScheduleTokens.ink)
                            .frame(width: 44, height: 44)
                            .background(Circle().fill(Color.white))
                    }
                    .accessibilityLabel("Filter shifts")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(VMSentViews.all, id: \.self) { tab in
                            VMChip(label: VMSentViews.chipLabel(tab.key, label: tab.label, counts: store.sentCounts), selected: view == tab.key) {
                                select(tab.key)
                            }
                            .accessibilityIdentifier("vm.sent.view.\(tab.key)")
                        }
                    }
                }
                if view != "all" && viewRows == nil && !viewError {
                    VMInlineLoading()
                } else if viewError && view != "all" {
                    MessageCard(title: "Could not load this view. Pull to refresh.", kind: .error)
                } else if rows.isEmpty {
                    emptyState
                }
                ForEach(rows) { shift in
                    VMSentShiftCard(shift: shift) { open = shift.id }
                }
            }
            .padding(EdgeInsets(top: 0, leading: 18, bottom: 24, trailing: 18))
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await store.refresh() }
    }

    @ViewBuilder
    private var emptyState: some View {
        let none = (store.sentSubmitted ?? 0) == 0
        VStack(spacing: 8) {
            Text(none ? "No sent shifts yet" : (view == "expired" ? "No expired shifts." : "No sent shifts match this view."))
                .scheduleType(ScheduleType.body)
            if none {
                Text("Submit your first staffing request to get started.").scheduleType(ScheduleType.caption)
                PrimaryButton("Send Shift", systemImage: "plus") { showsSend = true }.frame(maxWidth: 280).padding(.top, 4)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    private func summaryCard(_ label: String, _ count: Int, _ color: Color, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 12)).accessibilityHidden(true)
                Text(label).scheduleType(ScheduleType.caption).lineLimit(1)
            }
            .foregroundStyle(ScheduleTokens.ink.opacity(0.65))
            Text("\(count)").scheduleType(ScheduleType.heading.colored(VMColor.navy))
        }
        .padding(.horizontal, 10).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.badgeRadius, style: .continuous).fill(color))
        .accessibilityElement(children: .combine)
    }

    private func select(_ next: String) {
        view = next
        viewRows = nil
        viewError = false
        if next != "all" { Task { await loadView() } }
    }

    @MainActor
    private func loadView() async {
        let requested = view
        guard requested != "all" else { return }
        viewLoadedFor = store.updatedAt
        do {
            let rows = try await store.repository.sentShifts(view: requested)
            guard view == requested else { return }
            viewRows = rows
            viewError = false
        } catch {
            guard view == requested else { return }
            let api = error as? APIError
            if api != .cancelled, api != .sessionChanged, viewRows == nil { viewError = true }
        }
    }

    @MainActor
    private func poll() async {
        guard visible else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled, visible, scenePhase == .active, !store.loading else { continue }
            await store.refresh(silent: true, background: true)
        }
    }
}

/// Sent Shifts card (Flutter `SentShiftCard`).
struct VMSentShiftCard: View {
    let shift: SentShift
    let onOpen: () -> Void

    var body: some View {
        let look = sentShiftLook(shift)
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    VMPill(tone: look)
                    Spacer(minLength: 12)
                    if let submitted = shift.submittedAt {
                        Text(VMDate.sentAgo(submitted, now: Date())).scheduleType(ScheduleType.caption).lineLimit(1)
                    }
                }
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(shift.venueName).scheduleType(ScheduleType.cardTitle.colored(VMColor.navy))
                        Text(VMText.displayRoleName(shift.roleName)).scheduleType(ScheduleType.secondary)
                    }
                    Spacer(minLength: 12)
                    Image(systemName: "arrow.up.right").font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(VMColor.navy)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Color.white))
                        .accessibilityHidden(true)
                }
                HStack(spacing: 16) {
                    ShiftMetaItem(systemImage: "calendar", label: VMDate.weekdayDayYear(shift.startsAt))
                    ShiftMetaItem(systemImage: "clock", label: VMDate.sentTimeRange(shift.startsAt, shift.endsAt))
                }
                Divider()
                ShiftCardFooterLine(VMSentViews.sentLine(shift))
            }
            .multilineTextAlignment(.leading)
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(look.card.color))
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the sent shift")
        .accessibilityIdentifier("vm.sent.card.\(shift.id)")
    }
}

/// One sent staffing request (Flutter `VenueSentShiftDetail`): summary
/// card, who it went to, its confirmed staff and the other responses.
struct VMSentShiftDetailView: View {
    let shiftId: String

    @EnvironmentObject private var store: VenueManagerStore
    @State private var shift: SentShift?
    @State private var error: Error?
    @State private var roster: ShiftRoster?
    @State private var rosterError: String?
    @State private var loading = true
    @State private var generation = 0
    @State private var review: (ShiftReportDetail, ShiftReportStaffRow)?

    var body: some View {
        VMPage(title: "Sent shift") {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) { content }
                    .padding(EdgeInsets(top: 8, leading: 16, bottom: 24, trailing: 16))
                    .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                    .frame(maxWidth: .infinity)
            }
            .refreshable { await load() }
        }
        .task { await load() }
        .vmDestination($review, onReturn: { Task { await load() } }) { item in
            VMReviewStaffReportView(report: item.0, row: item.1)
        }
        .accessibilityIdentifier("vm.sentShiftDetail")
    }

    @ViewBuilder
    private var content: some View {
        if shift == nil && loading {
            VMInlineLoading()
        } else if let shift {
            loaded(shift)
        } else if (error as? APIError)?.statusCode == 404 {
            MessageCard(title: "This shift is no longer available.", kind: .error)
        } else {
            MessageCard(title: "Unable to load", message: error.map { vmMessage($0, fallback: "Unable to load this sent shift.") } ?? "Unable to load this sent shift.",
                        kind: .error, actionTitle: "Retry") { Task { await load() } }
        }
    }

    @ViewBuilder
    private func loaded(_ s: SentShift) -> some View {
        let style = ShiftVisualStyle.forShift(s.id)
        let look = sentShiftLook(s)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Image(systemName: "storefront").frame(width: 36, height: 36)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.white)).accessibilityHidden(true)
                Spacer()
                VMPill(tone: look).accessibilityIdentifier("vm.sent.status")
            }
            Text(s.venueName).scheduleType(ScheduleType.cardTitle)
            Text(VMText.displayRoleName(s.roleName)).scheduleType(ScheduleType.secondary)
            HStack(spacing: 20) {
                ShiftMetaItem(systemImage: "calendar", label: VMDate.weekdayDayYear(s.startsAt))
                ShiftMetaItem(systemImage: "clock", label: VMDate.sentTimeRange(s.startsAt, s.endsAt))
            }
            Divider().overlay(style.cardBorder)
            ShiftCardFooterLine(VMSentViews.sentLine(s))
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16))
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(style.card))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(style.cardBorder, lineWidth: 1))

        HStack {
            Text(VMSentViews.sentLine(s)).scheduleType(ScheduleType.caption)
            Spacer()
            if let submitted = s.submittedAt {
                Text(VMDate.sentAgo(submitted, now: Date())).scheduleType(ScheduleType.caption)
            }
        }
        .padding(.top, 12)

        VMSectionHeader(title: "Confirmed staff") {
            if let roster { Text("\(roster.confirmedCount) of \(s.requiredCount)").scheduleType(ScheduleType.caption) }
        }
        .padding(.top, 18)
        VStack(spacing: 10) {
            if roster == nil && loading {
                VMInlineLoading()
            } else if let roster {
                if roster.members.isEmpty { MessageCard(title: "No confirmed staff yet.") }
                ForEach(roster.members) { member in
                    Button {
                        if let report = roster.report, let row = member.row { review = (report, row) }
                    } label: {
                        VMStaffRow(name: member.name, role: member.role) { VMPill.booking(member) }
                    }
                    .buttonStyle(PressableButtonStyle())
                    .disabled(member.row == nil)
                }
                let responses = otherResponses(shiftId: shiftId, offers: store.offers, roster: roster)
                if !responses.isEmpty {
                    VMSectionHeader(title: "Other responses") {
                        Text("\(responses.count)").scheduleType(ScheduleType.caption)
                    }
                    .padding(.top, 14)
                    ForEach(Array(responses.enumerated()), id: \.offset) { _, response in
                        VMStaffRow(name: response.name, role: VMText.displayRoleName(s.roleName)) {
                            VMPill(response.label, background: RGBA(argb: 0xFFF1F0EC).color, foreground: ScheduleTokens.muted)
                        }
                    }
                }
            } else {
                MessageCard(title: "Unable to load", message: rosterError ?? "Unable to load confirmed staff.", kind: .error, actionTitle: "Retry") {
                    Task { await load() }
                }
            }
        }
        .padding(.top, 8)
    }

    @MainActor
    private func load() async {
        generation += 1
        let stamp = generation
        loading = true
        error = nil
        rosterError = nil
        let store = self.store
        let repository = store.repository
        let id = shiftId
        async let sentResult = vmSettle { try await repository.sentShift(id) }
        async let rosterResult = vmSettle { try await store.roster(for: id) }
        let (nextShift, shiftError) = await sentResult
        guard stamp == generation else { return }
        shift = nextShift
        error = shiftError
        let (nextRoster, failure) = await rosterResult
        guard stamp == generation else { return }
        roster = nextRoster
        rosterError = failure.map { vmMessage($0, fallback: "Unable to load confirmed staff.") }
        loading = false
    }
}

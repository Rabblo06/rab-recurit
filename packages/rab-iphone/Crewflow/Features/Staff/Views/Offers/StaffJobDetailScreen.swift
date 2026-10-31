import SwiftUI

/// Job Details (Flutter `ScheduleOfferDetailScreen`): venue photo (bytes
/// fetched with the session), role, venue, address, the live status control,
/// "Checked in · HH:mm", "Awaiting payroll approval", pills, NOTE, and the
/// action for the current state (Accept/Decline, Check In / Clock In / Clock
/// Out, Retry). The state is re-derived from the store on every render.
struct StaffJobDetailScreen: View {
    let snapshot: StaffOfferSummary

    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator
    @EnvironmentObject private var toasts: ToastCenter

    private var current: StaffOfferSummary { store.offer(id: snapshot.id) ?? snapshot }

    private var state: StaffDetailState {
        StaffDetailState.resolve(
            offer: current,
            active: store.active,
            history: store.history,
            clockableShiftId: StaffShiftRules.todaysConfirmedOffer(store.offers, now: store.displayNow)?.shiftId,
            loading: store.offersLoading || store.activeLoading || store.historyLoading,
            failed: store.offersError != nil || store.activeError != nil || store.historyError != nil,
            // Server-anchored time, as on the clock screen; never the device clock.
            now: store.attendanceNow
        )
    }

    var body: some View {
        let offer = current
        let style = ShiftVisualStyle.forShift(offer.shiftId)
        let state = self.state
        VStack(spacing: 0) {
            StaffScreenHeader(title: "Job Details")
            ScrollView {
                VStack(spacing: 0) {
                    StaffVenuePhoto(fileId: offer.venuePhotoFileId, size: 88, radius: 25, placeholder: style.staffIconTile, iconScale: 0.45, label: "\(offer.venueName) photo")
                        .padding(3)
                        .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(style.staffIconTile))
                        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(style.cardBorder, lineWidth: 1))
                        .padding(.bottom, 16)
                    Text(offer.roleName)
                        .scheduleType(ScheduleType.pageTitle)
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isHeader)
                    Text(offer.venueName)
                        .scheduleType(ScheduleType.body)
                        .multilineTextAlignment(.center)
                        .padding(.top, 4)
                    if let address = offer.venueAddress?.trimmingCharacters(in: .whitespacesAndNewlines), !address.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Image(systemName: "mappin.and.ellipse").staffFont(14).accessibilityHidden(true)
                            Text(address).scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                        }
                        .multilineTextAlignment(.center)
                        .padding(.top, 4)
                    }
                    StaffShiftStatusControl(offer: offer, style: style, fallback: state.label, reconciling: reconciling(offer))
                        .padding(.top, 10)
                    if StaffHistoryRules.awaitingPayroll(shiftId: offer.shiftId, history: store.history) {
                        // Finished but not yet in History (payroll-approved only).
                        Text("Shift completed — Awaiting payroll approval")
                            .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                            .multilineTextAlignment(.center)
                            .padding(.top, 10)
                            .accessibilityIdentifier("staff.detail.awaitingPayroll")
                    }
                    if state == .clockIn, let checkedIn = store.checkedInAt(offer) {
                        Text("Checked in · \(CrewflowDateFormat.time(checkedIn))")
                            .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                            .padding(.top, 10)
                            .accessibilityIdentifier("staff.detail.checkedIn")
                    }
                    // Group: keeps this ViewBuilder block within 10 direct
                    // children (iOS 16 has no variadic buildBlock). No layout change.
                    Group {
                        StaffOfferKindTag(offer: offer).padding(.top, 10)
                        pills(offer, style: style).padding(.top, 16)
                        Divider().overlay(style.cardBorder).padding(.vertical, 14)
                        StaffNoteCard(notes: offer.shiftNotes, style: style).padding(.top, 4)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .refreshable { await retry() }
        }
        .background(
            LinearGradient(colors: [style.staffDetailGradientTop, style.page], startPoint: .top, endPoint: .center)
                .ignoresSafeArea()
        )
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if hasAction(state) {
                BottomAction { action(offer, state: state) }
                    .background(style.page.opacity(0.96).ignoresSafeArea(edges: .bottom))
            }
        }
        .staffPushedScreen()
        .accessibilityIdentifier("staff.jobDetail")
    }

    private func reconciling(_ offer: StaffOfferSummary) -> Bool {
        offer.presentation?.state == "live"
            && store.history.contains { $0.shiftId == offer.shiftId && $0.clockOutAt != nil }
    }

    private func pills(_ offer: StaffOfferSummary, style: ShiftVisualStyle) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { pillSet(offer, style: style) }
            VStack(spacing: 8) { pillSet(offer, style: style) }
        }
    }

    @ViewBuilder
    private func pillSet(_ offer: StaffOfferSummary, style: ShiftVisualStyle) -> some View {
        StaffPill(systemImage: "sterlingsign", label: Money.payRateLabel(offer.payRatePence), style: style)
        StaffPill(systemImage: "calendar", label: StaffFormat.short(offer.startsAt), style: style)
        StaffPill(systemImage: "clock", label: "\(CrewflowDateFormat.time(offer.startsAt))–\(CrewflowDateFormat.time(offer.endsAt))", style: style)
    }

    private func hasAction(_ state: StaffDetailState) -> Bool {
        [.loading, .error, .offer, .clockIn, .clockOut].contains(state)
    }

    @ViewBuilder
    private func action(_ offer: StaffOfferSummary, state: StaffDetailState) -> some View {
        let busy = store.busyOfferId == offer.id
        switch state {
        case .loading:
            ProgressView().frame(height: ScheduleTokens.actionHeight)
        case .error:
            VStack(spacing: 4) {
                Text(store.offersError ?? store.activeError ?? store.historyError ?? "Unable to check this shift.")
                    .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.errorText))
                    .multilineTextAlignment(.center)
                PrimaryButton("Retry", variant: .light) { Task { await retry() } }
            }
        case .offer:
            HStack(spacing: 12) {
                PrimaryButton("Decline", variant: .light, isBusy: busy && store.busyAction == .decline) {
                    Task { @MainActor in await StaffOfferResponder.respond(store: store, toasts: toasts, offer: offer, action: .decline) }
                }
                .disabled(busy)
                PrimaryButton("Accept", isBusy: busy && store.busyAction == .accept) {
                    Task { @MainActor in await StaffOfferResponder.respond(store: store, toasts: toasts, offer: offer, action: .accept) }
                }
                .disabled(busy)
            }
        case .clockIn, .clockOut:
            // Bookings that need a Check In start there; older bookings keep Clock In.
            PrimaryButton(state == .clockOut ? "Clock Out" : (store.needsCheckIn(offer) ? "Check In" : "Clock In")) {
                navigator.push(.clock(offer))
            }
            .accessibilityIdentifier("staff.detail.clockAction")
        default:
            EmptyView()
        }
    }

    private func retry() async {
        async let offers: Void = store.loadOffers(full: true)
        async let active: Void = store.refreshActive()
        async let history: Void = store.loadHistory()
        _ = await (offers, active, history)
    }
}

/// Status capsule: server lifecycle label, or for a live shift the elapsed
/// HH:MM:SS from the server's clock-in (server time + monotonic clock). Asks
/// for a silent reload when the server's `nextTransitionAt` passes.
struct StaffShiftStatusControl: View {
    let offer: StaffOfferSummary
    let style: ShiftVisualStyle
    let fallback: String
    let reconciling: Bool

    @EnvironmentObject private var store: StaffStore

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { _ in
            let label = currentLabel()
            HStack(spacing: 6) {
                Image(systemName: icon).staffFont(14, .semibold).accessibilityHidden(true)
                Text(label).font(.system(size: 14, weight: .semibold).monospacedDigit())
                if store.offersError != nil {
                    Image(systemName: "icloud.slash")
                        .staffFont(14)
                        .accessibilityLabel("Last known status. Reconnect to refresh.")
                }
            }
            .foregroundStyle(ScheduleTokens.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Capsule().fill(style.badgeSurface))
            .overlay(Capsule().stroke(style.cardBorder, lineWidth: 1))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(offer.presentation?.state == "live" ? "Live elapsed time" : "Shift status"): \(label)")
        }
        .task(id: offer.presentation?.nextTransitionAt) { await reloadAtBoundary() }
    }

    private var icon: String {
        switch offer.presentation?.state ?? "" {
        case "live", "pending": return "clock"
        case "clockedOut": return "rectangle.portrait.and.arrow.right"
        case "complete": return "checkmark.circle"
        case "expired", "ended": return "clock.arrow.circlepath"
        default: return "briefcase"
        }
    }

    private func currentLabel() -> String {
        if reconciling { return "Updating status" }
        let presentation = offer.presentation
        if presentation?.state == "live", let clockInAt = presentation?.clockInAt {
            let now = store.offersNow ?? presentation?.serverNow ?? clockInAt
            return StaffFormat.clock(StaffFormat.seconds(from: clockInAt, to: now))
        }
        return presentation?.label ?? fallback
    }

    private func reloadAtBoundary() async {
        guard let boundary = offer.presentation?.nextTransitionAt, let now = store.offersNow else { return }
        let wait = boundary.timeIntervalSince(now)
        if wait > 0 {
            try? await Task.sleep(nanoseconds: UInt64((wait + 0.5) * 1_000_000_000))
        }
        guard !Task.isCancelled else { return }
        // Timer-driven (the server's next transition): background traffic,
        // queued behind any offers read already in flight.
        await store.loadOffers(silent: true, background: true)
    }
}

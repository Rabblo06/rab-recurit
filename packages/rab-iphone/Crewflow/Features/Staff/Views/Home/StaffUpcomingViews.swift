import SwiftUI

/// "Upcoming Shift" deck on Home: swipeable confirmed future shifts, plus
/// "view all ›" (Flutter `UpcomingShiftDeck`, schedule style).
struct StaffUpcomingDeck: View {
    let offers: [StaffOfferSummary]
    let loading: Bool

    @EnvironmentObject private var navigator: StaffNavigator
    @ScaledMetric(relativeTo: .body) private var cardHeight: CGFloat = 196
    @State private var page = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Upcoming Shift").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
                Spacer()
                Button { navigator.push(.upcoming) } label: {
                    Text("view all  ›").scheduleType(ScheduleType.caption).staffTouchTarget()
                }
                .buttonStyle(.plain)
                .disabled(offers.isEmpty)
                .accessibilityLabel("View all upcoming shifts")
            }
            if offers.isEmpty {
                Text(loading ? "Loading upcoming shifts…" : "No upcoming confirmed shifts.")
                    .scheduleType(ScheduleType.cardTitle)
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
                    .padding(26)
                    .background(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).fill(ScheduleTokens.lavender))
                    .accessibilityIdentifier("staff.upcoming.empty")
            } else {
                TabView(selection: $page) {
                    ForEach(Array(offers.enumerated()), id: \.element.id) { index, offer in
                        StaffUpcomingCard(offer: offer) { navigator.push(.jobDetail(offer)) }
                            .padding(.horizontal, 2)
                            .padding(.bottom, offers.count > 1 ? 28 : 4)
                            .tag(index)
                            .accessibilityLabel("Upcoming shift \(index + 1) of \(offers.count)")
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: offers.count > 1 ? .always : .never))
                .indexViewStyle(.page(backgroundDisplayMode: .always))
                .frame(height: cardHeight + (offers.count > 1 ? 28 : 4))
                .onChange(of: offers.count) { count in
                    if page >= count { page = 0 }
                }
            }
        }
    }
}

/// One deck card in the shift's identity colour.
struct StaffUpcomingCard: View {
    let offer: StaffOfferSummary
    let onOpen: () -> Void

    var body: some View {
        let style = ShiftVisualStyle.forShift(offer.shiftId)
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    StaffVenuePhoto(fileId: offer.venuePhotoFileId, size: 42, circle: true, placeholder: style.badgeSurface, label: "\(offer.venueName) photo")
                    Text(offer.venueName).scheduleType(ScheduleType.bodyStrong).lineLimit(2)
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.up.right")
                        .staffFont(15, .semibold)
                        .foregroundStyle(ScheduleTokens.ink)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Color.white))
                        .accessibilityHidden(true)
                }
                Text(offer.roleName).scheduleType(ScheduleType.pageTitle).lineLimit(2)
                Text("\(StaffFormat.weekdayShort(offer.startsAt)) · \(CrewflowDateFormat.time(offer.startsAt))–\(CrewflowDateFormat.time(offer.endsAt))")
                    .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                HStack {
                    Text("Pay rate").scheduleType(ScheduleType.caption)
                    Text(Money.payRateLabel(offer.payRatePence)).scheduleType(ScheduleType.bodyStrong)
                }
                StaffOfferKindTag(offer: offer)
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .padding(18)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).fill(style.card))
            .overlay(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).stroke(style.cardBorder, lineWidth: 1))
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the shift at \(offer.venueName)")
    }
}

/// "Upcoming Shifts": every confirmed future shift (the deck's "view all").
struct StaffUpcomingScreen: View {
    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator

    var body: some View {
        let upcoming = StaffHomeDashboard(offers: store.offers, now: store.displayNow).upcoming
        VStack(spacing: 0) {
            StaffScreenHeader(title: "Upcoming Shifts")
            ScrollView {
                LazyVStack(spacing: 16) {
                    if let error = store.offersError {
                        MessageCard(title: "Shifts unavailable", message: error, kind: .error, actionTitle: "Retry") {
                            Task { await store.loadOffers() }
                        }
                    }
                    if upcoming.isEmpty, store.offersError == nil {
                        EmptyStateView(systemImage: "calendar", title: "No upcoming confirmed shifts.")
                            .frame(minHeight: 280)
                    }
                    ForEach(upcoming) { offer in
                        StaffOfferCard(offer: offer)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .refreshable { await store.loadOffers(silent: true) }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .staffPushedScreen()
    }
}

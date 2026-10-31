import SwiftUI
import UIKit

/// Offers (pending + awaiting confirmation) or Confirmed (current shifts
/// only: upcoming, today's, live; finished shifts move to History). Both read
/// the same store; nothing is copied between categories (Flutter
/// `ScheduleOffersScreen`).
struct StaffOffersScreen: View {
    let confirmed: Bool

    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator

    private var items: [StaffOfferSummary] {
        confirmed
            ? StaffShiftRules.currentConfirmed(store.offers, now: store.displayNow)
            : StaffShiftRules.openOffers(store.offers)
    }

    var body: some View {
        VStack(spacing: 0) {
            StaffScreenHeader(title: confirmed ? "Confirmed" : "Offers", centerTitle: false) {
                Button { navigator.push(confirmed ? .offers : .confirmed) } label: {
                    Image(systemName: confirmed ? "briefcase" : "calendar.badge.checkmark")
                        .staffFont(18, .semibold)
                        .foregroundStyle(ScheduleTokens.ink)
                        .frame(width: 48, height: 48)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(confirmed ? "Offers" : "Confirmed")
            }
            content
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .staffPushedScreen()
        .accessibilityIdentifier(confirmed ? "staff.confirmed" : "staff.offers")
    }

    @ViewBuilder
    private var content: some View {
        if store.offersLoading && store.offers.isEmpty {
            LoadingView("Loading shifts")
        } else {
            ScrollView {
                LazyVStack(spacing: 16) {
                    if let error = store.offersError {
                        MessageCard(title: "Shifts unavailable", message: error, kind: .error, actionTitle: "Retry") {
                            Task { await store.loadOffers(full: true) }
                        }
                    } else if items.isEmpty {
                        EmptyStateView(
                            systemImage: confirmed ? "calendar.badge.checkmark" : "briefcase",
                            title: confirmed ? "No confirmed shifts" : "No offers right now",
                            message: confirmed
                                ? "Shifts you accept appear here until they finish. Finished shifts move to History."
                                : "New shift offers from your venues will appear here."
                        )
                        .frame(minHeight: 320)
                    }
                    ForEach(items) { offer in
                        StaffOfferCard(offer: offer)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .refreshable { await store.loadOffers(silent: true, full: true) }
        }
    }
}

/// The pastel offer card with inline Accept / Decline for a pending offer.
/// Success shows in place (the card changes or leaves); failures are an
/// error toast; an uncertain result reloads the list first.
struct StaffOfferCard: View {
    let offer: StaffOfferSummary

    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator
    @EnvironmentObject private var toasts: ToastCenter

    var body: some View {
        let style = ShiftVisualStyle.forShift(offer.shiftId)
        let busy = store.busyOfferId == offer.id
        PastelShiftCard(
            style: style,
            badge: StaffShiftRules.offerBadge(offer),
            role: offer.roleName,
            venue: offer.venueName,
            startsAt: offer.startsAt,
            endsAt: offer.endsAt,
            onOpen: { navigator.push(.jobDetail(offer)) }
        ) {
            HStack(alignment: .center, spacing: 10) {
                StaffVenuePhoto(fileId: offer.venuePhotoFileId, size: 36, circle: true, placeholder: style.badgeSurface, iconScale: 0.55, label: "\(offer.venueName) photo")
                ShiftCardFooterLine("\(Money.payRateLabel(offer.payRatePence)) · \(Money.estimatedPayLabel(ratePence: offer.payRatePence, estimatedPence: offer.estimatedPayPence))")
            }
            StaffOfferKindTag(offer: offer)
        } actions: {
            if offer.isPending {
                HStack(spacing: 12) {
                    PrimaryButton("Decline", variant: .light, isBusy: busy && store.busyAction == .decline) {
                        respond(.decline)
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("staff.offer.decline")
                    PrimaryButton("Accept", isBusy: busy && store.busyAction == .accept) {
                        respond(.accept)
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("staff.offer.accept")
                }
                .padding(.top, 4)
            }
        }
        .accessibilityIdentifier("staff.offerCard.\(offer.id)")
    }

    private func respond(_ action: StaffOfferAction) {
        Task { @MainActor in
            await StaffOfferResponder.respond(store: store, toasts: toasts, offer: offer, action: action)
        }
    }
}

/// Accept / Decline result handling shared by the list card and Job Details.
enum StaffOfferResponder {
    @MainActor
    static func respond(store: StaffStore, toasts: ToastCenter, offer: StaffOfferSummary, action: StaffOfferAction) async {
        switch await store.respond(to: offer, action: action) {
        case .accepted:
            // No success toast in the mobile app (owner rule); VoiceOver still hears it.
            UIAccessibility.post(notification: .announcement, argument: "Offer accepted.")
        case .declined:
            UIAccessibility.post(notification: .announcement, argument: "Offer declined.")
        case .failed(let message), .uncertain(let message):
            toasts.show(message, kind: .error)
        case .ignored:
            break
        }
    }
}

import '../../core/models/offer.dart';
import 'todays_shift.dart';

/// Shared presentation projection. It never fetches or mutates offer state.
class HomeDashboardData {
  HomeDashboardData(List<OfferSummary> offers, {DateTime? now}) {
    final instant = now ?? DateTime.now();
    today = todaysConfirmedOffer(offers);
    pending = offers.where((o) => o.status == 'pending').length;
    confirmed = offers.where((o) => o.status == 'manager_confirmed').length;
    upcoming =
        offers
            .where(
              (o) =>
                  o.status == 'manager_confirmed' &&
                  o.startsAt.isAfter(instant),
            )
            .toList()
          ..sort((a, b) => a.startsAt.compareTo(b.startsAt));
    final live = offers
        .where((o) => o.presentation?.state == 'live')
        .firstOrNull;
    final todays =
        offers
            .where(
              (o) =>
                  o.presentation?.state == 'confirmed' &&
                  o.presentation!.isToday,
            )
            .toList()
          ..sort((a, b) => a.startsAt.compareTo(b.startsAt));
    final post =
        offers
            .where(
              (o) => ['clockedOut', 'complete'].contains(o.presentation?.state),
            )
            .toList()
          ..sort((a, b) => b.endsAt.compareTo(a.endsAt));
    primary =
        live ??
        todays.firstOrNull ??
        post.firstOrNull ??
        today ??
        upcoming.firstOrNull;
  }
  late final OfferSummary? today;
  late final OfferSummary? primary;
  late final int pending, confirmed;
  late final List<OfferSummary> upcoming;
}

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
  }
  late final OfferSummary? today;
  late final int pending, confirmed;
  late final List<OfferSummary> upcoming;
}

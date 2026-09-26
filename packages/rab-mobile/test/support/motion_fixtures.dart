import 'package:rab_staff/core/models/offer.dart';

List<OfferSummary> motionOffers(int count, {DateTime? now}) =>
    List.generate(count, (i) {
      final date = (now ?? DateTime.now()).add(Duration(days: i + 1));
      return OfferSummary(
        id: 'motion-offer-$i',
        status: 'manager_confirmed',
        sentAt: date,
        expiresAt: date,
        estimatedPayPence: 8500 + i * 125,
        shiftId: 'motion-shift-$i',
        startsAt: date,
        endsAt: date.add(const Duration(hours: 8)),
        venueName: 'QA Venue ${i + 1}',
        roleName: i == 3
            ? 'Senior hospitality and events coordinator'
            : 'Event staff ${i + 1}',
        staffProfileId: 'motion-staff',
        staffName: 'Motion Preview',
        payRatePence: 1200 + i * 25,
      );
    });

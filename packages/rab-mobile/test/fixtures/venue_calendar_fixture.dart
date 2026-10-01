import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';
import 'package:rab_staff/navigation/moving_tab_bar.dart';

final calendarFixtureDay = DateTime(2026, 9, 28);
VenueManagerProvider calendarFixture({bool empty = false}) {
  final p = VenueManagerProvider(ApiClient(), 'visual-fixture')
    ..loading = false;
  if (empty) return p;
  for (var i = 0; i < 2; i++) {
    final start = DateTime(2026, 9, 27 + i, 16);
    final end = DateTime(2026, 9, 27 + i, 23);
    final id = 'calendar-fixture-$i';
    p.events.add(
      VenueEvent(
        {
          'id': id,
          'status': 'confirmed',
          'startsAt': start.toIso8601String(),
          'endsAt': end.toIso8601String(),
          'requiredCount': 4,
          'filledCount': 4,
          'address': '12 High Street, Bristol, BS1 2AB',
          'payRatePence': 1222,
        },
        role: 'Bartender',
        venue: 'The Riverside Hotel',
      ),
    );
    for (final name in [
      'Alex Example',
      'Sam Example',
      'Jordan Example',
      'Robin Example',
    ]) {
      p.offers.add(
        OfferSummary(
          id: '$id-$name',
          status: 'manager_confirmed',
          sentAt: start,
          expiresAt: end,
          estimatedPayPence: 0,
          shiftId: id,
          startsAt: start,
          endsAt: end,
          venueName: 'The Riverside Hotel',
          roleName: 'Bartender',
          staffProfileId: '$id-$name',
          staffName: name,
          payRatePence: 1222,
        ),
      );
    }
  }
  return p;
}

Widget calendarFixtureApp(VenueManagerProvider provider) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildLightTheme(),
  home: ChangeNotifierProvider.value(
    value: provider,
    child: Scaffold(
      body: VenueCalendarScreen(now: calendarFixtureDay, onProfile: () {}),
      bottomNavigationBar: MovingTabBar(
        index: 1,
        onSelected: (_) {},
        tabLabels: const ['Home', 'Calendar', 'History', 'Profile'],
      ),
    ),
  ),
);

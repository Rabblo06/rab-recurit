import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/schedule_calendar.dart';
import 'package:rab_staff/core/widgets/schedule_record_card.dart';
import 'package:rab_staff/features/calendar/calendar_view.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';
import 'package:rab_staff/navigation/moving_tab_bar.dart';

VenueEvent event(String id, String status, DateTime day) => VenueEvent(
  {
    'id': id,
    'status': status,
    'startsAt': DateTime(day.year, day.month, day.day, 9).toIso8601String(),
    'endsAt': DateTime(day.year, day.month, day.day, 10).toIso8601String(),
    'requiredCount': 5,
    'filledCount': 2,
    'address': 'Example address',
  },
  role: 'Bartender',
  venue: 'Example venue',
);

void main() {
  test('Venue statuses preserve real shift vocabulary', () {
    final labels = {
      'pending_manager_approval': 'Awaiting approval',
      'open': 'Open request',
      'offered': 'Offers sent',
      'partially_filled': 'Partially filled',
      'fully_filled': 'Filled',
      'confirmed': 'Confirmed',
      'in_progress': 'Live',
      'completed': 'Complete',
      'declined': 'Declined',
      'cancelled': 'Cancelled',
      'draft': 'Draft',
      'unknown': 'Updating',
    };
    for (final e in labels.entries) {
      expect(
        venueCalendarStatus(event('one', e.key, DateTime.now())).label,
        e.value,
      );
    }
  });
  test(
    'scheduled duration summary pluralizes and preserves midnight overlap',
    () {
      final entry = ScheduleCalendarEntry(
        id: 'one',
        start: DateTime(2026, 9, 29, 23),
        end: DateTime(2026, 9, 30),
        builder: (_) => const SizedBox(),
      );
      expect(scheduleSummary([entry], noun: 'event'), '1 event \u00b7 1 hour');
      expect(
        scheduleSummary([entry, entry], noun: 'event'),
        '2 events \u00b7 2 hours',
      );
      expect(scheduleEntriesOn([entry], DateTime(2026, 9, 30)), isEmpty);
    },
  );
  for (final size in [
    const Size(320, 640),
    const Size(393, 852),
    const Size(430, 932),
    const Size(390, 844),
  ]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('role geometry, data and modes $size text $scale', (t) async {
        t.view.physicalSize = size;
        t.view.devicePixelRatio = 1;
        addTearDown(t.view.reset);
        final now = DateTime.now();
        final p = VenueManagerProvider(ApiClient(), 'fixture')
          ..loading = false
          ..events = [
            event('one', 'partially_filled', now),
            event('cancelled', 'cancelled', now),
          ];
        addTearDown(p.dispose);
        Widget shell(Widget body, {bool venue = false}) => MaterialApp(
          theme: buildLightTheme(),
          home: MediaQuery(
            data: MediaQueryData(
              size: size,
              textScaler: TextScaler.linear(scale),
              disableAnimations: scale == 2,
            ),
            child: Scaffold(
              body: body,
              bottomNavigationBar: MovingTabBar(
                index: 1,
                onSelected: (_) {},
                scheduleStyle: true,
                tabLabels: [
                  'Home',
                  'Calendar',
                  venue ? 'Offers' : 'History',
                  'Profile',
                ],
              ),
            ),
          ),
        );
        await t.pumpWidget(
          shell(
            StaffCalendarView(
              items: const [],
              now: now,
              onOpen: (_) {},
              onProfile: () {},
              onRefresh: () async {},
            ),
          ),
        );
        await t.pumpAndSettle();
        await t.tap(find.text('Month'));
        await t.pumpAndSettle();
        final staff = t.getRect(
          find.byKey(const ValueKey('month-calendar-card')),
        );

        final nav = t.getRect(find.byKey(const ValueKey('navigation-shell')));
        await t.pumpWidget(
          shell(
            ChangeNotifierProvider.value(
              value: p,
              child: const VenueCalendarScreen(),
            ),
            venue: true,
          ),
        );
        await t.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('calendar-week-strip')),
          findsOneWidget,
        );
        await t.tap(find.text('Month'));
        await t.pumpAndSettle();
        final venue = t.getRect(
          find.byKey(const ValueKey('month-calendar-card')),
        );
        expect(venue.left, 16);
        expect(
          venue.width,
          staff.width,
        ); // Role legends may wrap to different heights.
        expect(t.getSize(find.byTooltip('Profile').first), const Size(44, 44));
        expect(t.getRect(find.byKey(const ValueKey('navigation-shell'))), nav);
        expect(find.byTooltip('Offers'), findsOneWidget);
        await t.scrollUntilVisible(
          find.text('1 event \u00b7 1 hour'),
          150,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('1 event \u00b7 1 hour'), findsOneWidget);
        expect(
          find.byKey(ValueKey('event-dot-${now.day}-partiallyFilled')),
          findsOneWidget,
        );
        final card = t.widget<ScheduleRecordCard>(
          find.byType(ScheduleRecordCard),
        );
        expect(card.metricValue, '2/5');
        expect(card.color, const Color(0xFFE7F4EE));
        expect(card.teamLabel, 'No team assigned');
        expect(card.scheduleLabel, contains('09:00'));
        t
            .state<ScrollableState>(find.byType(Scrollable).first)
            .position
            .jumpTo(0);
        await t.pumpAndSettle();
        await t.tap(find.byTooltip('Next month'));
        await t.pumpAndSettle();
        await t.scrollUntilVisible(
          find.text('No scheduled events'),
          150,
          scrollable: find.byType(Scrollable).first,
        );
        expect(
          find.text('No venue shifts are scheduled for this date.'),
          findsOneWidget,
        );
        t
            .state<ScrollableState>(find.byType(Scrollable).first)
            .position
            .jumpTo(0);
        await t.pumpAndSettle();
        await t.tap(find.text('Today'));
        await t.pumpAndSettle();
        expect(find.byKey(const ValueKey('month-calendar-card')), findsNothing);
        expect(
          find.byKey(const ValueKey('calendar-week-strip')),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('venue-week-agenda')), findsOneWidget);
        await t.tap(find.text('Month'));
        await t.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('month-calendar-card')),
          findsOneWidget,
        );
        expect(t.takeException(), isNull);
      });
    }
  }
}

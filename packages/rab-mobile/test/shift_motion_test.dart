import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'dart:convert';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/widgets/upcoming_shift_deck.dart';
import 'package:rab_staff/features/home/widgets/upcoming_shift_card.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offers/schedule_offer_detail_screen.dart';
import 'package:rab_staff/navigation/moving_tab_bar.dart';
import 'support/motion_fixtures.dart';

void main() {
  Future<void> mount(
    WidgetTester tester,
    int count, {
    bool reduced = false,
    bool schedule = true,
  }) async {
    // ScheduleOfferDetailScreen (the destination `shiftDetailRoute` now
    // always opens) reads OffersProvider and AttendanceProvider for its
    // accept/decline/live-shift state — real dependencies, so both must be
    // provided here even though this file's own tests only exercise the
    // deck/motion, not those actions.
    final api = ApiClient(
      httpClient: MockClient((request) async {
        if (request.url.path.endsWith('/attendance/me/active')) {
          return http.Response(
            jsonEncode({
              'attendance': null,
              'serverNow': DateTime.now().toIso8601String(),
            }),
            200,
          );
        }
        return http.Response('[]', 200);
      }),
    );
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<OffersProvider>(
            create: (_) => OffersProvider(api),
          ),
          ChangeNotifierProvider<AttendanceProvider>(
            create: (_) => AttendanceProvider(api),
          ),
        ],
        child: MaterialApp(
          theme: buildLightTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
            child: child!,
          ),
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(16),
              child: UpcomingShiftDeck(
                offers: motionOffers(count),
                schedule: schedule,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder open(String venue) => find.bySemanticsLabel('Open shift at $venue');

  /// `ScheduleOfferDetailScreen` carries a genuinely continuous decorative
  /// animation (confirmed via `tester.binding.hasScheduledFrame` staying
  /// `true` indefinitely — this is normal/intended in the real app, not a
  /// bug), so `pumpAndSettle()` can never return once it's on screen. Bound
  /// the wait instead, matching this codebase's own established pattern for
  /// screens with a deliberately unbounded animation (see
  /// `theme_smoke_test.dart`'s `AuthFlowShell` case).
  Future<void> settleDetailOpen(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 550));
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets(
    'Schedule colours survive reorder, rebuild, additions and removal',
    (tester) async {
      final original = motionOffers(6);
      var items = original.take(5).toList();
      late StateSetter update;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildLightTheme(),
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return UpcomingShiftDeck(offers: items, schedule: true);
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      void check() {
        for (final card in tester.widgetList<UpcomingShiftCard>(
          find.byType(UpcomingShiftCard),
        )) {
          final index = original.indexWhere(
            (o) => o.shiftId == card.offer.shiftId,
          );
          expect(card.visualStyle, ShiftVisualStyle.values[index % 5]);
        }
      }

      check();
      update(() {});
      await tester.pumpAndSettle();
      check();
      update(
        () => items = [
          original[2],
          original[0],
          original[3],
          original[1],
          original[4],
        ],
      );
      await tester.pumpAndSettle();
      check();
      update(() => items = [original[5], original[3], original[4]]);
      await tester.pumpAndSettle();
      check();
      // A removed shift is a new arrival when reintroduced, not a retained entry.
      update(() => items = [original[0]]);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<UpcomingShiftCard>(find.byType(UpcomingShiftCard))
            .visualStyle,
        ShiftVisualStyle.yellow,
      );
    },
  );
  for (final count in [0, 1, 2, 3, 5, 10]) {
    testWidgets(
      'Schedule $count records: bounded surfaces and full cyclic reach',
      (tester) async {
        await mount(tester, count, schedule: true);
        final visible = count.clamp(0, 3);
        expect(find.byType(UpcomingShiftCard), findsNWidgets(visible));
        if (count == 0) return;
        final deck = find.byKey(const ValueKey('upcoming-deck'));
        for (final direction in [-1, 1]) {
          for (var step = 1; step <= count; step++) {
            await tester.drag(deck, Offset(0, direction * 130));
            for (var frame = 0; frame < 25; frame++) {
              await tester.pump(const Duration(milliseconds: 16));
              expect(find.byType(UpcomingShiftCard), findsNWidgets(visible));
              final ids = tester
                  .widgetList<UpcomingShiftCard>(find.byType(UpcomingShiftCard))
                  .map((card) => card.offer.id)
                  .toList();
              expect(ids.toSet().length, ids.length);
              for (final card in tester.widgetList<UpcomingShiftCard>(
                find.byType(UpcomingShiftCard),
              )) {
                final original = motionOffers(
                  count,
                ).indexWhere((o) => o.shiftId == card.offer.shiftId);
                expect(card.visualStyle, ShiftVisualStyle.values[original % 5]);
              }
            }
            await tester.pumpAndSettle();
            final front = direction == -1
                ? step % count
                : (count - step) % count;
            expect(
              find.bySemanticsLabel(
                RegExp('Upcoming shift ${front + 1} of $count'),
              ),
              findsOneWidget,
            );
          }
        }
        expect(tester.takeException(), isNull);
      },
    );
  }
  for (final count in [0, 1, 2, 3, 12]) {
    testWidgets('deck cycles $count real records, with resistance for one', (
      tester,
    ) async {
      await mount(tester, count);
      if (count == 0) {
        expect(find.text('No upcoming confirmed shifts.'), findsOneWidget);
      } else {
        final deck = find.byKey(const ValueKey('upcoming-deck'));
        await tester.drag(deck, const Offset(0, 120));
        await tester.pumpAndSettle();
        expect(
          find.bySemanticsLabel(RegExp('Upcoming shift $count of $count')),
          findsOneWidget,
        );
        await tester.fling(deck, const Offset(0, -150), 900);
        await tester.pumpAndSettle();
        expect(
          find.bySemanticsLabel(RegExp('Upcoming shift 1 of $count')),
          findsOneWidget,
        );
        await tester.drag(deck, const Offset(0, -150));
        await tester.pumpAndSettle();
        expect(
          find.bySemanticsLabel(
            RegExp('Upcoming shift ${count > 1 ? 2 : 1} of $count'),
          ),
          findsOneWidget,
        );
      }
      expect(tester.takeException(), isNull);
    });
  }
  List<String> visualOrder(WidgetTester tester) {
    final cards = tester
        .widgetList<UpcomingShiftCard>(find.byType(UpcomingShiftCard))
        .toList();
    cards.sort(
      (a, b) => tester
          .getTopLeft(find.byWidget(b))
          .dy
          .compareTo(tester.getTopLeft(find.byWidget(a)).dy),
    );
    return cards.map((c) => c.offer.id).toList();
  }

  testWidgets('ABC cycles forward and backward with stable card elements', (
    tester,
  ) async {
    await mount(tester, 3);
    final a = tester.element(
      find.byKey(const ValueKey('deck-card-motion-offer-0')),
    );
    final deck = find.byKey(const ValueKey('upcoming-deck'));
    for (final front in [1, 2, 0]) {
      await tester.fling(deck, const Offset(0, -130), 900);
      await tester.pumpAndSettle();
      expect(visualOrder(tester), [
        for (var i = 0; i < 3; i++) 'motion-offer-${(front + i) % 3}',
      ]);
      expect(
        tester.element(find.byKey(const ValueKey('deck-card-motion-offer-0'))),
        same(a),
      );
    }
    for (final front in [2, 1, 0]) {
      await tester.fling(deck, const Offset(0, 130), 900);
      await tester.pumpAndSettle();
      expect(visualOrder(tester), [
        for (var i = 0; i < 3; i++) 'motion-offer-${(front + i) % 3}',
      ]);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'rapid swipes lock during settle and direction reversal is safe',
    (tester) async {
      await mount(tester, 3);
      final deck = find.byKey(const ValueKey('upcoming-deck'));
      await tester.drag(deck, const Offset(0, -130));
      await tester.pump(const Duration(milliseconds: 30));
      await tester.drag(deck, const Offset(0, -130));
      await tester.pumpAndSettle();
      expect(visualOrder(tester).first, 'motion-offer-1');
      final gesture = await tester.startGesture(tester.getCenter(deck));
      await gesture.moveBy(const Offset(0, -50));
      await tester.pump(const Duration(milliseconds: 80));
      await gesture.moveBy(const Offset(0, 180));
      await tester.pump(const Duration(milliseconds: 80));
      await gesture.up();
      await tester.pumpAndSettle();
      expect(visualOrder(tester).first, 'motion-offer-0');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('selected cyclic card opens once and returns to its exact slot', (
    tester,
  ) async {
    await mount(tester, 3);
    await tester.drag(
      find.byKey(const ValueKey('upcoming-deck')),
      const Offset(0, 140),
    );
    await tester.pumpAndSettle();
    final selected = open('QA Venue 3');
    final before = tester.getRect(selected);
    await tester.tap(selected);
    await tester.tap(selected);
    await settleDetailOpen(tester);
    expect(find.byType(ScheduleOfferDetailScreen), findsOneWidget);
    expect(
      tester
          .widget<ScheduleOfferDetailScreen>(
            find.byType(ScheduleOfferDetailScreen),
          )
          .offer
          .shiftId,
      'motion-shift-2',
    );
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(tester.getRect(selected), before);
    expect(visualOrder(tester), [
      'motion-offer-2',
      'motion-offer-0',
      'motion-offer-1',
    ]);
    await tester.tap(find.bySemanticsLabel('View all upcoming shifts'));
    await tester.pumpAndSettle();
    expect(
      tester
          .getTopLeft(find.byKey(const ValueKey('expanded-motion-offer-2')))
          .dy,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('expanded-motion-offer-0')))
            .dy,
      ),
    );
    await tester.binding.handlePopRoute();
    await tester.pump(const Duration(milliseconds: 40));
    await tester.pumpAndSettle();
    expect(tester.getRect(selected), before);
    expect(tester.takeException(), isNull);
  });
  testWidgets('short drag follows finger then cancels without changing shift', (
    tester,
  ) async {
    await mount(tester, 3);
    final deck = find.byKey(const ValueKey('upcoming-deck'));
    final gesture = await tester.startGesture(tester.getCenter(deck));
    await gesture.moveBy(const Offset(0, -30));
    await tester.pump();
    await gesture.moveBy(const Offset(0, -20));
    await tester.pump();
    await gesture.cancel();
    await tester.pumpAndSettle();
    expect(
      find.bySemanticsLabel(RegExp('Upcoming shift 1 of 3')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'twelve-card cycle wraps in both directions and reduced motion cycles',
    (tester) async {
      await mount(tester, 12, reduced: true);
      final deck = find.byKey(const ValueKey('upcoming-deck'));
      for (var i = 1; i <= 12; i++) {
        await tester.drag(deck, const Offset(0, -120));
        await tester.pumpAndSettle();
        expect(
          find.bySemanticsLabel(RegExp('Upcoming shift ${i % 12 + 1} of 12')),
          findsOneWidget,
        );
      }
      await tester.drag(deck, const Offset(0, 120));
      await tester.pumpAndSettle();
      expect(
        find.bySemanticsLabel(RegExp('Upcoming shift 12 of 12')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('View All can reverse before expansion completes', (
    tester,
  ) async {
    await mount(tester, 3);
    final before = tester.getRect(open('QA Venue 1'));
    await tester.tap(find.bySemanticsLabel('View all upcoming shifts'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 110));
    await tester.pump(const Duration(milliseconds: 60));
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(tester.getRect(open('QA Venue 1')), before);
    await tester.drag(
      find.byKey(const ValueKey('upcoming-deck')),
      const Offset(0, -120),
    );
    await tester.pumpAndSettle();
    expect(visualOrder(tester).first, 'motion-offer-1');
    expect(tester.takeException(), isNull);
  });
  testWidgets('detail carries correct offer and reverses on system back', (
    tester,
  ) async {
    await mount(tester, 3);
    await tester.tap(open('QA Venue 1'));
    await settleDetailOpen(tester);
    expect(
      tester
          .widget<ScheduleOfferDetailScreen>(
            find.byType(ScheduleOfferDetailScreen),
          )
          .offer
          .shiftId,
      'motion-shift-0',
    );
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(ScheduleOfferDetailScreen), findsNothing);
    expect(open('QA Venue 1'), findsOneWidget);
  });
  testWidgets('View All expands, scrolls, and collapses to active card', (
    tester,
  ) async {
    await mount(tester, 12);
    await tester.tap(find.bySemanticsLabel('View all upcoming shifts'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('expanded-motion-offer-0')),
      findsOneWidget,
    );
    await tester.fling(
      find.byKey(const ValueKey('expanded-motion-offer-0')),
      const Offset(0, -400),
      1200,
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('expanded-motion-offer-0')), findsNothing);
    expect(
      find.bySemanticsLabel(RegExp('Upcoming shift 1 of 12')),
      findsOneWidget,
    );
  });
  testWidgets('reduced motion retains detail and View All navigation', (
    tester,
  ) async {
    await mount(tester, 1, reduced: true);
    await tester.tap(open('QA Venue 1'));
    await settleDetailOpen(tester);
    expect(find.byType(ScheduleOfferDetailScreen), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('View all upcoming shifts'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('expanded-motion-offer-0')),
      findsOneWidget,
    );
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
  testWidgets('one navigation pill retargets under rapid taps', (tester) async {
    var index = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildLightTheme(),
        home: Scaffold(
          bottomNavigationBar: StatefulBuilder(
            builder: (context, update) => MovingTabBar(
              index: index,
              onSelected: (i) => update(() => index = i),
            ),
          ),
        ),
      ),
    );
    final pill = find.byKey(const ValueKey('moving-tab-pill'));
    final start = tester.getTopLeft(pill).dx;
    await tester.tap(find.byTooltip('Calendar'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 80));
    expect(tester.getTopLeft(pill).dx, greaterThan(start));
    await tester.tap(find.byTooltip('History'));
    await tester.pump();
    await tester.tap(find.byTooltip('Profile'));
    await tester.pumpAndSettle();
    expect(index, 3);
    expect(pill, findsOneWidget);
    await tester.tap(find.byTooltip('Home'));
    await tester.pumpAndSettle();
    expect(index, 0);
    expect(tester.getTopLeft(pill).dx, start);
    expect(tester.takeException(), isNull);
  });
}

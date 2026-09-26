import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';
import 'package:rab_staff/core/widgets/schedule_feedback.dart';
import 'package:rab_staff/core/widgets/schedule_record_card.dart';
import 'package:rab_staff/navigation/moving_tab_bar.dart';
import 'package:rab_staff/features/home/widgets/upcoming_shift_deck.dart';
import 'support/motion_fixtures.dart';

void main() {
  setUpAll(() async {
    final fonts =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    for (final entry in {
      'Roboto': 'roboto-regular.ttf',
      'MaterialIcons': 'materialicons-regular.otf',
    }.entries) {
      await (FontLoader(entry.key)..addFont(
            File(
              '$fonts/${entry.value}',
            ).readAsBytes().then(ByteData.sublistView),
          ))
          .load();
    }
  });
  testWidgets('upcoming deck idle and held geometry goldens', (tester) async {
    tester.view.physicalSize = const Size(393, 360);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildLightTheme(),
        home: Scaffold(
          body: RepaintBoundary(
            key: const ValueKey('deck-golden'),
            child: ColoredBox(
              color: ScheduleTokens.homeBackground,
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: UpcomingShiftDeck(
                  offers: motionOffers(3, now: DateTime(2026, 9, 22, 9)),
                  schedule: true,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final deck = find.byKey(const ValueKey('deck-golden'));
    await expectLater(
      deck,
      matchesGoldenFile('goldens/upcoming-deck-idle.png'),
    );
    final front = find.byKey(const ValueKey('deck-card-motion-offer-0'));
    final before = tester.getRect(front);
    final gesture = await tester.startGesture(before.center);
    await tester.pump(const Duration(milliseconds: 120));
    expect(tester.getRect(front), before);
    await expectLater(
      deck,
      matchesGoldenFile('goldens/upcoming-deck-pressed.png'),
    );
    await gesture.cancel();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
  for (final venue in [false, true]) {
    for (var tab = 0; tab < 4; tab++) {
      testWidgets('${venue ? 'venue' : 'staff'} navigation state $tab golden', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(393, 140);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            theme: buildLightTheme(),
            home: RepaintBoundary(
              key: const ValueKey('navigation-golden'),
              child: Scaffold(
                backgroundColor: ScheduleTokens.homeBackground,
                bottomNavigationBar: MovingTabBar(
                  index: tab,
                  scheduleStyle: true,
                  onSelected: (_) {},
                  tabLabels: venue
                      ? const ['Home', 'Calendar', 'Offers', 'Profile']
                      : null,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byKey(const ValueKey('navigation-golden')),
          matchesGoldenFile(
            'goldens/navigation-${venue ? 'venue' : 'staff'}-$tab.png',
          ),
        );
      });
    }
    testWidgets('${venue ? 'venue' : 'staff'} shared surfaces golden', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(393, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildLightTheme(),
          home: RepaintBoundary(
            key: const ValueKey('surface-golden'),
            child: Scaffold(
              backgroundColor: ScheduleTokens.homeBackground,
              body: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      venue ? 'Upcoming Event' : 'Upcoming Shift',
                      style: ScheduleTokens.heading,
                    ),
                    const SizedBox(height: 20),
                    SizedBox(
                      height: 188,
                      child: ScheduleRecordCard(
                        title: 'Bartender',
                        venue: 'The Riverside Hotel',
                        address: '12 High Street, Bristol, BS1 2AB',
                        color: ScheduleTokens.lavender,
                        metricLabel: venue ? 'Staff joined' : 'Pay rate',
                        metricValue: venue ? '3/20' : '12.42/h',
                        teamLabel: venue ? 'Staff Members' : 'Team Member',
                        names: venue
                            ? [
                                'Alice Example',
                                'Sam Green',
                                'Jo Lee',
                                'Ben Hill',
                              ]
                            : ['Alice Example'],
                        onOpen: () {},
                      ),
                    ),
                    const SizedBox(height: 20),
                    ScheduleMessageCard(
                      title: 'Shift completed',
                      kind: ScheduleMessageKind.success,
                      actionLabel: 'Back to shifts',
                      onAction: () {},
                    ),
                    const SizedBox(height: 20),
                    SchedulePrimaryButton(
                      label: 'Clock in',
                      icon: Icons.watch_later_outlined,
                      onPressed: () {},
                    ),
                  ],
                ),
              ),
              bottomNavigationBar: MovingTabBar(
                index: 1,
                onSelected: (_) {},
                tabLabels: venue
                    ? const ['Home', 'Calendar', 'Offers', 'Profile']
                    : null,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byKey(const ValueKey('surface-golden')),
        matchesGoldenFile(
          'goldens/schedule-${venue ? 'venue' : 'staff'}-surfaces.png',
        ),
      );
    });
  }
  for (final kind in ScheduleMessageKind.values) {
    testWidgets('message ${kind.name} golden', (tester) async {
      tester.view.physicalSize = const Size(393, 260);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildLightTheme(),
          home: RepaintBoundary(
            key: const ValueKey('message-golden'),
            child: Scaffold(
              backgroundColor: ScheduleTokens.homeBackground,
              body: Padding(
                padding: const EdgeInsets.all(ScheduleTokens.homeInset),
                child: ScheduleMessageCard(
                  title: 'Attendance update',
                  message: 'Your worked time is being updated.',
                  kind: kind,
                  actionLabel: 'Refresh',
                  onAction: () {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byKey(const ValueKey('message-golden')),
        matchesGoldenFile('goldens/message-${kind.name}.png'),
      );
    });
  }
}

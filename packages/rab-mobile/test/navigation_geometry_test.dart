import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';
import 'package:rab_staff/navigation/moving_tab_bar.dart';

void main() {
  for (final width in [320.0, 393.0, 430.0]) {
    for (final venue in [false, true]) {
      testWidgets('${venue ? 'Venue' : 'Staff'} equal nav geometry at $width', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 852);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        var selected = 0;
        final labels = [
          'Home',
          'Calendar',
          venue ? 'Offers' : 'History',
          'Profile',
        ];
        await tester.pumpWidget(
          MaterialApp(
            theme: buildLightTheme(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                padding: const EdgeInsets.only(bottom: 24),
                viewPadding: const EdgeInsets.only(bottom: 24),
              ),
              child: child!,
            ),
            home: Scaffold(
              bottomNavigationBar: StatefulBuilder(
                builder: (context, update) => MovingTabBar(
                  index: selected,
                  tabLabels: labels,
                  onSelected: (index) => update(() => selected = index),
                ),
              ),
            ),
          ),
        );
        final shell = tester.getRect(
          find.byKey(const ValueKey('navigation-shell')),
        );
        expect(shell.width, closeTo(width * .9, .01));
        expect(shell.height, ScheduleTokens.navigationHeight);
        expect(shell.center.dx, closeTo(width / 2, .01));
        expect(shell.bottom, lessThanOrEqualTo(852 - 24));
        final items = List.generate(
          4,
          (i) => tester.getRect(find.byKey(ValueKey('navigation-item-$i'))),
        );
        for (var i = 0; i < 4; i++) {
          expect(items[i].width, closeTo(items.first.width, .01));
          expect(items[i].height, greaterThanOrEqualTo(48));
          expect(items[i].center.dy, closeTo(shell.center.dy, .01));
          if (i > 0) expect(items[i].left, closeTo(items[i - 1].right, .01));
          await tester.tap(find.byTooltip(labels[i]));
          await tester.pump();
          for (final elapsed in [0, 16, 40, 100]) {
            await tester.pump(Duration(milliseconds: elapsed));
            expect(
              tester.getRect(find.byKey(const ValueKey('navigation-shell'))),
              shell,
            );
            for (var j = 0; j < 4; j++) {
              expect(
                tester.getRect(find.byKey(ValueKey('navigation-item-$j'))),
                items[j],
              );
            }
            final selectedCircle = tester.getRect(
              find.byKey(const ValueKey('moving-tab-pill')),
            );
            expect(
              selectedCircle.center.dx,
              closeTo(items[i].center.dx, .0001),
            );
            expect(
              selectedCircle.center.dy,
              closeTo(items[i].center.dy, .0001),
            );
            expect(selectedCircle.width, closeTo(54, .0001));
            expect(selectedCircle.height, closeTo(54, .0001));
          }
          await tester.pumpAndSettle();
          final circle = tester.getRect(
            find.byKey(const ValueKey('moving-tab-pill')),
          );
          expect(circle.width, closeTo(54, .01));
          expect(circle.height, closeTo(54, .01));
          expect(circle.center.dx, closeTo(items[i].center.dx, .01));
          expect(circle.center.dy, closeTo(items[i].center.dy, .01));
          expect(selected, i);
          expect(
            tester
                .widget<Semantics>(find.byKey(ValueKey('navigation-item-$i')))
                .properties
                .selected,
            isTrue,
          );
        }
        expect(find.byTooltip(venue ? 'History' : 'Offers'), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/widgets/schedule_calendar.dart';
import 'package:rab_staff/core/widgets/schedule_feedback.dart';
import 'package:rab_staff/core/widgets/schedule_record_card.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';

void main() {
  testWidgets('shared sheet applies keyboard and safe insets once', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.view.viewInsets = const FakeViewPadding(bottom: 250);
    tester.view.padding = const FakeViewPadding(bottom: 24);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showScheduleSheet<void>(
                context: context,
                builder: (sheet) => Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('Correct attendance'),
                    const TextField(
                      decoration: InputDecoration(labelText: 'Reason'),
                    ),
                    const SizedBox(height: 400),
                    SchedulePrimaryButton(
                      label: 'Save correction',
                      onPressed: () => Navigator.pop(sheet),
                    ),
                  ],
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Save correction'));
    await tester.pumpAndSettle();
    final button = find.widgetWithText(FilledButton, 'Save correction');
    expect(tester.getBottomRight(button).dy, lessThanOrEqualTo(390));
    expect(tester.getTopLeft(button).dx, ScheduleTokens.sheetInset);
    expect(tester.getSize(button).width, 320 - 2 * ScheduleTokens.sheetInset);
    expect(tester.takeException(), isNull);
    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(find.text('Correct attendance'), findsNothing);
  });

  testWidgets('dismissal does not confirm a sheet action', (tester) async {
    bool? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                result = await showScheduleSheet<bool>(
                  context: context,
                  builder: (sheet) => SchedulePrimaryButton(
                    label: 'Confirm',
                    onPressed: () => Navigator.pop(sheet, true),
                  ),
                );
              },
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(result, isNull);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    expect(result, isTrue);
  });

  testWidgets('busy primary action cannot submit twice', (tester) async {
    var calls = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SchedulePrimaryButton(
            label: 'Save',
            busy: true,
            onPressed: () => calls++,
          ),
        ),
      ),
    );
    await tester.tap(find.byType(FilledButton));
    expect(calls, 0);
  });

  for (final size in [const Size(320, 640), const Size(393, 852)]) {
    testWidgets('calendar overnight record and navigation at $size', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final now = DateTime.now();
      var opened = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: ScheduleCalendar(
            emptyTitle: 'No shifts',
            onProfile: () {},
            entries: [
              ScheduleCalendarEntry(
                id: 'overnight',
                start: DateTime(now.year, now.month, now.day - 1, 22),
                end: DateTime(now.year, now.month, now.day, 8),
                builder: (_) => ScheduleRecordCard(
                  title: 'Bartender',
                  venue: 'Hotel',
                  address: '12 High Street',
                  color: ScheduleTokens.mint,
                  metricLabel: 'Pay rate',
                  metricValue: '12.42/h',
                  teamLabel: 'Team Member',
                  names: const ['Alice Example'],
                  onOpen: () => opened++,
                ),
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Bartender'), findsOneWidget);
      await tester.tap(find.byTooltip('Open Bartender at Hotel'));
      expect(opened, 1);
      await tester.tap(find.byTooltip('Next week'));
      await tester.pumpAndSettle();
      expect(find.text('Bartender'), findsNothing);
      await tester.tap(find.text('Today'));
      await tester.pumpAndSettle();
      expect(find.text('Bartender'), findsOneWidget);
      await tester.tap(find.text('Month'));
      await tester.pumpAndSettle();
      expect(find.byType(CalendarDatePicker), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('message and card tolerate enlarged text and unknown members', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: const Scaffold(
          body: SingleChildScrollView(
            child: Column(
              children: [
                ScheduleRecordCard(
                  title: 'Bartender',
                  venue: 'A long venue name',
                  color: ScheduleTokens.mint,
                  metricLabel: 'Staff joined',
                  metricValue: '12/20',
                  teamLabel: 'Staff Members',
                  names: [],
                ),
                ScheduleMessageCard(
                  title: 'Shift completed',
                  message: 'Your attendance has been recorded.',
                  kind: ScheduleMessageKind.success,
                ),
              ],
            ),
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.text('+7'), findsNothing);
  });
}

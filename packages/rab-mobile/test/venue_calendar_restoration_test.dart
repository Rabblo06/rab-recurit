import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/widgets/schedule_calendar.dart';
import 'package:rab_staff/core/widgets/schedule_record_card.dart';
import 'fixtures/venue_calendar_fixture.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

void main() {
  setUpAll(() async {
    final dir =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    for (final entry in {
      'Roboto': 'roboto-regular.ttf',
      'MaterialIcons': 'materialicons-regular.otf',
    }.entries) {
      await (FontLoader(entry.key)..addFont(
            File(
              '$dir/${entry.value}',
            ).readAsBytes().then((b) => ByteData.sublistView(b)),
          ))
          .load();
    }
  });
  testWidgets('Figma agenda golden, dates, real data and retained Month grid', (
    t,
  ) async {
    t.view.physicalSize = const Size(390, 844);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final p = calendarFixture();
    addTearDown(p.dispose);
    await t.pumpWidget(calendarFixtureApp(p));
    await t.pumpAndSettle();
    expect(find.text('September 2026'), findsOneWidget);
    expect(find.byKey(const ValueKey('calendar-week-strip')), findsOneWidget);
    expect(find.byType(ScheduleRecordCard), findsNWidgets(2));
    expect(find.text('Bartender'), findsNWidgets(2));
    expect(find.text('Team Members'), findsNWidgets(2));
    expect(find.text('No scheduled events'), findsNothing);
    expect(find.byType(ScheduleAvatarStack), findsNWidgets(2));
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/venue-calendar-restored.png'),
    );
    await t.tap(find.byKey(const ValueKey('week-day-2026-09-29')));
    await t.pumpAndSettle();
    t.state<ScrollableState>(find.byType(Scrollable).first).position.jumpTo(0);
    await t.pumpAndSettle();
    final selected = t.widget<Semantics>(
      find
          .ancestor(
            of: find.byKey(const ValueKey('week-day-2026-09-29')),
            matching: find.byType(Semantics),
          )
          .first,
    );
    expect(selected.properties.selected, isTrue);
    await t.tap(find.text('Month'));
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('month-calendar-card')), findsOneWidget);
    await t.tap(find.text('Today'));
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('venue-week-agenda')), findsOneWidget);
    expect(t.takeException(), isNull);
  });
  testWidgets('empty week keeps date rail without generic empty card', (
    t,
  ) async {
    final p = calendarFixture(empty: true);
    addTearDown(p.dispose);
    await t.pumpWidget(calendarFixtureApp(p));
    await t.pumpAndSettle();
    expect(find.text('No scheduled events'), findsOneWidget);
    expect(
      find.text('No venue shifts are scheduled for this date.'),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('calendar-week-strip')), findsOneWidget);
  });
  testWidgets(
    'multiple shifts share a day rail and missing pay stays truthful',
    (t) async {
      final p = calendarFixture();
      addTearDown(p.dispose);
      final source = p.events.first;
      final data = Map<String, dynamic>.of(source.json)
        ..['id'] = 'extra'
        ..remove('payRatePence');
      p.events.add(VenueEvent(data, role: 'Extra role', venue: 'Extra venue'));
      await t.pumpWidget(calendarFixtureApp(p));
      await t.pumpAndSettle();
      expect(find.byType(ScheduleRecordCard), findsNWidgets(3));
      expect(find.text('27'), findsNWidgets(2));
      final card = t
          .widgetList<ScheduleRecordCard>(find.byType(ScheduleRecordCard))
          .singleWhere((c) => c.title == 'Extra role');
      expect(card.metricLabel, 'Staff joined');
      expect(card.metricValue, '4/4');
      expect(t.takeException(), isNull);
    },
  );
  testWidgets('agenda loading and retry retain the date controls', (t) async {
    var retries = 0;
    Widget screen({bool loading = false, String? error}) => MaterialApp(
      home: ScheduleCalendar(
        entries: const [],
        emptyTitle: 'No scheduled events',
        agendaStyle: true,
        now: calendarFixtureDay,
        loading: loading,
        error: error,
        onRetry: () => retries++,
      ),
    );
    await t.pumpWidget(screen(loading: true));
    await t.pump();
    expect(find.bySemanticsLabel('Loading schedule'), findsOneWidget);
    expect(find.byKey(const ValueKey('calendar-week-strip')), findsOneWidget);
    await t.pumpWidget(screen(error: 'private backend error'));
    await t.pumpAndSettle();
    expect(find.text('private backend error'), findsNothing);
    await t.tap(find.text('Retry'));
    await t.pump();
    expect(retries, 1);
  });
  test('existing overnight overlap policy remains unchanged', () {
    final e = ScheduleCalendarEntry(
      id: 'night',
      start: DateTime(2026, 10, 14, 21),
      end: DateTime(2026, 10, 15, 5),
      builder: (_) => const SizedBox(),
    );
    expect(scheduleEntriesOn([e], DateTime(2026, 10, 14)), hasLength(1));
    expect(scheduleEntriesOn([e], DateTime(2026, 10, 15)), hasLength(1));
  });
}

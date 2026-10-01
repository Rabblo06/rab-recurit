import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/calendar/calendar_presentation.dart';
import 'package:rab_staff/features/calendar/calendar_view.dart';
import 'package:rab_staff/navigation/moving_tab_bar.dart';

CalendarItem item(
  String id, {
  int day = 30,
  CalendarStatus status = CalendarStatus.confirmed,
  bool long = false,
  String? serverState,
  DateTime? start,
  DateTime? end,
}) => CalendarItem(
  status: status,
  color: const Color(0xFFDCEAFB),
  offer: OfferSummary(
    id: id,
    presentation: serverState == null
        ? null
        : StaffShiftPresentation.fromJson({
            'state': serverState,
            'homeLabel': serverState,
            'isToday': true,
            'serverNow': '2026-09-30T12:00:00Z',
          }),
    status: status == CalendarStatus.open ? 'pending' : 'manager_confirmed',
    sentAt: DateTime(2026, 9),
    expiresAt: DateTime(2026, 10),
    estimatedPayPence: 11250,
    shiftId: id,
    startsAt: start ?? DateTime(2026, 9, day, 16),
    endsAt: end ?? DateTime(2026, 9, day, 23, 30),
    venueName: long
        ? 'A very long hospitality venue name for responsive testing'
        : 'Example venue',
    roleName: long ? 'Senior hospitality and events coordinator' : 'Bartender',
    staffProfileId: 'fixture',
    staffName: 'Fixture',
    payRatePence: 1500,
    venueAddress: long
        ? 'A very long venue address with multiple street names, London'
        : '23 Example Road',
  ),
);

void main() {
  setUpAll(() async {
    final fonts =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    for (final e in {
      'Roboto': 'roboto-regular.ttf',
      'MaterialIcons': 'materialicons-regular.otf',
    }.entries) {
      await (FontLoader(e.key)..addFont(
            File('$fonts/${e.value}').readAsBytes().then(ByteData.sublistView),
          ))
          .load();
    }
  });
  Future<void> mount(
    WidgetTester t, {
    List<CalendarItem>? items,
    Size size = const Size(393, 852),
    double scale = 1,
    bool reduced = false,
    bool showMonth = true,
    bool loading = false,
    String? error,
    VoidCallback? profile,
    ValueChanged<CalendarItem>? open,
    Future<void> Function()? refresh,
  }) async {
    t.view.physicalSize = size;
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(
      MaterialApp(
        theme: buildLightTheme(),
        home: MediaQuery(
          data: MediaQueryData(
            size: size,
            textScaler: TextScaler.linear(scale),
            disableAnimations: reduced,
          ),
          child: RepaintBoundary(
            key: const ValueKey('capture'),
            child: Scaffold(
              backgroundColor: CalendarTokens.background,
              body: StaffCalendarView(
                items: items ?? [item('one')],
                now: DateTime(2026, 9, 30),
                onOpen: open ?? (_) {},
                onProfile: profile ?? () {},
                onRefresh: refresh ?? () async {},
                loading: loading,
                error: error,
              ),
              bottomNavigationBar: MovingTabBar(index: 1, onSelected: (_) {}),
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    if (showMonth) {
      await t.tap(find.text('Month'));
      await t.pumpAndSettle();
    }
  }

  Future<void> capture(WidgetTester t, String name) async {
    final boundary = t.renderObject<RenderRepaintBoundary>(
      find.byKey(const ValueKey('capture')),
    );
    final image = (await t.runAsync(() => boundary.toImage(pixelRatio: 1)))!;
    final bytes = await t.runAsync(
      () => image.toByteData(format: ui.ImageByteFormat.png),
    );
    await t.runAsync(() async {
      final dir = Directory('build/calendar-qa');
      await dir.create(recursive: true);
      await File(
        '${dir.path}/$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
    });
    image.dispose();
  }

  test('overnight overlap, midnight boundary, sorting and actual hours', () {
    final overnight = item(
      'night',
      start: DateTime(2026, 9, 30, 22),
      end: DateTime(2026, 10, 1, 6),
    );
    expect(overnight.occursOn(DateTime(2026, 9, 30)), true);
    expect(overnight.occursOn(DateTime(2026, 10, 1)), true);
    expect(overnight.occursOn(DateTime(2026, 10, 2)), false);
    final midnight = item('midnight', end: DateTime(2026, 10, 1));
    expect(midnight.occursOn(DateTime(2026, 10, 1)), false);
    expect(calendarSummary([overnight]), '1 shift \u00b7 8 hours');
    expect(
      calendarItemsOn([
        overnight,
        item('early'),
      ], DateTime(2026, 9, 30)).first.offer.id,
      'early',
    );
    expect(
      calendarIncludes(item('open', status: CalendarStatus.open).offer),
      true,
    );
    expect(calendarStatus(item('confirmed').offer), CalendarStatus.confirmed);
  });
  test('server lifecycle projection wins over raw status and attendance', () {
    for (final status in [
      CalendarStatus.live,
      CalendarStatus.clockedOut,
      CalendarStatus.complete,
      CalendarStatus.ended,
      CalendarStatus.expired,
      CalendarStatus.cancelled,
      CalendarStatus.declined,
      CalendarStatus.rejected,
    ]) {
      expect(
        calendarStatus(
          item('projection', serverState: status.name).offer,
          active: true,
        ),
        status,
      );
    }
  });
  testWidgets('grid alignment, selection, dots, modes, months and callbacks', (
    t,
  ) async {
    var profiles = 0;
    CalendarItem? opened;
    await mount(
      t,
      items: [
        item('one'),
        item('two', status: CalendarStatus.open),
        item('other', day: 9),
      ],
      profile: () => profiles++,
      open: (i) => opened = i,
    );
    Finder date(int d) => find.byKey(
      ValueKey('calendar-day-2026-09-${d.toString().padLeft(2, '0')}'),
    );
    expect(t.getCenter(date(2)).dx, t.getCenter(date(9)).dx);
    expect(t.getCenter(date(2)).dy, t.getCenter(date(3)).dy);
    expect(
      find.byKey(const ValueKey('event-dot-30-confirmed')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('event-dot-30-open')), findsOneWidget);
    expect(find.text('2 shifts \u00b7 15 hours'), findsOneWidget);
    await capture(t, 'mixed-393x852');
    await t.ensureVisible(find.byKey(const ValueKey('calendar-shift-one')));
    await t.tap(find.byKey(const ValueKey('calendar-shift-one')));
    expect(opened?.offer.id, 'one');
    await t.drag(find.byType(ListView), const Offset(0, 800));
    await t.pumpAndSettle();
    await t.tap(date(29));
    await t.pumpAndSettle();
    expect(find.text('No shifts scheduled'), findsOneWidget);
    await capture(t, 'empty-today-unselected-393x852');
    await t.tap(find.text('Today'));
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('month-calendar-card')), findsNothing);
    expect(find.byKey(const ValueKey('calendar-week-strip')), findsOneWidget);
    await capture(t, 'today-393x852');
    await t.tap(find.text('Month'));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Next month'));
    await t.pumpAndSettle();
    expect(find.text('October 2026'), findsNWidgets(2));
    await capture(t, 'next-month-393x852');
    await t.tap(find.byTooltip('Previous month'));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Previous month'));
    await t.pumpAndSettle();
    expect(find.text('August 2026'), findsNWidgets(2));
    await capture(t, 'previous-month-393x852');
    await t.tap(find.byTooltip('Profile').first);
    expect(profiles, 1);
    expect(t.takeException(), isNull);
  });
  for (final size in [
    const Size(320, 640),
    const Size(364, 661),
    const Size(393, 852),
    const Size(430, 932),
  ]) {
    testWidgets('render compact Calendar at $size', (t) async {
      await mount(t, size: size);
      expect(t.takeException(), isNull);
      await capture(t, 'single-${size.width.toInt()}x${size.height.toInt()}');
      expect(
        t.getSize(find.byKey(const ValueKey('month-calendar-card'))).height,
        lessThan(340),
      );
    });
  }
  testWidgets('long content and large text scroll without overflow', (t) async {
    await mount(
      t,
      size: const Size(320, 640),
      scale: 2,
      items: [item('long', long: true)],
    );
    expect(t.takeException(), isNull);
    await capture(t, 'large-text-top-320x640');
    await t.scrollUntilVisible(find.byType(CalendarShiftCard), 200);
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    await capture(t, 'large-text-long-320x640');
  });
  testWidgets('reduced motion settles immediately', (t) async {
    await mount(t, reduced: true);
    await t.tap(find.text('Today'));
    await t.pump();
    expect(
      t.widget<AnimatedAlign>(find.byType(AnimatedAlign).first).duration,
      Duration.zero,
    );
    expect(
      t.widget<AnimatedSwitcher>(find.byType(AnimatedSwitcher).first).duration,
      Duration.zero,
    );
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
  });
  for (final empty in [true, false]) {
    testWidgets('Today with ${empty ? 'zero' : 'one'} shifts', (t) async {
      await mount(t, showMonth: false, items: empty ? [] : [item('one')]);
      expect(find.byKey(const ValueKey('calendar-week-strip')), findsOneWidget);
      await t.tap(find.text('Today'));
      await t.pumpAndSettle();
      expect(
        find.byType(CalendarShiftCard),
        empty ? findsNothing : findsOneWidget,
      );
      await capture(t, 'today-${empty ? 'empty' : 'single'}-393x852');
      expect(t.takeException(), isNull);
    });
  }
  testWidgets('loading and error retry', (t) async {
    await mount(t, loading: true);
    expect(find.bySemanticsLabel('Loading schedule'), findsOneWidget);
    await capture(t, 'loading-393x852');
    await t.pumpWidget(const SizedBox());
    var retries = 0;
    await mount(
      t,
      error: 'test',
      refresh: () async {
        retries++;
      },
    );
    await capture(t, 'error-393x852');
    await t.ensureVisible(find.text('Retry'));
    await t.tap(find.text('Retry'));
    expect(retries, 1);
  });
}

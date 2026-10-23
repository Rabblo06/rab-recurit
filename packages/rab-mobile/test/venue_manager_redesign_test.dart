import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/shift_pastel_card.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/venue_manager/confirmed_staff.dart';
import 'package:rab_staff/features/venue_manager/shift_report.dart';
import 'package:rab_staff/features/venue_manager/shift_staff_screens.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';

import 'support/biometric_test_support.dart';
import 'venue_manager_test.dart' show VenueFixture;

/// Venue Manager redesign (owner reference: Users, Sent shift, Confirmed
/// staff, Event Details). Every value on screen comes from the fixture's
/// server-shaped responses through the real provider.
///
/// Screenshots: `flutter test test/venue_manager_redesign_test.dart
/// --dart-define=VM_REDESIGN_CAPTURE_DIR=DIR` writes the five reference
/// screens as PNGs; normal runs write nothing.
const _captureDir = String.fromEnvironment('VM_REDESIGN_CAPTURE_DIR');

String _iso(DateTime d) => d.toUtc().toIso8601String();

/// One server-shaped `ShiftReportStaffRow`.
Map<String, dynamic> seat(
  String id,
  String name, {
  String assignment = 'confirmed',
  String? attendanceId,
  String? status,
  DateTime? inAt,
  DateTime? outAt,
  bool reviewed = false,
}) => {
  'staffProfileId': id,
  'staffName': name,
  'roleName': 'Bartender',
  'assignmentStatus': assignment,
  'attendanceId': attendanceId,
  'attendanceStatus': status,
  'clockInAt': inAt == null ? null : _iso(inAt),
  'clockOutAt': outAt == null ? null : _iso(outAt),
  'breakMinutes': null,
  'scheduledBreakMinutes': 0,
  'workedMinutes': null,
  'earnedPence': null,
  'attendanceReviewed': reviewed,
};

void main() {
  final boundary = GlobalKey();
  setUp(
    () => stubSecureStorageChannel({
      'rab.accessToken': 'test',
      'rab.refreshToken': 'test',
    }),
  );
  tearDown(clearSecureStorageChannel);
  setUpAll(() async {
    final fonts =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    for (final entry in {
      'Roboto': 'roboto-regular.ttf',
      'MaterialIcons': 'materialicons-regular.otf',
    }.entries) {
      final loader = FontLoader(entry.key)
        ..addFont(
          File(
            '$fonts/${entry.value}',
          ).readAsBytes().then((b) => ByteData.sublistView(b)),
        );
      await loader.load();
    }
  });

  Future<void> capture(WidgetTester tester, String name) async {
    expect(tester.takeException(), isNull);
    if (_captureDir.isEmpty) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(_captureDir).create(recursive: true);
      await File(
        '$_captureDir/$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<VenueManagerProvider> mount(
    WidgetTester tester,
    VenueFixture f, {
    Widget Function(VenueManagerProvider p)? page,
    Size size = const Size(393, 852),
    double scale = 1,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final auth = AuthProvider(
      apiClient: f.api,
      biometricAuthenticator: FakeBiometricAuthenticator(),
    );
    final p = VenueManagerProvider(f.api, 'user-1');
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: auth),
          ChangeNotifierProvider.value(value: p),
          ChangeNotifierProvider(create: (_) => NotificationsProvider(f.api)),
        ],
        child: MaterialApp(
          theme: buildLightTheme().copyWith(
            textTheme: buildLightTheme().textTheme.apply(fontFamily: 'Roboto'),
            primaryTextTheme: buildLightTheme().primaryTextTheme.apply(
              fontFamily: 'Roboto',
            ),
          ),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              padding: const EdgeInsets.only(top: 24, bottom: 24),
            ),
            child: RepaintBoundary(key: boundary, child: child),
          ),
          home: const VenueManagerShell(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    if (page != null) {
      Navigator.of(
        tester.element(find.byType(VenueManagerHome)),
      ).push(MaterialPageRoute<void>(builder: (_) => page(p)));
      await tester.pumpAndSettle();
    }
    addTearDown(() {
      auth.dispose();
      p.dispose();
    });
    return p;
  }

  /// A report for shift-0 whose seats are Sam (clocked in) and Jordan (no
  /// attendance yet) — the two `manager_confirmed` offers in the fixture.
  VenueFixture rosterFixture({List<Map<String, dynamic>>? seats}) {
    final f = VenueFixture()..sendAllowed = true;
    final start = DateTime.parse(f.shifts.first['startsAt'] as String);
    f.reportOverride = (path) => {
      'shiftId': path.split('/')[4],
      'venueName': 'The Riverside Hotel',
      'roleName': 'Bartender',
      'startsAt': f.shifts.first['startsAt'],
      'endsAt': f.shifts.first['endsAt'],
      'reportStatus': 'draft',
      'staff':
          seats ??
          [
            seat(
              'staff-1',
              'Sam Green',
              attendanceId: 'att-1',
              status: 'clocked_in',
              inAt: start,
            ),
            seat('staff-2', 'Jordan Lee'),
          ],
    };
    return f;
  }

  /// Drags [list] repeatedly: one gesture only reaches the extent known
  /// when it starts, and lazily built rows extend it.
  Future<void> toEnd(WidgetTester tester, Finder list) async {
    for (var i = 0; i < 8; i++) {
      await tester.drag(list, const Offset(0, -1500));
      await tester.pumpAndSettle();
    }
  }

  Widget eventPage(VenueManagerProvider p) =>
      VenueEventDetail(event: p.events.first, style: p.style(p.events.first));

  group('attendance line mapping (real report data only)', () {
    final inAt = DateTime(2026, 10, 20, 20, 45);
    final outAt = DateTime(2026, 10, 20, 23, 50);
    String hm(DateTime d) => DateFormat('HH:mm').format(d);
    ShiftReportStaffRow row(Map<String, dynamic> j) =>
        ShiftReportStaffRow.fromJson(j);

    test('each state maps to its own line', () {
      expect(attendanceLine(null), isNull);
      expect(attendanceLine(row(seat('a', 'A'))), 'Attendance not recorded');
      expect(
        attendanceLine(
          row(
            seat('a', 'A', attendanceId: 'x', status: 'clocked_in', inAt: inAt),
          ),
        ),
        'Clocked in ${hm(inAt)}',
      );
      expect(
        attendanceLine(
          row(
            seat('a', 'A', attendanceId: 'x', status: 'on_break', inAt: inAt),
          ),
        ),
        'On break · clocked in ${hm(inAt)}',
      );
      expect(
        attendanceLine(
          row(
            seat(
              'a',
              'A',
              attendanceId: 'x',
              status: 'clocked_out',
              inAt: inAt,
              outAt: outAt,
            ),
          ),
        ),
        'Clocked out ${hm(outAt)} · Awaiting review',
      );
      expect(
        attendanceLine(
          row(
            seat(
              'a',
              'A',
              attendanceId: 'x',
              status: 'clocked_out',
              inAt: inAt,
              outAt: outAt,
              reviewed: true,
            ),
          ),
        ),
        'Reviewed · ${hm(inAt)}–${hm(outAt)}',
      );
      expect(
        attendanceLine(
          row(
            seat(
              'a',
              'A',
              attendanceId: 'x',
              status: 'missing_clock_out',
              inAt: inAt,
            ),
          ),
        ),
        'Clocked in ${hm(inAt)} · Clock-out missing',
      );
      expect(
        attendanceLine(row(seat('a', 'A', assignment: 'no_show'))),
        'Attendance missing · Needs review',
      );
    });

    test('never "not recorded" when an attendance record exists', () {
      for (final status in [
        'clocked_in',
        'on_break',
        'clocked_out',
        'under_review',
        'approved',
        'missing_clock_out',
        'absent',
        'disputed',
      ]) {
        final line = attendanceLine(
          row(seat('a', 'A', attendanceId: 'att', status: status)),
        );
        expect(line, isNot('Attendance not recorded'), reason: status);
      }
    });

    test('offers fallback lists only this shift, confirmed, once each', () {
      final f = VenueFixture();
      final offers = [
        ...f.offers,
        // A re-sent confirmed offer for Sam, and another shift's offer.
        {...f.offers[1], 'id': 'offer-again'},
        {...f.offers[2], 'id': 'offer-other', 'shiftId': 'shift-1'},
      ].map(OfferSummary.fromJson).toList();
      final roster = ShiftRoster.fromOffers('shift-0', offers);
      expect(roster.members.map((m) => m.name), ['Jordan Lee', 'Sam Green']);
      expect(roster.members.every((m) => m.row == null), isTrue);
      expect(roster.hasAttendance, isFalse);
      expect(ShiftRoster.fromOffers('shift-9', offers).members, isEmpty);
    });
  });

  group('Users', () {
    testWidgets('header, Edit, real member count, chips filter and recount', (
      tester,
    ) async {
      final f = VenueFixture()
        ..sendAllowed = true
        ..favourites.add('staff-0')
        ..emergencies.add('staff-2');
      await mount(tester, f, page: (_) => const VenueUsersScreen());
      expect(find.text('Users'), findsOneWidget);
      expect(find.byKey(const ValueKey('vm-users-select')), findsOneWidget);
      expect(find.text('Edit'), findsOneWidget);
      expect(find.text('Staff'), findsOneWidget);
      // The server's total, not a client guess.
      expect(find.text('3 members'), findsOneWidget);
      final alice = find.byKey(const ValueKey('vm-users-row-staff-0'));
      expect(
        find.descendant(of: alice, matching: find.byIcon(Icons.favorite)),
        findsOneWidget,
      );
      final jordan = find.byKey(const ValueKey('vm-users-row-staff-2'));
      expect(
        find.descendant(
          of: jordan,
          matching: find.byIcon(Icons.warning_amber_rounded),
        ),
        findsOneWidget,
      );
      await capture(tester, '01-users');
      await tester.tap(find.byKey(const ValueKey('vm-users-chip-favourite')));
      await tester.pumpAndSettle();
      expect(f.directoryQueries.last['tag'], 'favourite');
      expect(find.text('1 member'), findsOneWidget);
      expect(find.byKey(const ValueKey('vm-users-row-staff-1')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('vm-users-chip-emergency')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('vm-users-row-staff-2')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('vm-users-row-staff-0')), findsNothing);
    });

    testWidgets('no Edit without permission; no "Available" when unknown', (
      tester,
    ) async {
      final f = VenueFixture();
      await mount(
        tester,
        f,
        page: (_) => const VenueSelectStaffScreen(initialSelection: {}),
      );
      // Picker without a shift window: availability was not evaluated.
      expect(f.directoryQueries.last.containsKey('startAt'), isFalse);
      expect(find.text('Available'), findsNothing);
      expect(find.text('Not Available'), findsNothing);
      await tester.pageBack();
      await tester.pumpAndSettle();
      Navigator.of(
        tester.element(find.byType(VenueManagerHome)),
      ).push(MaterialPageRoute<void>(builder: (_) => const VenueUsersScreen()));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-users-select')), findsNothing);
    });

    testWidgets('search with no results says so', (tester) async {
      final f = VenueFixture();
      await mount(tester, f, page: (_) => const VenueUsersScreen());
      await tester.enterText(
        find.byKey(const ValueKey('vm-users-search')),
        'Nobody',
      );
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();
      expect(find.text('No staff match your search.'), findsOneWidget);
      expect(find.text('0 members'), findsOneWidget);
    });
  });

  group('Sent shift', () {
    testWidgets('one request: real status, recipients, confirmed seats', (
      tester,
    ) async {
      final f = rosterFixture();
      await mount(
        tester,
        f,
        page: (_) => const VenueSentShiftDetail(shiftId: 'shift-0'),
      );
      expect(f.paths, contains('/shifts/sent/shift-0'));
      expect(f.reportRequests.toSet(), {'shift-0'});
      expect(find.text('Sent shift'), findsOneWidget);
      // sentShiftLook: one accepted, not all confirmed → "Accepted".
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('sent-shift-status')),
          matching: find.text('Accepted'),
        ),
        findsOneWidget,
      );
      expect(find.text('The Riverside Hotel'), findsOneWidget);
      // Card footer + summary line, both from offerCounts.sent.
      expect(find.text('Sent to 3 staff'), findsNWidgets(2));
      expect(find.text('Sent 2h ago'), findsOneWidget);
      // Two seats out of the 20 required.
      expect(find.text('2 of 20'), findsOneWidget);
      for (final id in ['staff-1', 'staff-2']) {
        final row = find.byKey(ValueKey('sent-confirmed-row-$id'));
        expect(row, findsOneWidget);
        expect(
          find.descendant(of: row, matching: find.text('Confirmed')),
          findsOneWidget,
        );
      }
      // Alice accepted but is not confirmed: listed apart, never "Confirmed".
      expect(find.text('Other responses'), findsOneWidget);
      expect(find.text('Accepted'), findsNWidgets(2));
      await capture(tester, '02-sent-shift');
    });

    testWidgets('a request that is gone shows a clear message', (tester) async {
      final f = rosterFixture();
      await mount(
        tester,
        f,
        page: (_) => const VenueSentShiftDetail(shiftId: 'missing'),
      );
      expect(find.text('This shift is no longer available.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('no confirmed staff yet is an explicit empty state', (
      tester,
    ) async {
      final f = rosterFixture(seats: const []);
      await mount(
        tester,
        f,
        page: (_) => const VenueSentShiftDetail(shiftId: 'shift-0'),
      );
      expect(find.text('0 of 20'), findsOneWidget);
      expect(find.text('No confirmed staff yet.'), findsOneWidget);
    });
  });

  group('Event Details', () {
    testWidgets('real staffing, compact empty note, links keep the shift', (
      tester,
    ) async {
      final f = rosterFixture()..notes = '';
      await mount(tester, f, page: eventPage);
      expect(find.text('Event Details'), findsOneWidget);
      // partially_filled: its own label, never "Fully filled".
      expect(find.text('Partially filled'), findsOneWidget);
      expect(find.text('Fully filled'), findsNothing);
      expect(find.text('No details provided'), findsOneWidget);
      expect(
        tester.getSize(find.byKey(const ValueKey('event-note-panel'))).height,
        lessThan(90),
      );
      final staffing = find.byKey(const ValueKey('event-staffing-card'));
      Finder inCard(String t) =>
          find.descendant(of: staffing, matching: find.text(t));
      expect(inCard('20'), findsOneWidget); // required
      expect(inCard('3'), findsOneWidget); // filled (server filledCount)
      expect(inCard('1'), findsOneWidget); // one clocked in (report)
      expect(inCard('0'), findsOneWidget); // nobody clocked out yet (report)
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('event-confirmed-count')),
          matching: find.text('2'),
        ),
        findsOneWidget,
      );
      await capture(tester, '04-event-details-top');
      await toEnd(tester, find.byKey(const ValueKey('event-detail-list')));
      await capture(tester, '05-event-details-scrolled');

      // Owner decision: no Sent shift link and no Confirmed staff page.
      expect(find.byKey(const ValueKey('event-open-sent-shift')), findsNothing);
      expect(find.text('Sent shift'), findsNothing);
    });

    testWidgets('"Fully filled" only when the shift is fully filled', (
      tester,
    ) async {
      final f = rosterFixture()..firstShiftStatus = 'fully_filled';
      await mount(tester, f, page: eventPage);
      final pill = find.byKey(const ValueKey('event-status-pill'));
      expect(
        find.descendant(of: pill, matching: find.text('Fully filled')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: pill, matching: find.byIcon(Icons.check)),
        findsOneWidget,
      );
    });

    testWidgets('clock counts are "—" without report access, never 0', (
      tester,
    ) async {
      final f = rosterFixture()..reportView = false;
      await mount(tester, f, page: eventPage);
      final staffing = find.byKey(const ValueKey('event-staffing-card'));
      expect(
        find.descendant(of: staffing, matching: find.text('—')),
        findsNWidgets(2),
      );
      expect(
        find.descendant(of: staffing, matching: find.text('0')),
        findsNothing,
      );
    });

    testWidgets('a roster failure keeps the event and offers Retry', (
      tester,
    ) async {
      final f = rosterFixture();
      // A well-formed report, but for another shift: refused, not shown.
      final good = f.reportOverride!;
      f.reportOverride = (path) => {...good(path), 'shiftId': 'shift-3'};
      await mount(tester, f, page: eventPage);
      expect(find.text('Bartender'), findsWidgets);
      await tester.drag(
        find.byKey(const ValueKey('event-detail-list')),
        const Offset(0, -2000),
      );
      await tester.pumpAndSettle();
      expect(find.text('Confirmed staff unavailable'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      // Never another shift's staff under this header.
      expect(
        find.byKey(const ValueKey('event-staff-row-staff-1')),
        findsNothing,
      );
    });
  });

  group('320dp at 2x text', () {
    final seats = [
      for (var i = 0; i < 5; i++)
        seat('staff-$i', 'Staff Member Number $i With Long Name'),
    ];
    for (final (name, page)
        in <(String, Widget Function(VenueManagerProvider))>[
          ('users', (_) => const VenueUsersScreen()),
          ('sent', (_) => const VenueSentShiftDetail(shiftId: 'shift-0')),
          ('event', eventPage),
        ]) {
      testWidgets('$name has no overflow', (tester) async {
        final f = rosterFixture(seats: seats)
          ..notes = 'A long note. ' * 30
          ..favourites.add('staff-0')
          ..emergencies.add('staff-0');
        await mount(
          tester,
          f,
          page: page,
          size: const Size(320, 640),
          scale: 2,
        );
        await capture(tester, '320-2x-$name-top');
        final list = find.byType(Scrollable).last;
        await toEnd(tester, list);
        await capture(tester, '320-2x-$name-end');
      });
    }

    testWidgets('Event Details scrolls to the last row, fully visible', (
      tester,
    ) async {
      final f = rosterFixture(seats: seats);
      await mount(
        tester,
        f,
        page: eventPage,
        size: const Size(320, 640),
        scale: 2,
      );
      await toEnd(tester, find.byKey(const ValueKey('event-detail-list')));
      final last = find.byKey(const ValueKey('event-staff-row-staff-4'));
      expect(last, findsOneWidget);
      // Above the 24dp system inset at the bottom of the 640dp screen.
      expect(tester.getRect(last).bottom, lessThanOrEqualTo(640 - 24));
      expect(tester.getRect(last).top, greaterThan(0));
      expect(tester.takeException(), isNull);
    });
  });

  group('Confirmed events (My Space)', () {
    testWidgets('upcoming shifts with confirmed staff, real counts', (
      tester,
    ) async {
      final f = VenueFixture();
      await mount(tester, f, page: (_) => const VenueConfirmedEventsScreen());
      expect(find.text('Confirmed events'), findsOneWidget);
      expect(find.byType(ShiftPastelCard), findsWidgets);
      expect(find.text('Partially filled'), findsWidgets);
      expect(find.text('3 / 20 staff confirmed · 17 open'), findsOneWidget);
      expect(find.textContaining('Attendance'), findsNothing);
    });

    testWidgets('ended events are not listed', (tester) async {
      final f = VenueFixture()..historical = true;
      await mount(tester, f, page: (_) => const VenueConfirmedEventsScreen());
      expect(find.text('No confirmed events'), findsOneWidget);
      expect(find.byType(ShiftPastelCard), findsNothing);
    });
  });
}

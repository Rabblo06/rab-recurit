import 'support/location_stream_stub.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/schedule_clock_screen.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offers/schedule_offer_detail_screen.dart';
import 'support/biometric_test_support.dart';

/// A location fix that satisfies `Position`'s required fields without
/// touching a real location platform — used by `mount()`'s default
/// `locationResolver` override so every test drives the real Clock In/Out
/// code path (location resolved → QR scanned → API call) without a camera
/// or GPS.
Position _fakePosition() => Position(
  latitude: 51.5080,
  longitude: -0.1281,
  timestamp: clockTestNow(),
  accuracy: 5,
  altitude: 0,
  altitudeAccuracy: 0,
  heading: 0,
  headingAccuracy: 0,
  speed: 0,
  speedAccuracy: 0,
);

DateTime clockTestNow() {
  final today = DateTime.now();
  return DateTime(today.year, today.month, today.day, 12);
}

class _TestAttendance extends AttendanceProvider {
  _TestAttendance(super.api);
  @override
  DateTime? get trustedNow => serverNow;
}

class ClockFixture {
  ClockFixture() {
    final now = clockTestNow();
    offer = {
      'id': 'offer-clock',
      'shiftId': 'shift-clock',
      'status': 'manager_confirmed',
      'sentAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(days: 1)).toIso8601String(),
      'startsAt': now.subtract(const Duration(hours: 1)).toIso8601String(),
      'endsAt': now.add(const Duration(hours: 6)).toIso8601String(),
      'venueName': 'Example Hotel',
      'venueAddress': '12 Example Street, Bristol, BS1 2AB',
      'roleName': 'Bartender',
      'staffName': 'Alice Example',
      'staffProfileId': 'staff-clock',
      'payRatePence': 1242,
      'estimatedPayPence': 8694,
      'shiftNotes': 'Use the staff entrance.\nPlease bring your staff ID.',
    };
  }
  late Map<String, dynamic> offer;
  Map<String, dynamic>? active;
  List<Map<String, dynamic>> history = [];
  bool empty = false, failIn = false, failOut = false, failRestore = false;
  bool delayHistory = false;
  bool failHistory = false, hideWorkedMinutes = false;
  bool failTeam = false;
  List<Map<String, dynamic>> team = [];
  int teamReads = 0, activeReads = 0;
  Completer<void>? gate;
  int ins = 0, outs = 0;
  String? postedShift;
  Map<String, dynamic> attendance() => {
    ...offer,
    'id': 'attendance-clock',
    'status': 'clocked_in',
    'clockInAt': clockTestNow()
        .subtract(const Duration(hours: 1, minutes: 42))
        .toIso8601String(),
  };
  late final api = ApiClient(
    httpClient: MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/offers/mine')) {
        return http.Response(jsonEncode(empty ? [] : [offer]), 200);
      }
      if (path.endsWith('/attendance/me/active')) {
        activeReads++;
        return failRestore
            ? http.Response('{"message":"Offline"}', 503)
            : http.Response(
                jsonEncode({
                  'attendance': active,
                  'serverNow': clockTestNow().toIso8601String(),
                  'clockInEarlyMinutes': 15,
                }),
                200,
              );
      }
      if (path.endsWith('/team')) {
        teamReads++;
        return failTeam
            ? http.Response('{"message":"Unavailable"}', 503)
            : http.Response(jsonEncode(team), 200);
      }
      if (path.endsWith('/attendance/me/history')) {
        if (failHistory) {
          return http.Response('{"message":"History delayed"}', 503);
        }
        return http.Response(
          jsonEncode(
            delayHistory
                ? []
                : history
                      .map(
                        (row) => {
                          ...row,
                          if (hideWorkedMinutes) 'workedMinutes': null,
                        },
                      )
                      .toList(),
          ),
          200,
        );
      }
      if (path.endsWith('/attendance/clock-in')) {
        ins++;
        postedShift = (jsonDecode(request.body) as Map)['shiftId'] as String;
        await gate?.future;
        if (failIn) {
          return http.Response('{"message":"Clock-in rejected"}', 409);
        }
        active = attendance();
        return http.Response(jsonEncode(active), 200);
      }
      if (path.endsWith('/attendance/clock-out')) {
        outs++;
        await gate?.future;
        if (failOut) {
          return http.Response('{"message":"Clock-out rejected"}', 409);
        }
        history = [
          {
            ...active!,
            'status': 'clocked_out',
            'workedMinutes': 102,
            'clockOutAt': clockTestNow().toIso8601String(),
          },
        ];
        active = null;
        return http.Response(
          jsonEncode({
            ...history.single,
            if (failHistory || hideWorkedMinutes) 'workedMinutes': null,
          }),
          200,
        );
      }
      return http.Response('[]', 200);
    }),
  );
}

void main() {
  setUp(stubLocationStream);
  tearDown(clearLocationStream);
  final boundary = GlobalKey();
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
  tearDown(clearSecureStorageChannel);
  Future<void> mount(
    WidgetTester tester,
    ClockFixture f, {
    Size size = const Size(393, 852),
    double scale = 1,
    bool detail = false,
    bool selectedClock = false,
    bool reduced = false,
    bool teams = false,
    ShiftVisualStyle style = ShiftVisualStyle.peach,
  }) async {
    stubSecureStorageChannel({
      'rab.accessToken': 'test-access',
      'rab.refreshToken': 'test-refresh',
    });
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => OffersProvider(f.api)),
          ChangeNotifierProvider<AttendanceProvider>(
            create: (_) => _TestAttendance(f.api),
          ),
        ],
        child: MaterialApp(
          theme: buildLightTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              disableAnimations: reduced,
              padding: const EdgeInsets.only(top: 24, bottom: 24),
              viewPadding: const EdgeInsets.only(top: 24, bottom: 24),
            ),
            child: RepaintBoundary(key: boundary, child: child),
          ),
          home: detail
              ? ScheduleOfferDetailScreen(
                  offer: OfferSummary.fromJson(f.offer),
                  visualStyle: style,
                )
              : ScheduleClockScreen(
                  teams: teams,
                  visualStyle: style,
                  offer: selectedClock || teams
                      ? OfferSummary.fromJson(f.offer)
                      : null,
                  // Widget tests drive the real clock-in/out code path
                  // (location resolved → QR scanned → API called) without a
                  // real camera/GPS platform — see the test-only seams on
                  // ScheduleClockScreen.
                  locationResolver: (_) async => _fakePosition(),
                  qrScanner: (_) async => 'fake-qr-token',
                ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> shot(WidgetTester tester, String name) async {
    expect(tester.takeException(), isNull);
    if (const {
      'completed',
      'completion-pending',
      'clock-in',
      'live',
      'confirmation-sheet',
    }.contains(name)) {
      await expectLater(
        find.byKey(boundary),
        matchesGoldenFile('goldens/clock-$name.png'),
      );
    }
    if (!const bool.fromEnvironment('CLOCK_VISUAL_CAPTURE')) return;
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    await tester.runAsync(() async {
      final image = await render.toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File(
        '.qa-screenshots/clock-$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  final primary = find.byKey(const ValueKey('clock-primary'));
  final expand = find.byKey(const ValueKey('clock-expand'));

  testWidgets(
    'clock-in failure, retry, correct shift ID and double-tap guard',
    (tester) async {
      final f = ClockFixture()..failIn = true;
      await mount(tester, f);
      await shot(tester, 'clock-in');
      await tester.tap(primary);
      await tester.pumpAndSettle();
      expect(find.text('Clock-in rejected'), findsOneWidget);
      expect(find.text('LIVE SHIFT'), findsNothing);
      f.failIn = false;
      f.gate = Completer<void>();
      await tester.tap(primary);
      await tester.tap(primary);
      await tester.pump();
      expect(
        f.ins,
        2,
      ); // One failed request and one pending retry, no duplicate.
      f.gate!.complete();
      await tester.pumpAndSettle();
      expect(f.postedShift, 'shift-clock');
      expect(find.text('LIVE SHIFT'), findsOneWidget);
      expect(find.textContaining('01:42:', findRichText: true), findsOneWidget);
      expect(find.text('Clock out'), findsNWidgets(2));
      await shot(tester, 'live');
    },
  );

  testWidgets(
    'clock-out failure preserves live attendance; success stays completed',
    (tester) async {
      final f = ClockFixture();
      f.active = f.attendance();
      f.failOut = true;
      await mount(tester, f);
      await tester.tap(primary);
      await tester.tap(primary, warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.text('End your shift?'), findsOneWidget);
      await shot(tester, 'confirmation-sheet');
      await tester.tap(find.byKey(const ValueKey('confirm-clock-out')));
      await tester.tap(
        find.byKey(const ValueKey('confirm-clock-out')),
        warnIfMissed: false,
      );
      await tester.pumpAndSettle();
      expect(f.outs, 1);
      expect(find.text('Clock-out rejected'), findsOneWidget);
      expect(find.text('LIVE SHIFT'), findsOneWidget);
      f.failOut = false;
      await tester.tap(primary);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('confirm-clock-out')));
      await tester.pumpAndSettle();
      expect(f.outs, 2);
      expect(find.text('COMPLETED'), findsOneWidget);
      expect(find.text('01:42:00', findRichText: true), findsOneWidget);
      expect(primary, findsNothing);
      await shot(tester, 'completed');
    },
  );

  for (final delayedState in [
    'missing record',
    'missing metrics',
    'history error',
  ]) {
    testWidgets(
      'completion waits for authoritative worked time and retries: $delayedState',
      (tester) async {
        final f = ClockFixture()
          ..delayHistory = delayedState == 'missing record'
          ..hideWorkedMinutes = delayedState == 'missing metrics';
        f.active = f.attendance();
        await mount(tester, f);
        f.failHistory = delayedState == 'history error';
        await tester.tap(primary);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('confirm-clock-out')));
        await tester.pumpAndSettle();
        expect(find.text('Shift completed'), findsOneWidget);
        expect(find.text('Updating worked time…'), findsOneWidget);
        expect(find.text('View shift summary'), findsOneWidget);
        expect(find.byType(ClockShiftTimer), findsNothing);
        await shot(tester, 'completion-pending');
        expect(f.outs, 1);
        f.delayHistory = false;
        f.hideWorkedMinutes = false;
        f.failHistory = false;
        f.history.single['workedMinutes'] = 87;
        await tester.ensureVisible(find.text('Refresh worked time'));
        await tester.tap(find.text('Refresh worked time'));
        await tester.pumpAndSettle();
        expect(find.text('Updating worked time…'), findsNothing);
        expect(find.text('01:27:00', findRichText: true), findsOneWidget);
        expect(f.outs, 1);
      },
    );
  }

  testWidgets(
    'restored completion, ended shift and absent notes do not offer clock-in',
    (tester) async {
      final f = ClockFixture();
      f.offer['shiftNotes'] = null;
      f.history = [
        {
          ...f.attendance(),
          'status': 'clocked_out',
          'workedMinutes': 102,
          'clockOutAt': clockTestNow().toIso8601String(),
        },
      ];
      await mount(tester, f);
      expect(primary, findsNothing);
      expect(find.text('COMPLETED'), findsOneWidget);
      await tester.tap(expand);
      await tester.pumpAndSettle();
      expect(find.text('No shift notes provided.'), findsOneWidget);
      f.history = [];
      f.offer['startsAt'] = clockTestNow()
          .subtract(const Duration(hours: 2))
          .toIso8601String();
      f.offer['endsAt'] = clockTestNow()
          .subtract(const Duration(minutes: 1))
          .toIso8601String();
      await tester.pumpWidget(const SizedBox());
      // Open this record explicitly: before 02:00 its start is yesterday,
      // so the home screen correctly no longer selects it as today's shift.
      await mount(tester, f, selectedClock: true);
      expect(find.text('Shift ended'), findsOneWidget);
      expect(primary, findsNothing);
    },
  );

  testWidgets(
    'populated large text sheet can be dragged and keeps the action reachable',
    (tester) async {
      final f = ClockFixture();
      f.offer['venueName'] =
          'The Metropolitan Conference and Exhibition Centre';
      f.offer['roleName'] = 'Senior hospitality and conference supervisor';
      f.offer['payRatePence'] = 123456;
      await mount(
        tester,
        f,
        size: const Size(320, 640),
        scale: 2,
        reduced: true,
      );
      await shot(tester, 'accessible-populated');
      final handle = find.bySemanticsLabel('Expand shift information');
      await tester.drag(handle, const Offset(0, -100));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Collapse details'), findsOneWidget);
      expect(primary.hitTestable(), findsOneWidget);
      await shot(tester, 'accessible-expanded');
    },
  );

  for (final style in ShiftVisualStyle.values) {
    testWidgets('detail clock route preserves ${style.name} and returns', (
      tester,
    ) async {
      final f = ClockFixture();
      await mount(tester, f, style: style, detail: true);
      await tester.tap(find.text('Clock In'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<ScheduleClockScreen>(find.byType(ScheduleClockScreen))
            .visualStyle,
        style,
      );
      expect(find.text('CLOCK-IN OVERDUE'), findsOneWidget);
      await shot(tester, '${style.name}-collapsed');
      final collapsed = tester
          .getSize(find.byKey(const ValueKey('clock-shift-sheet')))
          .height;
      await tester.tap(expand);
      await tester.pumpAndSettle();
      expect(
        tester.getSize(find.byKey(const ValueKey('clock-shift-sheet'))).height,
        greaterThan(collapsed),
      );
      expect(find.text('£12.42/h'), findsOneWidget);
      expect(find.text('Teams'), findsOneWidget);
      expect(find.text('NOTE'), findsOneWidget);
      expect(find.text('Chat'), findsNothing);
      await shot(tester, '${style.name}-expanded');
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleOfferDetailScreen), findsOneWidget);
      expect(find.byType(ScheduleClockScreen), findsNothing);
    });
  }

  for (final size in [
    const Size(360, 640),
    const Size(393, 852),
    const Size(432, 960),
    const Size(375, 667),
    const Size(390, 844),
    const Size(430, 932),
    const Size(844, 390),
  ]) {
    testWidgets('clock sheet fits $size and scrolls long instructions', (
      tester,
    ) async {
      final f = ClockFixture();
      f.offer['shiftNotes'] = List.filled(
        25,
        'Use the staff entrance and bring your identification.',
      ).join('\n');
      await mount(tester, f, size: size);
      expect(find.byKey(const ValueKey('clock-timer')), findsOneWidget);
      await shot(tester, '${size.width.toInt()}-collapsed');
      await tester.tap(expand);
      await tester.pumpAndSettle();
      await tester.drag(
        find.byKey(const ValueKey('clock-sheet-scroll')),
        const Offset(0, -250),
      );
      await tester.pumpAndSettle();
      expect(primary.hitTestable(), findsOneWidget);
      await shot(tester, '${size.width.toInt()}-expanded-scroll');
    });
  }

  testWidgets(
    'enlarged text, reduced motion, empty, future, ended and restore error',
    (tester) async {
      final f = ClockFixture()..empty = true;
      await mount(
        tester,
        f,
        size: const Size(320, 640),
        scale: 2,
        reduced: true,
      );
      expect(primary, findsNothing);
      await tester.tap(expand);
      await tester.pumpAndSettle();
      await shot(tester, 'accessible-empty');
      f.empty = false;
      f.offer['startsAt'] = clockTestNow()
          .add(const Duration(days: 1))
          .toIso8601String();
      f.offer['endsAt'] = clockTestNow()
          .add(const Duration(days: 1, hours: 7))
          .toIso8601String();
      await tester.pumpWidget(const SizedBox());
      await mount(tester, f, selectedClock: true);
      expect(find.text('Shift confirmed'), findsOneWidget);
      expect(primary, findsNothing);
      f.failRestore = true;
      await tester.pumpWidget(const SizedBox());
      await mount(tester, f);
      expect(find.text('Retry'), findsOneWidget);
      expect(primary, findsNothing);
    },
  );

  testWidgets(
    'Teams navigation, real response rows, error retry and empty state',
    (tester) async {
      final f = ClockFixture();
      f.team = [
        {
          'displayName': 'Test coworker',
          'startsAt': f.offer['startsAt'],
          'endsAt': f.offer['endsAt'],
          'isYou': false,
        },
      ];
      await mount(tester, f);
      await tester.tap(expand);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Teams'));
      await tester.pumpAndSettle();
      expect(f.teamReads, greaterThanOrEqualTo(2));
      expect(find.text('Test coworker'), findsOneWidget);
      await shot(tester, 'teams-overdue');
      f.failTeam = true;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('Team unavailable'), findsOneWidget);
      expect(find.text('Test coworker'), findsNothing);
      await shot(tester, 'teams-error');
      f.failTeam = false;
      f.team = [];
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.text('No confirmed teammates yet'), findsOneWidget);
      await shot(tester, 'teams-empty');
    },
  );

  testWidgets('countdown and mint Teams state use server time', (tester) async {
    final f = ClockFixture();
    f.team = List.generate(
      35,
      (index) => {
        'displayName': 'Test teammate ${index + 1}',
        'startsAt': f.offer['startsAt'],
        'endsAt': f.offer['endsAt'],
        'isYou': index == 0,
      },
    );
    f.offer['startsAt'] = clockTestNow()
        .add(const Duration(hours: 2))
        .toIso8601String();
    await mount(tester, f, teams: true);
    expect(find.text('Your shift starts in'), findsOneWidget);
    expect(find.text('02'), findsOneWidget);
    expect(find.text('HOURS'), findsOneWidget);
    expect(find.text('MINUTES'), findsOneWidget);
    expect(find.text('SECONDS'), findsOneWidget);
    expect(find.text('35 people'), findsOneWidget);
    expect(find.text('You'), findsOneWidget);
    await shot(tester, 'teams-before');
    expect(primary.hitTestable(), findsOneWidget);
    // Stopwatch interpolation is covered by provider tests; the display never
    // uses a device DateTime fallback when server time is unavailable.
    final provider = tester
        .element(find.byType(ScheduleClockScreen))
        .read<AttendanceProvider>();
    provider.serverNow = null;
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('\u2014'), findsOneWidget);
  });

  testWidgets('clock out confirmation cancellation makes no request', (
    tester,
  ) async {
    final f = ClockFixture();
    f.active = f.attendance();
    await mount(tester, f);
    await tester.tap(primary);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep working'));
    await tester.pumpAndSettle();
    expect(f.outs, 0);
    expect(find.text('Clocked In'), findsOneWidget);
  });

  testWidgets('too early opens explanation without scanning or posting', (
    tester,
  ) async {
    final f = ClockFixture();
    f.offer['startsAt'] = clockTestNow()
        .add(const Duration(minutes: 28))
        .toIso8601String();
    await mount(tester, f);
    await shot(tester, 'confirmed-before-window');
    await tester.tap(primary);
    await tester.pumpAndSettle();
    expect(find.text('Your shift hasn’t started yet!'), findsOneWidget);
    expect(find.textContaining('in 13 minutes'), findsOneWidget);
    await shot(tester, 'early-arrival');
    expect(f.ins, 0);
    final provider = tester
        .element(find.byType(ScheduleClockScreen))
        .read<AttendanceProvider>();
    provider.serverNow = clockTestNow().add(const Duration(minutes: 13));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('You can clock in now'), findsOneWidget);
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    expect(primary.hitTestable(), findsOneWidget);
    expect(f.ins, 0);
  });

  testWidgets('resume reconciles authoritative attendance', (tester) async {
    final f = ClockFixture();
    await mount(tester, f);
    final initial = f.activeReads;
    f.active = f.attendance();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(f.activeReads, greaterThan(initial));
    expect(find.text('Clocked In'), findsOneWidget);
  });

  testWidgets(
    'countdown crosses start without negative time or attendance success',
    (tester) async {
      final f = ClockFixture();
      final starts = clockTestNow().add(const Duration(minutes: 1));
      f.offer['startsAt'] = starts.toIso8601String();
      await mount(tester, f);
      expect(find.text('Start in 1m'), findsOneWidget);
      final provider = tester
          .element(find.byType(ScheduleClockScreen))
          .read<AttendanceProvider>();
      provider.serverNow = starts.add(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Clock-in overdue'), findsOneWidget);
      expect(find.text('00:00:05', findRichText: true), findsOneWidget);
      expect(find.text('Clocked In'), findsNothing);
      expect(f.ins, 0);
    },
  );

  testWidgets(
    'overnight shift and UK autumn DST use absolute server instants',
    (tester) async {
      final f = ClockFixture();
      f.offer['startsAt'] = '2030-10-26T22:00:00Z';
      f.offer['endsAt'] = '2030-10-27T07:00:00Z';
      f.active = {...f.attendance(), 'clockInAt': '2030-10-27T00:30:00Z'};
      await mount(tester, f, selectedClock: true);
      final provider = tester
          .element(find.byType(ScheduleClockScreen))
          .read<AttendanceProvider>();
      provider.serverNow = DateTime.parse('2030-10-27T02:30:00Z');
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('02:00:00', findRichText: true), findsOneWidget);
      expect(primary.hitTestable(), findsOneWidget);
      expect(find.text('Clocked Out'), findsNothing);
    },
  );

  testWidgets('reference geometry at 320 by 690', (tester) async {
    final f = ClockFixture();
    f.offer['venueName'] = 'The Riverside Hotel';
    f.offer['venueAddress'] = '12 High Street, Bristol, BS1 2AB';
    f.offer['startsAt'] = clockTestNow()
        .add(const Duration(hours: 2, minutes: 34, seconds: 34))
        .toIso8601String();
    f.offer['shiftNotes'] =
        'Dress code:\n- Black shirt or polo shirt\n- Black trousers\n- Plain black, closed-toe shoes\n- Wear staff ID/lanyard\n- Hair must be neat and tied back if necessary\n- No jeans, trainers, or large visible logos\n\nPlease arrive 15 minutes before the shift starts.';
    f.team = ['Issac Nepolean', 'Lusy', 'Alex', 'Jeniffer', 'Love']
        .map(
          (name) => <String, dynamic>{
            'displayName': name,
            'startsAt': f.offer['startsAt'],
            'endsAt': f.offer['endsAt'],
            'isYou': false,
          },
        )
        .toList();
    await mount(tester, f, size: const Size(320, 690));
    final rateRight = tester.getBottomRight(find.text('£12.42/h')).dx;
    final cardRight = tester
        .getBottomRight(find.byKey(const ValueKey('clock-shift-sheet')))
        .dx;
    // Card padding 18 + 1px identity border.
    expect(rateRight, closeTo(cardRight - 19, 1));
    expect(find.text('Clock in'), findsNWidgets(2));
    await shot(tester, 'reference-collapsed');
    await tester.tap(expand);
    await tester.pumpAndSettle();
    await shot(tester, 'reference-expanded');
    await tester.tap(find.text('Teams'));
    await tester.pumpAndSettle();
    await shot(tester, 'reference-teams');
  });

  testWidgets('cancelled shift never offers attendance and keeps navigation', (
    tester,
  ) async {
    final f = ClockFixture();
    f.offer['status'] = 'withdrawn';
    await mount(tester, f, selectedClock: true);
    expect(find.text('Shift cancelled'), findsOneWidget);
    expect(primary, findsNothing);
    await shot(tester, 'cancelled');
  });
}

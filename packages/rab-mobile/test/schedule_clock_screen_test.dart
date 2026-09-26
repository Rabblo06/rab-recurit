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
  timestamp: DateTime.now(),
  accuracy: 5,
  altitude: 0,
  altitudeAccuracy: 0,
  heading: 0,
  headingAccuracy: 0,
  speed: 0,
  speedAccuracy: 0,
);

class ClockFixture {
  ClockFixture() {
    final now = DateTime.now();
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
  Completer<void>? gate;
  int ins = 0, outs = 0;
  String? postedShift;
  Map<String, dynamic> attendance() => {
    ...offer,
    'id': 'attendance-clock',
    'status': 'clocked_in',
    'clockInAt': DateTime.now()
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
        return failRestore
            ? http.Response('{"message":"Offline"}', 503)
            : http.Response(
                jsonEncode({
                  'attendance': active,
                  'serverNow': DateTime.now().toIso8601String(),
                }),
                200,
              );
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
            'clockOutAt': DateTime.now().toIso8601String(),
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
    ShiftVisualStyle style = ShiftVisualStyle.yellow,
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
          ChangeNotifierProvider(create: (_) => AttendanceProvider(f.api)),
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
                  visualStyle: style,
                  offer: selectedClock ? OfferSummary.fromJson(f.offer) : null,
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
      expect(find.text('01:42'), findsOneWidget);
      expect(find.text('Clock out'), findsOneWidget);
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
      expect(find.text('01:42'), findsOneWidget);
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
        expect(find.text('Back to shifts'), findsOneWidget);
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
        expect(find.text('01:27'), findsOneWidget);
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
          'clockOutAt': DateTime.now().toIso8601String(),
        },
      ];
      await mount(tester, f);
      expect(primary, findsNothing);
      expect(find.text('COMPLETED'), findsOneWidget);
      await tester.tap(expand);
      await tester.pumpAndSettle();
      expect(find.text('NOTE'), findsNothing);
      f.history = [];
      f.offer['startsAt'] = DateTime.now()
          .subtract(const Duration(hours: 2))
          .toIso8601String();
      f.offer['endsAt'] = DateTime.now()
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
      expect(find.text('7H'), findsOneWidget);
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
      expect(find.text('AE'), findsOneWidget);
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
      expect(
        tester.getSize(find.byKey(const ValueKey('clock-timer-ring'))).width,
        196,
      );
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
      f.offer['startsAt'] = DateTime.now()
          .add(const Duration(days: 1))
          .toIso8601String();
      f.offer['endsAt'] = DateTime.now()
          .add(const Duration(days: 1, hours: 7))
          .toIso8601String();
      await tester.pumpWidget(const SizedBox());
      await mount(tester, f, selectedClock: true);
      expect(find.text('Be Ready'), findsOneWidget);
      expect(primary, findsNothing);
      f.failRestore = true;
      await tester.pumpWidget(const SizedBox());
      await mount(tester, f);
      expect(find.text('Retry'), findsOneWidget);
      expect(primary, findsNothing);
    },
  );
}

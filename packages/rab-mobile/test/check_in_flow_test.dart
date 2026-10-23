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
import 'package:rab_staff/core/services/location_service.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/shift_countdown_panel.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/schedule_clock_screen.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offers/schedule_offer_detail_screen.dart';

import 'support/biometric_test_support.dart';
import 'support/location_stream_stub.dart';

/// Staff Check In → Clock In → Clock Out (server contract by agent A). Every
/// state on screen comes from server-shaped responses through the real
/// providers; location and the QR scanner use the screen's test seams.
///
/// Screenshots: `--dart-define=CHECKIN_CAPTURE_DIR=DIR`.
const _captureDir = String.fromEnvironment('CHECKIN_CAPTURE_DIR');

DateTime _noon() {
  final today = DateTime.now();
  return DateTime(today.year, today.month, today.day, 12);
}

class _TestAttendance extends AttendanceProvider {
  _TestAttendance(super.api);
  @override
  DateTime? get trustedNow => serverNow;
}

class CheckInFixture {
  CheckInFixture({bool required = true, bool? geofence = false}) {
    final now = _noon();
    offer = {
      'id': 'offer-ci',
      'shiftId': 'shift-ci',
      'status': 'manager_confirmed',
      'sentAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(days: 1)).toIso8601String(),
      'startsAt': now.subtract(const Duration(minutes: 5)).toIso8601String(),
      'endsAt': now.add(const Duration(hours: 6)).toIso8601String(),
      'venueName': 'Example Hall',
      'roleName': 'Bartender',
      'staffName': 'Alex Example',
      'staffProfileId': 'staff-ci',
      'payRatePence': 1200,
      'estimatedPayPence': 7200,
      'checkInRequired': required,
      'checkedInAt': null,
      'checkInSource': null,
      'geofenceEnforced': ?geofence,
    };
  }

  late Map<String, dynamic> offer;
  Map<String, dynamic>? active;
  final checkInBodies = <Map<String, dynamic>>[];
  final clockInBodies = <Map<String, dynamic>>[];
  int checkInReads = 0;
  DateTime? checkedInAt;
  bool alreadyChecked = false;

  /// Error code the next check-in POST answers with (409), if any.
  String? checkInError;

  /// Error code the next clock-in POST answers with (409), if any.
  String? clockInError;

  Map<String, dynamic> state({bool already = false}) {
    final start = DateTime.parse(offer['startsAt'] as String);
    return {
      'shiftId': 'shift-ci',
      'checkInRequired': offer['checkInRequired'],
      'checkedInAt': checkedInAt?.toUtc().toIso8601String(),
      'checkInSource': checkedInAt == null ? null : 'staff',
      'locationVerified': offer['geofenceEnforced'] == true,
      'distanceM': null,
      'accuracyM': null,
      'geofenceEnforced': offer['geofenceEnforced'] ?? false,
      'window': {
        'opensAt': start
            .subtract(const Duration(minutes: 15))
            .toUtc()
            .toIso8601String(),
        'closesAt': DateTime.parse(
          offer['endsAt'] as String,
        ).add(const Duration(minutes: 30)).toUtc().toIso8601String(),
      },
      'clockedIn': active != null,
      'alreadyCheckedIn': already,
      'serverNow': _noon().toUtc().toIso8601String(),
    };
  }

  late final api = ApiClient(
    httpClient: MockClient((request) async {
      final path = request.url.path.replaceFirst('/rest/v1', '');
      if (path == '/offers/mine') {
        return http.Response(
          jsonEncode([
            {
              ...offer,
              'checkedInAt': checkedInAt?.toUtc().toIso8601String(),
            },
          ]),
          200,
        );
      }
      if (path == '/attendance/me/active') {
        return http.Response(
          jsonEncode({
            'attendance': active,
            'serverNow': _noon().toIso8601String(),
            'clockInEarlyMinutes': 15,
            'locationEvidence': {
              'maxAccuracyM': 100,
              'maxAgeSeconds': 120,
              'maxFutureSkewSeconds': 30,
            },
          }),
          200,
        );
      }
      if (path == '/attendance/me/history') {
        return http.Response('[]', 200);
      }
      if (path == '/attendance/me/shift/shift-ci/check-in') {
        checkInReads++;
        return http.Response(jsonEncode(state(already: checkedInAt != null)), 200);
      }
      if (path == '/attendance/check-in') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        checkInBodies.add(body);
        final code = checkInError;
        if (code != null) {
          checkInError = null;
          return http.Response(
            jsonEncode({
              'statusCode': 409,
              'code': code,
              'message': 'Server text for $code',
            }),
            409,
          );
        }
        final already = checkedInAt != null || alreadyChecked;
        checkedInAt ??= _noon().subtract(const Duration(minutes: 2));
        return http.Response(jsonEncode(state(already: already)), 200);
      }
      if (path == '/attendance/clock-in') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        clockInBodies.add(body);
        final code = clockInError;
        if (code != null) {
          clockInError = null;
          return http.Response(
            jsonEncode({'statusCode': 409, 'code': code, 'message': 'x'}),
            409,
          );
        }
        active = {
          ...offer,
          'id': 'attendance-ci',
          'status': 'clocked_in',
          'clockInAt': _noon().toIso8601String(),
          'checkInRequired': offer['checkInRequired'],
          'checkedInAt': checkedInAt?.toUtc().toIso8601String(),
        };
        return http.Response(jsonEncode(active), 200);
      }
      if (path.endsWith('/team')) return http.Response('[]', 200);
      return http.Response('[]', 200);
    }),
  );
}

Position _position({double accuracy = 8, DateTime? at}) => Position(
  latitude: 51.5080,
  longitude: -0.1281,
  timestamp: at ?? DateTime.now(),
  accuracy: accuracy,
  altitude: 0,
  altitudeAccuracy: 0,
  heading: 0,
  headingAccuracy: 0,
  speed: 0,
  speedAccuracy: 0,
);

void main() {
  final boundary = GlobalKey();
  setUp(stubLocationStream);
  tearDown(clearLocationStream);
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

  var locationCalls = 0;
  var scans = 0;
  Position Function() nextPosition = _position;

  Future<void> mount(
    WidgetTester tester,
    CheckInFixture f, {
    bool teams = false,
    bool detail = false,
    Size size = const Size(393, 852),
    double scale = 1,
  }) async {
    locationCalls = 0;
    scans = 0;
    stubSecureStorageChannel({
      'rab.accessToken': 'test-access',
      'rab.refreshToken': 'test-refresh',
    });
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final offer = OfferSummary.fromJson(f.offer);
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
              padding: const EdgeInsets.only(top: 24, bottom: 24),
              viewPadding: const EdgeInsets.only(top: 24, bottom: 24),
            ),
            child: RepaintBoundary(key: boundary, child: child),
          ),
          home: detail
              ? ScheduleOfferDetailScreen(offer: offer)
              : ScheduleClockScreen(
                  offer: teams ? offer : null,
                  teams: teams,
                  locationResolver: (_) async {
                    locationCalls++;
                    return nextPosition();
                  },
                  qrScanner: (_) async {
                    scans++;
                    return 'shift-qr-token';
                  },
                ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

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

  final checkIn = find.byKey(const ValueKey('clock-check-in'));
  final clockIn = find.byKey(const ValueKey('clock-primary'));

  testWidgets(
    'Check In comes first; Clock in is locked until the server confirms it; '
    'geofence off sends no location',
    (tester) async {
      final f = CheckInFixture(geofence: false);
      await mount(tester, f);
      expect(checkIn, findsOneWidget);
      expect(find.text('Check In'), findsOneWidget);
      expect(
        find.text(
          'Confirm your arrival at the venue before starting your shift.',
        ),
        findsOneWidget,
      );
      expect(clockIn, findsNothing, reason: 'Clock in hidden before check-in');
      await capture(tester, 'staff-check-in-required');

      await tester.tap(checkIn);
      await tester.pumpAndSettle();
      expect(f.checkInBodies, hasLength(1));
      expect(f.checkInBodies.single, {'shiftId': 'shift-ci'});
      expect(locationCalls, 0, reason: 'no GPS where the geofence is off');
      expect(scans, 0, reason: 'Check In does not scan the QR');

      final at = f.checkedInAt!.toLocal();
      final hm =
          '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
      expect(find.text('Checked in · $hm'), findsOneWidget);
      expect(checkIn, findsNothing);
      expect(clockIn, findsOneWidget);
      expect(find.text('Clock in'), findsWidgets);
      await capture(tester, 'staff-checked-in');

      await tester.tap(clockIn);
      await tester.pumpAndSettle();
      expect(scans, 1);
      expect(locationCalls, 0);
      expect(f.clockInBodies.single, {
        'shiftId': 'shift-ci',
        'qrToken': 'shift-qr-token',
      });
    },
  );

  testWidgets('geofence on: the fix is sent with an offset capturedAt', (
    tester,
  ) async {
    final f = CheckInFixture(geofence: true);
    await mount(tester, f);
    await tester.tap(checkIn);
    await tester.pumpAndSettle();
    expect(locationCalls, 1);
    final body = f.checkInBodies.single;
    expect(body['shiftId'], 'shift-ci');
    expect(body['lat'], 51.5080);
    expect(body['lng'], -0.1281);
    expect(body['accuracyM'], 8);
    final captured = body['capturedAt'] as String;
    expect(captured, endsWith('Z'));
    // Placed on the server's timeline (fixture serverNow = 12:00).
    expect(
      DateTime.parse(captured).difference(_noon()).inSeconds.abs(),
      lessThan(5),
    );
    // Clock In then takes a fresh fix too.
    await tester.tap(clockIn);
    await tester.pumpAndSettle();
    expect(locationCalls, 2);
    expect(f.clockInBodies.single.keys, containsAll(['lat', 'capturedAt']));
  });

  for (final (code, message) in [
    ('OUTSIDE_GEOFENCE', "You're outside the venue's permitted check-in area."),
    (
      'LOCATION_STALE',
      'Your location reading is out of date. Refresh your location and try again.',
    ),
  ]) {
    testWidgets('$code is explained and Check In stays available', (
      tester,
    ) async {
      final f = CheckInFixture(geofence: true)..checkInError = code;
      await mount(tester, f);
      await tester.tap(checkIn);
      await tester.pumpAndSettle();
      expect(find.text(message), findsOneWidget);
      expect(find.textContaining('Server text'), findsNothing);
      expect(checkIn, findsOneWidget);
      expect(clockIn, findsNothing);
      await capture(tester, 'staff-${code.toLowerCase()}');
    });
  }

  testWidgets('a fix worse than the server limit is refused without a request', (
    tester,
  ) async {
    final f = CheckInFixture(geofence: true);
    nextPosition = () => _position(accuracy: 450);
    addTearDown(() => nextPosition = _position);
    await mount(tester, f);
    await tester.tap(checkIn);
    await tester.pumpAndSettle();
    expect(f.checkInBodies, isEmpty);
    expect(
      find.textContaining("couldn't confirm your location accurately"),
      findsOneWidget,
    );
  });

  testWidgets('idempotent repeat shows the original check-in time', (
    tester,
  ) async {
    final f = CheckInFixture()
      ..alreadyChecked = true
      ..checkedInAt = null;
    await mount(tester, f);
    // Another device already checked in at 11:51 (server time).
    f.checkedInAt = _noon().subtract(const Duration(minutes: 9));
    await tester.tap(checkIn);
    await tester.pumpAndSettle();
    final at = f.checkedInAt!.toLocal();
    expect(
      find.text(
        'Checked in · ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}',
      ),
      findsOneWidget,
    );
    expect(clockIn, findsOneWidget);
  });

  testWidgets('a restored check-in from the server unlocks Clock in at once', (
    tester,
  ) async {
    final f = CheckInFixture()
      ..checkedInAt = _noon().subtract(const Duration(minutes: 3));
    await mount(tester, f);
    expect(f.checkInReads, greaterThanOrEqualTo(1));
    expect(checkIn, findsNothing);
    expect(clockIn, findsOneWidget);
    expect(find.byKey(const ValueKey('checked-in-badge')), findsOneWidget);
  });

  testWidgets('old booking (checkInRequired false) keeps the old Clock in flow', (
    tester,
  ) async {
    final f = CheckInFixture(required: false, geofence: null);
    await mount(tester, f);
    expect(checkIn, findsNothing);
    expect(find.text('Check In'), findsNothing);
    expect(clockIn, findsOneWidget);
    expect(f.checkInReads, 0);
    await tester.tap(clockIn);
    await tester.pumpAndSettle();
    // Unknown geofence (older contract) keeps asking for location as before.
    expect(locationCalls, 1);
    expect(scans, 1);
    expect(f.checkInBodies, isEmpty);
    expect(f.clockInBodies, hasLength(1));
  });

  testWidgets('CHECK_IN_REQUIRED on a stale offer flips the screen to Check In', (
    tester,
  ) async {
    final f = CheckInFixture(required: false, geofence: false)
      ..clockInError = 'CHECK_IN_REQUIRED';
    await mount(tester, f);
    f.offer['checkInRequired'] = true;
    await tester.tap(clockIn);
    await tester.pumpAndSettle();
    expect(find.text('Check in at the venue before you clock in.'), findsOneWidget);
    expect(checkIn, findsOneWidget);
  });

  testWidgets('too early: the check-in sheet explains, nothing is sent', (
    tester,
  ) async {
    final f = CheckInFixture();
    f.offer['startsAt'] = _noon()
        .add(const Duration(minutes: 28))
        .toIso8601String();
    await mount(tester, f);
    await tester.tap(checkIn);
    await tester.pumpAndSettle();
    expect(find.text('Your shift hasn’t started yet!'), findsOneWidget);
    expect(find.textContaining('You can’t check in just yet'), findsOneWidget);
    expect(find.textContaining('in 13 minutes'), findsOneWidget);
    expect(f.checkInBodies, isEmpty);
    await capture(tester, 'staff-check-in-early');
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
  });

  testWidgets('Job Details offers Check In before Clock In', (tester) async {
    final f = CheckInFixture();
    await mount(tester, f, detail: true);
    expect(find.text('Check In'), findsOneWidget);
    expect(find.text('Clock In'), findsNothing);
    f.checkedInAt = _noon().subtract(const Duration(minutes: 1));
    final provider = tester
        .element(find.byType(ScheduleOfferDetailScreen))
        .read<AttendanceProvider>();
    await provider.loadCheckIn('shift-ci');
    await tester.pumpAndSettle();
    expect(find.text('Clock In'), findsOneWidget);
    expect(find.byKey(const ValueKey('detail-checked-in')), findsOneWidget);
  });

  group('Teams countdown labels', () {
    ShiftCountdownPanel panel(WidgetTester tester) =>
        tester.widget<ShiftCountdownPanel>(find.byType(ShiftCountdownPanel));

    testWidgets('before the start: red-tinted "Your shift starts in"', (
      tester,
    ) async {
      final f = CheckInFixture();
      f.offer['startsAt'] = _noon()
          .add(const Duration(minutes: 20, seconds: 3))
          .toIso8601String();
      await mount(tester, f, teams: true);
      expect(find.text('Your shift starts in'), findsOneWidget);
      expect(find.textContaining('started in'), findsNothing);
      expect(panel(tester).warning, isTrue);
      expect(find.text('20'), findsOneWidget);
      await capture(tester, 'staff-teams-before');
    });

    testWidgets('after the start, not clocked in: "Shift in progress"', (
      tester,
    ) async {
      final f = CheckInFixture();
      await mount(tester, f, teams: true);
      expect(find.text('Shift in progress'), findsOneWidget);
      expect(find.text('Your shift starts in'), findsNothing);
      expect(panel(tester).warning, isFalse);
      expect(find.text('05'), findsOneWidget);
    });

    testWidgets('clocked in: "Time on shift" from the server clock-in', (
      tester,
    ) async {
      final f = CheckInFixture()
        ..active = {
          'id': 'attendance-ci',
          'status': 'clocked_in',
          'clockInAt': _noon()
              .subtract(const Duration(minutes: 40))
              .toIso8601String(),
          'shiftId': 'shift-ci',
          'startsAt': _noon()
              .subtract(const Duration(minutes: 45))
              .toIso8601String(),
          'endsAt': _noon().add(const Duration(hours: 3)).toIso8601String(),
          'venueName': 'Example Hall',
          'roleName': 'Bartender',
          'staffProfileId': 'staff-ci',
          'staffName': 'Alex Example',
        };
      await mount(tester, f, teams: true);
      expect(find.text('Time on shift'), findsOneWidget);
      expect(find.text('40'), findsOneWidget);
      expect(panel(tester).warning, isFalse);
    });
  });

  testWidgets('320dp at 2x text: Check In and helper fit without overflow', (
    tester,
  ) async {
    final f = CheckInFixture();
    await mount(tester, f, size: const Size(320, 640), scale: 2);
    expect(tester.takeException(), isNull);
    expect(checkIn.hitTestable(), findsOneWidget);
    await tester.tap(checkIn);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(clockIn.hitTestable(), findsOneWidget);
  });

  test('LocationFix keeps the fix age on the server timeline', () {
    final device = DateTime.utc(2030, 1, 1, 10, 0, 0);
    final server = DateTime.utc(2030, 1, 1, 10, 4, 0); // device 4 min slow
    final fix = LocationFix.fromPosition(
      _position(at: device.subtract(const Duration(seconds: 7))),
      trustedNow: server,
      deviceNow: device,
    );
    expect(fix.capturedAt, server.subtract(const Duration(seconds: 7)));
    expect(fix.toJson()['capturedAt'], '2030-01-01T10:03:53.000Z');
    // A future-stamped fix is never placed after "now".
    final future = LocationFix.fromPosition(
      _position(at: device.add(const Duration(seconds: 30))),
      trustedNow: server,
      deviceNow: device,
    );
    expect(future.capturedAt, server);
  });
}

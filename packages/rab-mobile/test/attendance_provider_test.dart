import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';

import 'support/biometric_test_support.dart';

/// Real Clock In/Out state on the mobile side — no fake/optimistic UI (a
/// failed clock-in must never update `active`), and restoring from `GET
/// /attendance/me/active` must re-anchor to the backend's own `clockInAt`,
/// never reset to a fresh timer.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;
  setUp(() {
    secureStore = {};
    stubSecureStorageChannel(secureStore);
  });
  tearDown(clearSecureStorageChannel);

  Map<String, dynamic> attendanceJson({String status = 'active', String clockInAt = '2026-01-01T09:00:00.000Z'}) => {
        'id': 'att-1',
        'status': status,
        'clockInAt': clockInAt,
        'clockOutAt': status == 'completed' ? '2026-01-01T17:00:00.000Z' : null,
        'workedMinutes': status == 'completed' ? 480 : null,
        'earnedPence': status == 'completed' ? 6000 : null,
        'shiftId': 'shift-1',
        'startsAt': '2026-01-01T09:00:00.000Z',
        'endsAt': '2026-01-01T17:00:00.000Z',
        'venueName': 'Acme Venue',
        'roleName': 'Bartender',
        'staffProfileId': 'staff-1',
        'staffName': 'Alice Example',
      };

  test('restoring an active attendance re-anchors to the backend clockInAt, not a fresh timer', () async {
    final knownClockIn = '2025-06-01T08:00:00.000Z';
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/attendance/me/active')) {
        return http.Response(
          jsonEncode({'attendance': attendanceJson(clockInAt: knownClockIn), 'serverNow': DateTime.now().toIso8601String()}),
          200,
        );
      }
      return http.Response('not found', 404);
    });
    final provider = AttendanceProvider(ApiClient(httpClient: client));
    await provider.refreshActive();

    expect(provider.active, isNotNull);
    expect(provider.active!.clockInAt, DateTime.parse(knownClockIn));
  });

  test('no active attendance restores to null, not an error state', () async {
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/attendance/me/active')) {
        return http.Response(jsonEncode({'attendance': null, 'serverNow': DateTime.now().toIso8601String()}), 200);
      }
      return http.Response('not found', 404);
    });
    final provider = AttendanceProvider(ApiClient(httpClient: client));
    await provider.refreshActive();

    expect(provider.active, isNull);
    expect(provider.isLoadingActive, isFalse);
  });

  test('a successful clock-in updates active only after the backend confirms', () async {
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/attendance/me/active')) return http.Response(jsonEncode({'attendance': null, 'serverNow': DateTime.now().toIso8601String()}), 200);
      if (path.endsWith('/attendance/clock-in')) return http.Response(jsonEncode(attendanceJson()), 201);
      return http.Response('not found', 404);
    });
    final provider = AttendanceProvider(ApiClient(httpClient: client));
    await provider.refreshActive();
    expect(provider.active, isNull);

    final ok = await provider.clockIn('shift-1');

    expect(ok, isTrue);
    expect(provider.active, isNotNull);
    expect(provider.active!.status, 'active');
    expect(provider.errorMessage, isNull);
  });

  test('a failed clock-in leaves active unchanged — no optimistic UI', () async {
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/attendance/me/active')) return http.Response(jsonEncode({'attendance': null, 'serverNow': DateTime.now().toIso8601String()}), 200);
      if (path.endsWith('/attendance/clock-in')) {
        return http.Response(jsonEncode({'message': 'This shift is not confirmed for you.'}), 409);
      }
      return http.Response('not found', 404);
    });
    final provider = AttendanceProvider(ApiClient(httpClient: client));
    await provider.refreshActive();

    final ok = await provider.clockIn('shift-1');

    expect(ok, isFalse);
    expect(provider.active, isNull);
    expect(provider.errorMessage, 'This shift is not confirmed for you.');
  });

  test('clock-out clears active and refreshes history only after the backend confirms', () async {
    var clockOutCalled = false;
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/attendance/me/active')) {
        return http.Response(jsonEncode({'attendance': attendanceJson(), 'serverNow': DateTime.now().toIso8601String()}), 200);
      }
      if (path.endsWith('/attendance/clock-out')) {
        clockOutCalled = true;
        return http.Response(jsonEncode(attendanceJson(status: 'completed')), 201);
      }
      if (path.endsWith('/attendance/me/history')) {
        return http.Response(jsonEncode([attendanceJson(status: 'completed')]), 200);
      }
      return http.Response('not found', 404);
    });
    final provider = AttendanceProvider(ApiClient(httpClient: client));
    await provider.refreshActive();
    expect(provider.active, isNotNull);

    final ok = await provider.clockOut();

    expect(ok, isTrue);
    expect(clockOutCalled, isTrue);
    expect(provider.active, isNull);
    expect(provider.history, hasLength(1));
    expect(provider.history.first.status, 'completed');
  });

  test('a failed clock-out leaves active unchanged', () async {
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/attendance/me/active')) {
        return http.Response(jsonEncode({'attendance': attendanceJson(), 'serverNow': DateTime.now().toIso8601String()}), 200);
      }
      if (path.endsWith('/attendance/clock-out')) {
        return http.Response(jsonEncode({'message': 'This attendance was already clocked out.'}), 404);
      }
      return http.Response('not found', 404);
    });
    final provider = AttendanceProvider(ApiClient(httpClient: client));
    await provider.refreshActive();

    final ok = await provider.clockOut();

    expect(ok, isFalse);
    expect(provider.active, isNotNull);
    expect(provider.errorMessage, 'This attendance was already clocked out.');
  });
}

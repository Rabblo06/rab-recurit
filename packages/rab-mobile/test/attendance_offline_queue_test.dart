import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/offline_sync/offline_entry.dart';
import 'package:rab_staff/features/offline_sync/offline_messages.dart';
import 'package:rab_staff/features/offline_sync/offline_sync_client.dart';
import 'package:rab_staff/features/offline_sync/offline_sync_controller.dart';

import 'support/biometric_test_support.dart';
import 'support/offline_test_support.dart';

/// M4 offline queue, PR 2: Clock In / Clock Out / Check In save the punch on this phone only when offline mode is on
/// AND the request got no response (DESIGN §3.1, D17). With offline mode off (every real build today) the requests
/// and the error are exactly what they were before M4. A saved punch is never shown as confirmed (D10).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secure;
  setUp(() {
    secure = {
      'rab.accessToken': 'a',
      'rab.refreshToken': 'r',
      'rab.sessionUserId': 'user-a',
    };
    stubSecureStorageChannel(secure);
  });
  tearDown(clearSecureStorageChannel);

  Map<String, dynamic> attendanceJson() => {
    'id': 'att-1',
    'status': 'clocked_in',
    'clockInAt': '2026-11-21T09:00:00.000Z',
    'shiftId': 'shift-1',
    'startsAt': '2026-11-21T09:00:00.000Z',
    'endsAt': '2026-11-21T17:00:00.000Z',
    'venueName': 'Acme Venue',
    'roleName': 'Bartender',
    'staffProfileId': 'staff-1',
    'staffName': 'Alice Example',
  };

  /// A server that is reachable for `/attendance/me/active` and then drops the connection for punches, unless
  /// [punch] says otherwise.
  ({ApiClient api, List<http.Request> punches}) server({
    bool offlineEnabled = true,
    Map<String, dynamic>? active,
    Future<http.Response> Function(http.Request request)? punch,
  }) {
    final punches = <http.Request>[];
    final api = ApiClient(
      httpClient: MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/attendance/me/active')) {
          return http.Response(
            jsonEncode({
              'attendance': active,
              'serverNow': '2026-11-21T09:00:00.000Z',
              'offline': {'enabled': offlineEnabled},
              'offlineTicket': 'tkt',
            }),
            200,
          );
        }
        if (path.endsWith('/attendance/me/history')) {
          return http.Response('[]', 200);
        }
        punches.add(request);
        if (punch != null) return punch(request);
        throw http.ClientException('Connection refused');
      }),
    );
    return (api: api, punches: punches);
  }

  Future<(AttendanceProvider, OfflineSyncController)> mount(
    ApiClient api, {
    bool buildFlag = true,
  }) async {
    final offline = OfflineSyncController(
      userId: 'user-a',
      bootClock: FakeBootClock(),
      signer: FakeEntrySigner(),
      buildFlag: buildFlag,
    );
    final provider = AttendanceProvider(api, offline: offline);
    await provider.refreshActive();
    return (provider, offline);
  }

  group('offline mode off (today, everywhere)', () {
    test(
      'a dropped connection is an error; nothing saved; no Idempotency-Key sent',
      () async {
        final s = server();
        final (provider, offline) = await mount(s.api, buildFlag: false);
        final ok = await provider.clockIn('shift-1', qrToken: 'qr');
        expect(ok, isFalse);
        expect(provider.errorMessage, ApiMessages.offline);
        expect(provider.lastQueued, isNull);
        expect(offline.entries, isEmpty);
        expect(
          s.punches.single.headers.containsKey('Idempotency-Key'),
          isFalse,
        );
      },
    );

    test(
      'without a controller the provider behaves exactly as before',
      () async {
        final s = server();
        final provider = AttendanceProvider(s.api);
        await provider.refreshActive();
        expect(await provider.clockIn('shift-1', qrToken: 'qr'), isFalse);
        expect(provider.errorMessage, ApiMessages.offline);
        expect(
          s.punches.single.headers.containsKey('Idempotency-Key'),
          isFalse,
        );
      },
    );

    test(
      'the server not enabling offline keeps it off even in an offline-capable build',
      () async {
        final s = server(offlineEnabled: false);
        final (provider, offline) = await mount(s.api);
        await provider.clockIn('shift-1', qrToken: 'qr');
        expect(offline.entries, isEmpty);
        expect(provider.errorMessage, ApiMessages.offline);
      },
    );
  });

  group('offline mode on (tests only)', () {
    test(
      'online success: sent once with an Idempotency-Key, nothing saved',
      () async {
        final s = server(
          punch: (r) async => http.Response(jsonEncode(attendanceJson()), 201),
        );
        final (provider, offline) = await mount(s.api);
        expect(await provider.clockIn('shift-1', qrToken: 'qr'), isTrue);
        expect(s.punches.single.headers['Idempotency-Key'], isNotEmpty);
        expect(offline.entries, isEmpty);
        expect(provider.lastQueued, isNull);
      },
    );

    test(
      'no response: saved on this phone with the SAME key; never shown as clocked in',
      () async {
        final s = server();
        final (provider, offline) = await mount(s.api);
        final ok = await provider.clockIn('shift-1', qrToken: 'qr');
        expect(ok, isFalse, reason: 'only a server answer is a success');
        expect(provider.errorMessage, isNull);
        expect(
          provider.active,
          isNull,
          reason: 'no local attendance, no timer (D10)',
        );
        final saved = offline.entries.single;
        expect(provider.lastQueued?.idempotencyKey, saved.idempotencyKey);
        expect(saved.entry.type, OfflinePunchType.clockIn);
        expect(saved.entry.shiftId, 'shift-1');
        expect(saved.entry.qrToken, 'qr');
        expect(
          s.punches.single.headers['Idempotency-Key'],
          saved.idempotencyKey,
        );
      },
    );

    test(
      'this client giving up waiting (uncertain outcome) is saved with the same key the request carried',
      () async {
        final s = server(
          punch: (r) async => throw TimeoutException('no answer'),
        );
        final (provider, offline) = await mount(s.api);
        await provider.clockIn('shift-1', qrToken: 'qr');
        expect(
          offline.entries.single.idempotencyKey,
          s.punches.single.headers['Idempotency-Key'],
        );
      },
    );

    test(
      'security review L2: a server or proxy that ANSWERS 408 is a response: shown as an error, never saved',
      () async {
        final s = server(punch: (r) async => http.Response('', 408));
        final (provider, offline) = await mount(s.api);
        await provider.clockIn('shift-1', qrToken: 'qr');
        expect(offline.entries, isEmpty);
        expect(provider.errorMessage, isNotNull);
        expect(provider.lastQueued, isNull);
      },
    );

    test(
      'a 5xx or a refusal is a response: shown as an error, never saved',
      () async {
        for (final status in [409, 500, 503]) {
          final s = server(
            punch: (r) async => http.Response('{"message":"No"}', status),
          );
          final (provider, offline) = await mount(s.api);
          await provider.clockIn('shift-1', qrToken: 'qr');
          expect(offline.entries, isEmpty, reason: '$status');
          expect(provider.errorMessage, isNotNull);
        }
      },
    );

    test(
      'while punches are waiting, the next one is saved behind them without going online',
      () async {
        final s = server();
        final (provider, offline) = await mount(s.api);
        await provider.clockIn('shift-1', qrToken: 'qr');
        expect(s.punches, hasLength(1));
        expect(provider.clockOutShiftId, 'shift-1');
        final ok = await provider.clockOut(qrToken: 'qr-out');
        expect(ok, isFalse);
        expect(
          s.punches,
          hasLength(1),
          reason: 'kept in order behind the clock-in',
        );
        final out = offline.entries.last.entry;
        expect(out.type, OfflinePunchType.clockOut);
        expect(
          out.shiftId,
          'shift-1',
          reason: 'always the shift id, never "current"',
        );
        expect(
          out.clientSeq,
          greaterThan(offline.entries.first.entry.clientSeq),
        );
      },
    );

    test(
      'clock-out of an open server attendance: saved, the open attendance is left as it is',
      () async {
        final s = server(active: attendanceJson());
        final (provider, offline) = await mount(s.api);
        expect(provider.active, isNotNull);
        await provider.clockOut(qrToken: 'qr-out');
        expect(offline.entries.single.entry.type, OfflinePunchType.clockOut);
        expect(provider.active?.status, 'clocked_in');
      },
    );

    test(
      'an offline check-in counts as done for the Check In step, without inventing a server time',
      () async {
        final s = server();
        final (provider, offline) = await mount(s.api);
        final offer = OfferSummary.fromJson({
          'id': 'offer-1',
          'shiftId': 'shift-1',
          'status': 'manager_confirmed',
          'sentAt': '2026-11-20T09:00:00.000Z',
          'expiresAt': '2026-11-22T09:00:00.000Z',
          'startsAt': '2026-11-21T09:00:00.000Z',
          'endsAt': '2026-11-21T17:00:00.000Z',
          'venueName': 'Acme Venue',
          'roleName': 'Bartender',
          'staffName': 'Alice Example',
          'staffProfileId': 'staff-1',
          'checkInRequired': true,
          'estimatedPayPence': 8000,
          'payRatePence': 1000,
        });
        expect(provider.needsCheckIn(offer), isTrue);
        await provider.checkIn('shift-1');
        expect(offline.entries.single.entry.type, OfflinePunchType.checkIn);
        expect(provider.needsCheckIn(offer), isFalse);
        expect(provider.checkedInAt(offer), isNull);
      },
    );

    test('a refused capture shows why (ticket too old)', () async {
      final s = server();
      final boot = FakeBootClock();
      final offline = OfflineSyncController(
        userId: 'user-a',
        bootClock: boot,
        signer: FakeEntrySigner(),
        buildFlag: true,
      );
      final provider = AttendanceProvider(s.api, offline: offline);
      await provider.refreshActive();
      boot.reboot();
      await provider.clockIn('shift-1', qrToken: 'qr');
      expect(offline.entries, isEmpty);
      expect(provider.errorMessage, OfflineMessages.needsTicket);
    });
  });

  test(
    'once the server acknowledges a saved clock-in, the real attendance is re-read (server timer only then)',
    () async {
      var synced = false;
      final api = ApiClient(
        httpClient: MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/attendance/me/active')) {
            return http.Response(
              jsonEncode({
                'attendance': synced ? attendanceJson() : null,
                'serverNow': '2026-11-21T09:30:00.000Z',
                'offline': {'enabled': true},
                'offlineTicket': 'tkt',
              }),
              200,
            );
          }
          if (path.endsWith('/attendance/me/history')) {
            return http.Response('[]', 200);
          }
          if (path.endsWith('/attendance/me/sync')) {
            synced = true;
            final entries =
                ((jsonDecode(request.body) as Map)['entries'] as List)
                    .cast<Map<String, dynamic>>();
            return http.Response(
              jsonEncode({
                'results': [
                  for (final e in entries)
                    {
                      'idempotencyKey': e['idempotencyKey'],
                      'outcome': 'applied',
                    },
                ],
              }),
              200,
            );
          }
          throw http.ClientException('Connection refused');
        }),
      );
      final offline = OfflineSyncController(
        userId: 'user-a',
        bootClock: FakeBootClock(),
        signer: FakeEntrySigner(),
        buildFlag: true,
        client: OfflineSyncClient(api),
      );
      final provider = AttendanceProvider(api, offline: offline);
      await provider.refreshActive();
      await provider.clockIn('shift-1', qrToken: 'qr');
      expect(provider.active, isNull);
      expect(offline.hasUnsent, isTrue);
      await offline.syncNow(userInitiated: true);
      // onApplied re-reads /me/active; let it land.
      await provider.refreshActive(silent: true);
      expect(offline.entries, isEmpty);
      expect(
        provider.active?.clockInAt,
        DateTime.parse('2026-11-21T09:00:00.000Z'),
      );
    },
  );
  test('only Idempotency-Key may be added to a request (allowlist)', () async {
    final s = server();
    expect(
      () => s.api.post('/attendance/clock-in', headers: {'Authorization': 'x'}),
      throwsArgumentError,
    );
    expect(
      () => s.api.post(
        '/attendance/clock-in',
        headers: {'X-Client-Platform': 'web'},
      ),
      throwsArgumentError,
    );
    expect(s.punches, isEmpty);
  });

  group('security review L5: an online punch never overtakes saved ones', () {
    Future<(AttendanceProvider, OfflineSyncController, List<String>)>
    setUpSaved({required bool syncWorks}) async {
      var enabled = true;
      final posted = <String>[];
      final api = ApiClient(
        httpClient: MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/attendance/me/active')) {
            return http.Response(
              jsonEncode({
                'attendance': null,
                'serverNow': '2026-11-21T09:30:00.000Z',
                'offline': {'enabled': enabled},
                'offlineTicket': 'tkt',
              }),
              200,
            );
          }
          if (path.endsWith('/attendance/me/history')) {
            return http.Response('[]', 200);
          }
          posted.add(path);
          if (path.endsWith('/attendance/me/sync') && syncWorks) {
            final entries =
                ((jsonDecode(request.body) as Map)['entries'] as List)
                    .cast<Map<String, dynamic>>();
            return http.Response(
              jsonEncode({
                'results': [
                  for (final e in entries)
                    {
                      'idempotencyKey': e['idempotencyKey'],
                      'outcome': 'applied',
                    },
                ],
              }),
              200,
            );
          }
          if (path.endsWith('/attendance/clock-out')) {
            return http.Response(
              jsonEncode({
                ...attendanceJson(),
                'status': 'clocked_out',
                'clockOutAt': '2026-11-21T17:00:00.000Z',
              }),
              200,
            );
          }
          throw http.ClientException('Connection refused');
        }),
      );
      final offline = OfflineSyncController(
        userId: 'user-a',
        bootClock: FakeBootClock(),
        signer: FakeEntrySigner(),
        buildFlag: true,
        client: OfflineSyncClient(api),
      );
      final provider = AttendanceProvider(api, offline: offline);
      await provider.refreshActive();
      await provider.clockIn('shift-1', qrToken: 'qr');
      expect(offline.hasUnsent, isTrue);
      // The server then switches offline off: the next punch can no longer be saved behind the first.
      enabled = false;
      await provider.refreshActive();
      expect(offline.mayQueue, isFalse);
      posted.clear();
      return (provider, offline, posted);
    }

    test(
      'saved punches still unsent: the punch is refused, never sent online out of order',
      () async {
        final (provider, offline, posted) = await setUpSaved(syncWorks: false);
        final ok = await provider.clockOut(qrToken: 'qr-out');
        expect(ok, isFalse);
        expect(provider.errorMessage, OfflineMessages.sendSavedFirst);
        expect(
          posted.where((p) => p.endsWith('/attendance/clock-out')),
          isEmpty,
        );
        expect(
          posted.where((p) => p.endsWith('/attendance/me/sync')),
          isNotEmpty,
          reason: 'tried to send them first',
        );
      },
    );

    test(
      'once the saved punches are sent, the punch goes online as usual',
      () async {
        final (provider, offline, posted) = await setUpSaved(syncWorks: true);
        await provider.clockOut(qrToken: 'qr-out');
        expect(offline.hasUnsent, isFalse);
          expect(posted.last, endsWith('/attendance/clock-out'));
      },
    );
  });
}

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/schedule_clock_screen.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offline_sync/logout_guard.dart';
import 'package:rab_staff/features/offline_sync/offline_entry.dart';
import 'package:rab_staff/features/offline_sync/offline_messages.dart';
import 'package:rab_staff/features/offline_sync/offline_queue_store.dart';
import 'package:rab_staff/features/offline_sync/offline_sync_client.dart';
import 'package:rab_staff/features/offline_sync/offline_sync_controller.dart';
import 'package:rab_staff/features/offline_sync/offline_widgets.dart';
import 'package:rab_staff/features/offline_sync/saved_actions_screen.dart';

import 'support/biometric_test_support.dart';
import 'support/location_stream_stub.dart';
import 'support/offline_test_support.dart';

/// M4 offline queue, PR 2, on screen (DESIGN §3.6, D10, D18). Offline mode is switched on only through the injected
/// build flag and a fake signer; every real build has it off (owner HARD RULE).
DateTime _noon() {
  final today = DateTime.now();
  return DateTime(today.year, today.month, today.day, 12);
}

Position _position() => Position(
  latitude: 51.5,
  longitude: -0.12,
  timestamp: DateTime.now(),
  accuracy: 5,
  altitude: 0,
  altitudeAccuracy: 0,
  heading: 0,
  headingAccuracy: 0,
  speed: 0,
  speedAccuracy: 0,
);

class _Attendance extends AttendanceProvider {
  _Attendance(super.api, {super.offline});
  @override
  DateTime? get trustedNow => serverNow;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Map<String, String> secure;
  setUp(() {
    stubLocationStream();
    secure = {
      'rab.accessToken': 'a',
      'rab.refreshToken': 'r',
      'rab.sessionUserId': 'user-a',
    };
    stubSecureStorageChannel(secure);
  });
  tearDown(() {
    clearLocationStream();
    clearSecureStorageChannel();
  });

  OfflineSyncController controller({OfflineSyncClient? client}) =>
      OfflineSyncController(
        userId: 'user-a',
        bootClock: FakeBootClock(),
        signer: FakeEntrySigner(),
        buildFlag: true,
        client: client,
      );

  group('clock screen', () {
    final now = _noon();
    final offer = {
      'id': 'offer-1',
      'shiftId': 'shift-1',
      'status': 'manager_confirmed',
      'sentAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(days: 1)).toIso8601String(),
      'startsAt': now.subtract(const Duration(hours: 1)).toIso8601String(),
      'endsAt': now.add(const Duration(hours: 6)).toIso8601String(),
      'venueName': 'Example Hotel',
      'roleName': 'Bartender',
      'staffName': 'Alice Example',
      'staffProfileId': 'staff-1',
      'payRatePence': 1242,
      'estimatedPayPence': 8694,
    };
    late List<String> punches;

    ApiClient api() => ApiClient(
      httpClient: MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/offers/mine')) {
          return http.Response(jsonEncode([offer]), 200);
        }
        if (path.endsWith('/attendance/me/active')) {
          return http.Response(
            jsonEncode({
              'attendance': null,
              'serverNow': now.toUtc().toIso8601String(),
              'clockInEarlyMinutes': 15,
              'offline': {'enabled': true},
              'offlineTicket': 'tkt',
            }),
            200,
          );
        }
        if (path.contains('/attendance/clock-') ||
            path.endsWith('/attendance/check-in')) {
          punches.add(path);
          throw http.ClientException('Connection refused');
        }
        return http.Response('[]', 200);
      }),
    );

    Future<OfflineSyncController> mount(WidgetTester tester) async {
      punches = [];
      tester.view.physicalSize = const Size(393, 852);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final client = api();
      final offline = controller();
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<OfflineSyncController>.value(value: offline),
            ChangeNotifierProvider(create: (_) => OffersProvider(client)),
            ChangeNotifierProvider<AttendanceProvider>(
              create: (_) => _Attendance(client, offline: offline),
            ),
          ],
          child: MaterialApp(
            theme: buildLightTheme(),
            home: ScheduleClockScreen(
              visualStyle: ShiftVisualStyle.peach,
              offer: OfferSummary.fromJson(offer),
              locationResolver: (_) async => _position(),
              qrScanner: (_) async => 'qr-token',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return offline;
    }

    testWidgets(
      'a clock-in saved offline shows a fixed "not yet confirmed" card, no ticking timer, and allows clock-out',
      (tester) async {
        final offline = await mount(tester);
        expect(find.byKey(const ValueKey('clock-timer')), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('clock-primary')));
        await tester.pumpAndSettle();

        expect(punches, hasLength(1));
        expect(punches.single, endsWith('/attendance/clock-in'));
        expect(offline.entries.single.entry.type, OfflinePunchType.clockIn);
        expect(
          find.byKey(const ValueKey('offline-pending-card')),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('clock-timer')), findsNothing);
        expect(find.text('Not yet confirmed'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('offline-queued-banner')),
          findsOneWidget,
        );
        final shown = tester
            .widget<Text>(find.byKey(const ValueKey('offline-pending-time')))
            .data;
        expect(shown, startsWith('Clocked in '));
        // D10: nothing ticks. The text is the same after time passes.
        await tester.pump(const Duration(seconds: 5));
        expect(
          tester
              .widget<Text>(find.byKey(const ValueKey('offline-pending-time')))
              .data,
          shown,
        );

        // The action is now Clock out; it is saved behind the clock-in without a network attempt.
        expect(find.text('Clock out'), findsWidgets);
        await tester.tap(find.byKey(const ValueKey('clock-primary')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('confirm-clock-out')));
        await tester.pumpAndSettle();
        expect(punches, hasLength(1));
        expect(offline.entries.last.entry.type, OfflinePunchType.clockOut);
        final saved = tester.widget<FilledButton>(
          find.descendant(
            of: find.byKey(const ValueKey('clock-offline-saved')),
            matching: find.byType(FilledButton),
          ),
        );
        expect(saved.onPressed, isNull);
        expect(find.textContaining('Clocked out '), findsOneWidget);
      },
    );
  });

  group('logout guard (D18)', () {
    Future<void> pumpGuard(
      WidgetTester tester,
      OfflineSyncController? offline,
      void Function(int) onLogout,
    ) async {
      var logouts = 0;
      final button = Builder(
        builder: (context) => TextButton(
          onPressed: () => logoutWithOfflineGuard(context, () async {
            logouts++;
            onLogout(logouts);
          }),
          child: const Text('Log out'),
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: offline == null
                ? button
                : ChangeNotifierProvider<OfflineSyncController>.value(
                    value: offline,
                    child: button,
                  ),
          ),
        ),
      );
    }

    Future<OfflineSyncController> withPending({
      OfflineSyncClient? client,
    }) async {
      final c = controller(client: client);
      await c.ingestActive({
        'offline': {'enabled': true},
        'offlineTicket': 'tkt',
      }, fetchDuration: Duration.zero);
      await c.capture(
        type: OfflinePunchType.clockIn,
        shiftId: 'shift-1',
        idempotencyKey: c.newIdempotencyKey(),
      );
      return c;
    }

    testWidgets(
      'unsent punches block logout; "Stay signed in" keeps everything',
      (tester) async {
        final c = await withPending();
        var logouts = 0;
        await pumpGuard(tester, c, (n) => logouts = n);
        await tester.tap(find.text('Log out'));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('offline-logout-guard')),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const ValueKey('offline-logout-stay')));
        await tester.pumpAndSettle();
        expect(logouts, 0);
        expect(c.hasUnsent, isTrue);
      },
    );

    testWidgets('"Discard and log out" deletes the queue, then logs out', (
      tester,
    ) async {
      final c = await withPending();
      var logouts = 0;
      await pumpGuard(tester, c, (n) => logouts = n);
      await tester.tap(find.text('Log out'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('offline-logout-discard')));
      await tester.pumpAndSettle();
      expect(logouts, 1);
      expect(c.entries, isEmpty);
      expect(secure.containsKey(OfflineQueueStore.queueKey('user-a')), isFalse);
    });

    OfflineSyncClient syncServer({required bool up}) => OfflineSyncClient(
      ApiClient(
        httpClient: MockClient((request) async {
          if (!up) throw http.ClientException('Network is unreachable');
          final entries = ((jsonDecode(request.body) as Map)['entries'] as List)
              .cast<Map<String, dynamic>>();
          return http.Response(
            jsonEncode({
              'results': [
                for (final e in entries)
                  {'idempotencyKey': e['idempotencyKey'], 'outcome': 'applied'},
              ],
            }),
            200,
          );
        }),
      ),
    );

    testWidgets('"Send now" sends, then logs out once nothing is left', (
      tester,
    ) async {
      final c = await withPending(client: syncServer(up: true));
      var logouts = 0;
      await pumpGuard(tester, c, (n) => logouts = n);
      await tester.tap(find.text('Log out'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('offline-logout-send')));
      await tester.pumpAndSettle();
      expect(logouts, 1);
      expect(c.entries, isEmpty);
    });

    testWidgets(
      '"Send now" with no connection: stays signed in, says so, keeps the punch',
      (tester) async {
        final c = await withPending(client: syncServer(up: false));
        var logouts = 0;
        await pumpGuard(tester, c, (n) => logouts = n);
        await tester.tap(find.text('Log out'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('offline-logout-send')));
        await tester.pumpAndSettle();
        expect(logouts, 0);
        expect(c.hasUnsent, isTrue);
        expect(find.text(OfflineMessages.stillNotSent), findsOneWidget);
      },
    );

    testWidgets(
      'security review L3: start-up could not read the store; logout shows the guard and keeps the stored queue',
      (tester) async {
        await withPending();
        final c = OfflineSyncController(
          userId: 'user-a',
          store: _FailsFirstLoad(),
          bootClock: FakeBootClock(),
          signer: FakeEntrySigner(),
          buildFlag: true,
        );
        await c.ready;
        expect(c.entries, isEmpty);
        var logouts = 0;
        await pumpGuard(tester, c, (n) => logouts = n);
        await tester.tap(find.text('Log out'));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('offline-logout-guard')),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const ValueKey('offline-logout-stay')));
        await tester.pumpAndSettle();
        expect(logouts, 0);
        expect(
          secure.containsKey(OfflineQueueStore.queueKey('user-a')),
          isTrue,
        );
      },
    );
    testWidgets(
      're-review Low: a discard that fails on a broken store still logs out',
      (tester) async {
        final c = OfflineSyncController(
          userId: 'user-a',
          store: _ClearFails(),
          bootClock: FakeBootClock(),
          signer: FakeEntrySigner(),
          buildFlag: true,
        );
        await c.ingestActive({
          'offline': {'enabled': true},
          'offlineTicket': 'tkt',
        }, fetchDuration: Duration.zero);
        await c.capture(
          type: OfflinePunchType.clockIn,
          shiftId: 'shift-1',
          idempotencyKey: c.newIdempotencyKey(),
        );
        var logouts = 0;
        await pumpGuard(tester, c, (n) => logouts = n);
        await tester.tap(find.text('Log out'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('offline-logout-discard')));
        await tester.pumpAndSettle();
        expect(logouts, 1);
        expect(
          secure.containsKey(OfflineQueueStore.queueKey('user-a')),
          isTrue,
          reason: 'what could not be deleted stays keyed to this user',
        );
      },
    );

    testWidgets('nothing unsent, or no controller: logs out straight away', (
      tester,
    ) async {
      var logouts = 0;
      final empty = controller();
      await pumpGuard(tester, empty, (n) => logouts = n);
      await tester.tap(find.text('Log out'));
      await tester.pumpAndSettle();
      expect(logouts, 1);
      expect(find.byKey(const ValueKey('offline-logout-guard')), findsNothing);

      logouts = 0;
      await pumpGuard(tester, null, (n) => logouts = n);
      await tester.tap(find.text('Log out'));
      await tester.pumpAndSettle();
      expect(logouts, 1);
    });
  });

  group('banner and saved actions', () {
    Future<void> pumpWith(
      WidgetTester tester,
      OfflineSyncController c,
      Widget child,
    ) => tester.pumpWidget(
      ChangeNotifierProvider<OfflineSyncController>.value(
        value: c,
        child: MaterialApp(home: Scaffold(body: child)),
      ),
    );

    testWidgets('nothing saved: no banner', (tester) async {
      await pumpWith(tester, controller(), const OfflineQueueBanner());
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('offline-queued-banner')), findsNothing);
    });

    testWidgets(
      'a refused entry shows a red banner and a dismissible row; pending rows are not dismissible',
      (tester) async {
        await OfflineQueueStore().append(
          'user-a',
          samplePunch(key: keyFor(1), seq: 1),
        );
        await OfflineQueueStore().append(
          'user-a',
          samplePunch(
            key: keyFor(2),
            seq: 2,
            type: OfflinePunchType.clockOut,
            state: QueuedPunchState.rejected,
          ),
        );
        final c = controller();
        await c.ready;
        await pumpWith(tester, c, const OfflineQueueBanner());
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('offline-attention-banner')),
          findsOneWidget,
        );

        await pumpWith(tester, c, const SavedActionsScreen());
        await tester.pumpAndSettle();
        final pendingRow = find.byKey(ValueKey('saved-action-${keyFor(1)}'));
        final rejectedRow = find.byKey(ValueKey('saved-action-${keyFor(2)}'));
        expect(pendingRow, findsOneWidget);
        expect(rejectedRow, findsOneWidget);
        expect(
          find.descendant(of: pendingRow, matching: find.text('Dismiss')),
          findsNothing,
        );
        expect(find.text('Waiting to send'), findsOneWidget);
        await tester.tap(
          find.descendant(of: rejectedRow, matching: find.text('Dismiss')),
        );
        await tester.pumpAndSettle();
        expect(rejectedRow, findsNothing);
        expect(c.entries.single.idempotencyKey, keyFor(1));
      },
    );
  });
}

/// A store whose first [load] fails (secure storage unavailable at start-up), then works.
class _FailsFirstLoad extends OfflineQueueStore {
  var _failed = false;
  @override
  Future<OfflineQueueSnapshot> load(String userId) {
    if (!_failed) {
      _failed = true;
      return Future.error(StateError('secure storage unavailable'));
    }
    return super.load(userId);
  }
}

/// A store whose clear always fails (broken secure storage).
class _ClearFails extends OfflineQueueStore {
  @override
  Future<void> clear(String userId) =>
      Future.error(StateError('secure storage broken'));
}

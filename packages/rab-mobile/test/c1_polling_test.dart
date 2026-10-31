import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offers/schedule_offer_detail_screen.dart';
import 'package:rab_staff/features/venue_manager/sent_shift.dart';
import 'package:rab_staff/features/venue_manager/sent_shifts_screen.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'package:rab_staff/navigation/app_shell.dart';

import 'support/biometric_test_support.dart';

/// Phase C1 (smart polling) on the Flutter app, against server-shaped
/// responses: which requests each timer sends, when, with which header, and
/// what stays on screen when they fail.
class _Request {
  _Request(http.BaseRequest r)
    : method = r.method,
      path = r.url.path.replaceFirst('/rest/v1', ''),
      query = r.url.query,
      background = r.headers[kBackgroundRequestHeader];
  final String method, path, query;
  final String? background;
  String get target => query.isEmpty ? path : '$path?$query';
  @override
  String toString() => '$method $target${background == null ? '' : ' [bg]'}';
}

class _Server {
  final log = <_Request>[];
  final Map<String, Completer<void>> gates = {};
  final Set<String> failing = {};
  int sentCount = 3;
  bool sendable = false;

  /// A server without keyset paging: unknown `scope`/`cursor` → 400.
  bool oldOffersServer = false;
  String firstLabel = 'Offers sent';
  DateTime base = DateTime.utc(2026, 10, 1, 12);

  Map<String, dynamic> sentRow(int i) => {
    'id': 'shift-${i.toString().padLeft(3, '0')}',
    'status': 'offered',
    'roleName': 'Bartender',
    'venueName': 'Venue $i',
    'statusLabel': i == 0 ? firstLabel : 'Offers sent',
    'startsAt': '2026-11-0${1 + i % 8}T18:00:00Z',
    'endsAt': '2026-11-0${1 + i % 8}T23:00:00Z',
    'requiredCount': 2,
    'submittedAt': base.subtract(Duration(minutes: i)).toIso8601String(),
    'offerCounts': {'sent': 2, 'pending': 2, 'accepted': 0, 'confirmed': 0},
    'filters': ['pending'],
    'counters': {'sent': true, 'accepted': false, 'confirmed': false},
  };

  Map<String, dynamic> offer(int i) => {
    'id': 'offer-$i',
    'shiftId': 'shift-$i',
    'status': 'manager_confirmed',
    'sentAt': base.subtract(Duration(days: i)).toIso8601String(),
    'expiresAt': base.add(const Duration(days: 1)).toIso8601String(),
    'startsAt': base.add(Duration(days: 2 + i)).toIso8601String(),
    'endsAt': base.add(Duration(days: 2 + i, hours: 6)).toIso8601String(),
    'venueName': 'Venue $i',
    'roleName': 'Bartender',
    'staffProfileId': 'staff-1',
    'staffName': 'Test Staff',
    'payRatePence': 1500,
    'estimatedPayPence': 9000,
  };

  Map<String, dynamic> attendance(int i) => {
    'id': 'attendance-$i',
    'status': 'approved',
    'clockInAt': base.subtract(Duration(days: i + 1)).toIso8601String(),
    'clockOutAt': base
        .subtract(Duration(days: i + 1))
        .add(const Duration(hours: 6))
        .toIso8601String(),
    'shiftId': 'past-$i',
    'startsAt': base.subtract(Duration(days: i + 1)).toIso8601String(),
    'endsAt': base
        .subtract(Duration(days: i + 1))
        .add(const Duration(hours: 6))
        .toIso8601String(),
    'venueName': 'Venue $i',
    'roleName': 'Bartender',
    'staffProfileId': 'staff-1',
    'staffName': 'Test Staff',
  };

  /// `/attendance/me/history`: keyset pages when asked, else the legacy array.
  List<Map<String, dynamic>> historyRows = [];

  /// `/attendance/me/active`'s attendance, as it was when a request ARRIVED.
  Map<String, dynamic>? activeAttendance;
  bool legacyHistory = false;

  late final api = ApiClient(
    httpClient: MockClient((r) async {
      final request = _Request(r);
      log.add(request);
      final path = request.path;
      final activeAtArrival = activeAttendance;
      final gate = gates[path];
      if (gate != null) await gate.future;
      if (failing.contains(path)) {
        return http.Response('{"message":"Unavailable"}', 503);
      }
      final q = r.url.queryParameters;
      Object? body;
      switch (path) {
        case '/auth/me':
          body = fakeUserJson();
        case '/auth/capabilities':
          body = {
            'schedule.view': true,
            'venue.view': true,
            'staff.view': false,
            'report.view': false,
            'offer.send': sendable,
          };
        case '/shifts' when sendable:
          body = {
            'data': [
              {
                'id': 'shift-open',
                'createdBy': 'user-1',
                'venueId': 'venue-1',
                'jobRoleId': 'role-1',
                'startsAt': DateTime.now()
                    .add(const Duration(days: 1))
                    .toIso8601String(),
                'endsAt': DateTime.now()
                    .add(const Duration(days: 1, hours: 6))
                    .toIso8601String(),
                'requiredCount': 2,
                'filledCount': 0,
                'status': 'open',
              },
            ],
            'total': 1,
          };
        case '/shifts' || '/venues' || '/offers':
          body = {'data': <Object>[], 'total': 0};
        case '/shifts/sent':
          final rows = [for (var i = 0; i < sentCount; i++) sentRow(i)];
          final page = int.parse(q['page'] ?? '1');
          final limit = int.parse(q['limit'] ?? '500');
          body = {
            'data': rows.skip((page - 1) * limit).take(limit).toList(),
            'total': rows.length,
            'view': q['view'] ?? 'all',
            'counts': {
              'all': rows.length,
              'pending': rows.length,
              'submitted': rows.length,
            },
          };
        case '/notifications/unread-count':
          body = {'count': 1};
        case '/offers/mine' when oldOffersServer && q.isNotEmpty:
          return http.Response(
            '{"message":["property scope should not exist"]}',
            400,
          );
        case '/offers/mine':
          body = q.isEmpty
              ? [offer(0)]
              : {
                  'data': [offer(0)],
                  'nextCursor': null,
                };
        case '/attendance/me/active':
          body = {
            'attendance': activeAtArrival,
            'serverNow': base.toIso8601String(),
          };
        case '/attendance/me/history':
          if (legacyHistory || q.isEmpty) {
            body = historyRows;
          } else {
            final limit = int.parse(q['limit']!);
            final start = int.parse(q['cursor'] ?? '0');
            final page = historyRows.skip(start).take(limit).toList();
            final next = start + page.length;
            body = {
              'data': page,
              'nextCursor': next < historyRows.length ? '$next' : null,
            };
          }
        default:
          body = path.endsWith('/offers/bulk')
              ? {'results': <Object>[]}
              : path.startsWith('/offers/')
              ? {}
              : <Object>[];
      }
      return http.Response(jsonEncode(body), 200);
    }),
  );

  List<_Request> since(int from) => log.sublist(from);
}

const _firstPage = '/shifts/sent?view=all&page=1&limit=50';

void main() {
  setUp(
    () => stubSecureStorageChannel({
      'rab.accessToken': 'test',
      'rab.refreshToken': 'test',
    }),
  );
  tearDown(clearSecureStorageChannel);

  void lifecycle(WidgetTester tester, List<AppLifecycleState> states) {
    for (final s in states) {
      tester.binding.handleAppLifecycleStateChanged(s);
    }
  }

  const background = [
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
  ];
  const foreground = [
    AppLifecycleState.hidden,
    AppLifecycleState.inactive,
    AppLifecycleState.resumed,
  ];

  group('Venue Manager Sent Shifts', () {
    late _Server server;
    late VenueManagerProvider provider;
    late ValueNotifier<bool> tickers;

    Future<void> mount(WidgetTester tester) async {
      server = _Server();
      provider = VenueManagerProvider(server.api, 'user-1');
      tickers = ValueNotifier(true);
      addTearDown(provider.dispose);
      unawaited(provider.refresh());
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: provider,
          child: MaterialApp(
            theme: buildLightTheme(),
            // Stands in for VenueManagerShell's hidden-tab TickerMode.
            builder: (context, child) => ValueListenableBuilder<bool>(
              valueListenable: tickers,
              builder: (_, enabled, _) =>
                  TickerMode(enabled: enabled, child: child!),
            ),
            home: const VenueSentShiftsScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Venue 0'), findsOneWidget);
    }

    testWidgets(
      'polls ONLY the first page of the tab, every 30 s ±20 %, as background '
      'traffic (no full refresh)',
      (tester) async {
        await mount(tester);
        final from = server.log.length;
        await tester.pump(const Duration(seconds: 23));
        expect(server.since(from), isEmpty, reason: 'nothing before 24 s');
        await tester.pump(const Duration(seconds: 14));
        expect(server.since(from).map((r) => r.target), [_firstPage]);
        expect(server.log.last.background, '1');
        await tester.pump(const Duration(seconds: 37));
        expect(server.since(from), hasLength(2));
        expect(
          server.since(from).where((r) => r.path != '/shifts/sent'),
          isEmpty,
        );
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('the poll follows the selected tab', (tester) async {
      await mount(tester);
      await tester.tap(find.byKey(const Key('sent-view-pending')));
      await tester.pumpAndSettle();
      final from = server.log.length;
      await tester.pump(const Duration(seconds: 37));
      expect(server.since(from).map((r) => r.target), [
        '/shifts/sent?view=pending&page=1&limit=50',
      ]);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'a failed poll keeps every row with a non-blocking notice; recovery '
      'clears it',
      (tester) async {
        await mount(tester);
        server.failing.add('/shifts/sent');
        await tester.pump(const Duration(seconds: 37));
        await tester.pumpAndSettle();
        expect(find.text('Venue 0'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('stale-refresh-notice')),
          findsOneWidget,
        );
        expect(find.text('Unable to load'), findsNothing);
        expect(provider.sentShifts, hasLength(3));
        server.failing.clear();
        // Backoff after one failure: 60 s ±20 %.
        await tester.pump(const Duration(seconds: 73));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('stale-refresh-notice')),
          findsNothing,
        );
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'no polling while covered, on a hidden tab or backgrounded; visible '
      'again reads the first page once, as a foreground request',
      (tester) async {
        await mount(tester);
        final navigator = tester.state<NavigatorState>(find.byType(Navigator));
        navigator.push(
          MaterialPageRoute<void>(builder: (_) => const Text('covering')),
        );
        await tester.pumpAndSettle();
        var from = server.log.length;
        await tester.pump(const Duration(minutes: 5));
        expect(server.since(from), isEmpty, reason: 'route covered');
        navigator.pop();
        await tester.pumpAndSettle();
        expect(server.since(from).map((r) => r.target), [_firstPage]);
        expect(server.log.last.background, isNull);

        tickers.value = false;
        await tester.pump();
        from = server.log.length;
        await tester.pump(const Duration(minutes: 5));
        expect(server.since(from), isEmpty, reason: 'hidden shell tab');
        tickers.value = true;
        await tester.pumpAndSettle();
        expect(server.since(from).map((r) => r.target), [_firstPage]);

        lifecycle(tester, background);
        from = server.log.length;
        await tester.pump(const Duration(minutes: 10));
        expect(server.since(from), isEmpty, reason: 'app backgrounded');
        lifecycle(tester, foreground);
        await tester.pump(const Duration(seconds: 37));
        expect(server.since(from).map((r) => r.target), [_firstPage]);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('pull-to-refresh runs the full refresh as a user request', (
      tester,
    ) async {
      await mount(tester);
      final from = server.log.length;
      await tester.fling(
        find.byType(ListView).first,
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();
      final pulled = server.since(from);
      expect(pulled.map((r) => r.path), contains('/auth/capabilities'));
      expect(pulled.map((r) => r.path), contains('/shifts'));
      expect(pulled.where((r) => r.background != null), isEmpty);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'full refreshes never overlap: a second one is queued, never dropped',
      (tester) async {
        await mount(tester);
        final gate = server.gates['/auth/capabilities'] = Completer<void>();
        final from = server.log.length;
        var done = 0;
        unawaited(provider.refresh(silent: true).then((_) => done++));
        unawaited(provider.refresh().then((_) => done++));
        await tester.pump();
        expect(
          server.since(from).where((r) => r.path == '/auth/capabilities'),
          hasLength(1),
        );
        server.gates.clear();
        gate.complete();
        await tester.pumpAndSettle();
        expect(
          server.since(from).where((r) => r.path == '/auth/capabilities'),
          hasLength(2),
        );
        expect(done, 2);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      "the Venue Manager's own change refreshes in full at once (no poll wait)",
      (tester) async {
        await mount(tester);
        server.sendable = true;
        await provider.refresh();
        final from = server.log.length;
        await provider.send(provider.events.single, {'staff-1'});
        final after = server.since(from).map((r) => r.path).toList();
        expect(after.first, '/shifts/shift-open/offers/bulk');
        expect(after.skip(1), contains('/auth/capabilities'));
        expect(after.skip(1), contains('/shifts/sent'));
        await tester.pumpWidget(const SizedBox());
      },
    );

    test('first-page merge keeps rows the page did not reach', () {
      final server = _Server()..sentCount = 60;
      List<SentShift> rows(int count, {int skip = 0}) => [
        for (var i = skip; i < skip + count; i++)
          SentShift.fromJson(server.sentRow(i)),
      ];
      final loaded = rows(60);
      // A new request arrives on top: page 1 is it + the 49 newest.
      server.base = server.base.add(const Duration(minutes: 1));
      final fresh = [
        SentShift.fromJson({...server.sentRow(0), 'id': 'shift-new'}),
        ...rows(49),
      ];
      final merged = VenueManagerProvider.mergeSentFirstPage(
        loaded,
        fresh,
        total: 61,
      );
      expect(merged, hasLength(61));
      expect(merged.map((r) => r.id).toSet(), hasLength(61));
      expect(merged.first.id, 'shift-new');
      expect(merged.last.id, 'shift-059');
      // A page that holds everything replaces the list (removed rows go).
      expect(
        VenueManagerProvider.mergeSentFirstPage(loaded, rows(2), total: 2),
        hasLength(2),
      );
    });
  });

  group('Notifications', () {
    testWidgets(
      'unread count every 60 s ±20 % in the foreground, background header',
      (tester) async {
        final server = _Server();
        final notifications = NotificationsProvider(server.api);
        await tester.pump();
        expect(server.log.single.background, isNull, reason: 'first load');
        await tester.pump(const Duration(seconds: 47));
        expect(server.log, hasLength(1), reason: 'never before 48 s');
        await tester.pump(const Duration(seconds: 26));
        expect(server.log, hasLength(2));
        expect(server.log.last.target, '/notifications/unread-count');
        expect(server.log.last.background, '1');
        notifications.dispose();
      },
    );

    testWidgets('stops in the background; refreshes once on resume', (
      tester,
    ) async {
      final server = _Server();
      final notifications = NotificationsProvider(server.api);
      await tester.pump();
      lifecycle(tester, background);
      await tester.pump(const Duration(minutes: 30));
      expect(server.log, hasLength(1));
      lifecycle(tester, foreground);
      await tester.pump();
      expect(server.log, hasLength(2));
      expect(server.log.last.background, isNull, reason: 'resume = user');
      notifications.dispose();
    });
  });

  group('Staff offers and reconcile', () {
    testWidgets(
      'a reload requested while a load is in flight is queued, not dropped',
      (tester) async {
        final server = _Server();
        final gate = server.gates['/offers/mine'] = Completer<void>();
        final offers = OffersProvider(server.api);
        await tester.pump();
        expect(server.log.where((r) => r.path == '/offers/mine'), hasLength(1));
        // e.g. the reload right after the user's own check-in / clock-in.
        var reloaded = false;
        unawaited(offers.load(silent: true).then((_) => reloaded = true));
        server.gates.clear();
        gate.complete();
        await tester.pump();
        await tester.pump();
        final reads = server.log.where((r) => r.path == '/offers/mine');
        expect(reads, hasLength(2));
        expect(reads.last.query, 'scope=current&limit=50');
        expect(reads.last.background, isNull);
        expect(reloaded, isTrue);
        offers.dispose();
      },
    );

    testWidgets(
      'first load walks every offer (scope=all); accept reloads the current '
      'scope as a user request',
      (tester) async {
        final server = _Server();
        final offers = OffersProvider(server.api);
        await tester.pump();
        expect(server.log.single.target, '/offers/mine?scope=all&limit=200');
        await offers.respond('offer-0', 'accept');
        final reload = server.log.last;
        expect(
          server.log[server.log.length - 2].target,
          '/offers/offer-0/accept',
        );
        expect(reload.target, '/offers/mine?scope=current&limit=50');
        expect(reload.background, isNull);
        offers.dispose();
      },
    );

    testWidgets(
      'an older server (400 on scope) falls back to the legacy list',
      (tester) async {
        final server = _Server()..oldOffersServer = true;
        final offers = OffersProvider(server.api);
        await tester.pump();
        await tester.pump();
        expect(server.log.map((r) => r.target), [
          '/offers/mine?scope=all&limit=200',
          '/offers/mine',
        ]);
        expect(offers.offers.single.id, 'offer-0');
        expect(offers.loadError, isNull);
        offers.dispose();
      },
    );

    testWidgets('AppShell reconcile: 30 s ±20 % background reads, none in the '
        'background, a foreground read on resume', (tester) async {
      final server = _Server();
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider(
              create: (_) => AuthProvider(apiClient: server.api),
            ),
            ChangeNotifierProvider(create: (_) => OffersProvider(server.api)),
            ChangeNotifierProvider(
              create: (_) => NotificationsProvider(server.api),
            ),
            ChangeNotifierProvider(
              create: (_) => AttendanceProvider(server.api),
            ),
          ],
          child: MaterialApp(theme: buildLightTheme(), home: const AppShell()),
        ),
      );
      await tester.pumpAndSettle();
      bool reconcile(_Request r) =>
          r.path == '/offers/mine' || r.path == '/attendance/me/active';
      var from = server.log.length;
      await tester.pump(const Duration(seconds: 23));
      expect(server.since(from).where(reconcile), isEmpty);
      await tester.pump(const Duration(seconds: 14));
      final timed = server.since(from).where(reconcile).toList();
      expect(timed.map((r) => r.path).toSet(), {
        '/offers/mine',
        '/attendance/me/active',
      });
      expect(timed, hasLength(2), reason: 'one of each, no overlap');
      expect(timed.every((r) => r.background == '1'), isTrue);
      expect(
        timed.firstWhere((r) => r.path == '/offers/mine').query,
        'scope=current&limit=50',
      );

      lifecycle(tester, background);
      from = server.log.length;
      await tester.pump(const Duration(minutes: 10));
      expect(server.since(from), isEmpty);
      lifecycle(tester, foreground);
      await tester.pump();
      await tester.pump();
      final resumed = server.since(from).where(reconcile).toList();
      expect(resumed, hasLength(2));
      expect(resumed.every((r) => r.background == null), isTrue);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'Job Details no longer polls /offers/mine on its own (AppShell does)',
      (tester) async {
        final server = _Server();
        final offers = OffersProvider(server.api);
        final attendance = AttendanceProvider(server.api);
        await tester.pump();
        final json = server.offer(0);
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider.value(value: offers),
              ChangeNotifierProvider.value(value: attendance),
            ],
            child: MaterialApp(
              theme: buildLightTheme(),
              home: ScheduleOfferDetailScreen(
                offer: OfferSummary.fromJson(json),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 500));
        final from = server.log.length;
        await tester.pump(const Duration(seconds: 65));
        expect(
          server.since(from).where((r) => r.path == '/offers/mine'),
          isEmpty,
        );
        await tester.pumpWidget(const SizedBox());
        offers.dispose();
        attendance.dispose();
      },
    );
  });

  testWidgets(
    'a slow poll of /attendance/me/active never overwrites the newer read '
    'a clock-in just made',
    (tester) async {
      final server = _Server();
      final gate = server.gates['/attendance/me/active'] = Completer<void>();
      final attendance = AttendanceProvider(server.api); // read #1, no shift
      await tester.pump();
      server.gates.clear();
      server.activeAttendance = {
        ...server.attendance(0),
        'status': 'clocked_in',
        'clockOutAt': null,
      };
      await attendance.refreshActive(); // read #2, after the clock-in
      expect(attendance.active?.isOpen, isTrue);
      gate.complete();
      await tester.pump();
      await tester.pump();
      expect(attendance.active?.isOpen, isTrue, reason: 'stale read dropped');
      attendance.dispose();
    },
  );

  group('History paging', () {
    test('walks every keyset page until nextCursor is null', () async {
      final server = _Server()
        ..historyRows = [for (var i = 0; i < 203; i++) server0.attendance(i)];
      final attendance = AttendanceProvider(server.api);
      await attendance.loadHistory();
      expect(attendance.historyLoadError, isNull);
      expect(attendance.history, hasLength(203));
      final reads = server.log
          .where((r) => r.path == '/attendance/me/history')
          .map((r) => r.query)
          .toList();
      expect(reads, ['limit=200', 'limit=200&cursor=200']);
      attendance.dispose();
    });

    test('an older server (bare array) still loads everything', () async {
      final server = _Server()
        ..legacyHistory = true
        ..historyRows = [for (var i = 0; i < 3; i++) server0.attendance(i)];
      final attendance = AttendanceProvider(server.api);
      await attendance.loadHistory();
      expect(attendance.history, hasLength(3));
      expect(
        server.log.where((r) => r.path == '/attendance/me/history'),
        hasLength(1),
      );
      attendance.dispose();
    });

    test('an older server cut at the page size: legacy read instead', () async {
      final server = _Server()
        ..legacyHistory = true
        ..historyRows = [for (var i = 0; i < 200; i++) server0.attendance(i)];
      final attendance = AttendanceProvider(server.api);
      await attendance.loadHistory();
      final reads = server.log
          .where((r) => r.path == '/attendance/me/history')
          .map((r) => r.query)
          .toList();
      expect(reads, ['limit=200', '']);
      expect(attendance.history, hasLength(200));
      attendance.dispose();
    });
  });

  test('ApiClient: background header only when asked', () async {
    final server = _Server();
    await server.api.get('/notifications/unread-count');
    await server.api.get('/notifications/unread-count', background: true);
    expect(server.log.map((r) => r.background), [null, '1']);
  });
}

/// Fixture rows only (no client): a shared builder for row JSON.
final server0 = _Server();

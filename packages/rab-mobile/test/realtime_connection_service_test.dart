import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/push/push_registration_service.dart';
import 'package:rab_staff/core/realtime/realtime_connection_service.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/navigation/app_shell.dart';

import 'support/biometric_test_support.dart';

/// Phase C1b — the Flutter realtime client against a fake SSE server, on fake
/// time (`tester.pump`): every stream is a real `Stream<List<int>>` body.
const _userId = '33333333-3333-4333-8333-333333333333';
const _otherUserId = '55555555-5555-4555-8555-555555555555';

class _Random implements Random {
  _Random(this.value);
  final double value;
  @override
  double nextDouble() => value;
  @override
  int nextInt(int max) => 0;
  @override
  bool nextBool() => false;
}

class _Read {
  _Read(this.path, this.background);
  final String path;
  final String? background;
}

class _Server {
  /// Status of each next stream request (200 when the queue is empty).
  final statuses = <int>[];
  final retryAfter = <int, String>{};
  bool sseContentType = true;
  final streamHeaders = <Map<String, String>>[];
  final streamUrls = <Uri>[];
  final reads = <_Read>[];
  StreamController<List<int>>? live;

  /// `/auth/me` answers 403 from this call on (1 = the sign-in's own read).
  int? refuseAuthMeFrom;
  int authMeCalls = 0;
  int eventCounter = 0;

  int get streams => streamHeaders.length;
  int readsOf(String path) => reads.where((r) => r.path == path).length;

  http.StreamedResponse _json(Object body, [int status = 200]) =>
      http.StreamedResponse(
        Stream.value(utf8.encode(jsonEncode(body))),
        status,
      );

  late final http.Client client = MockClient.streaming((request, _) async {
    final path = request.url.path.replaceFirst('/rest/v1', '');
    if (path == RealtimeConnectionService.streamPath) {
      streamHeaders.add(request.headers);
      streamUrls.add(request.url);
      final status = statuses.isEmpty ? 200 : statuses.removeAt(0);
      if (status != 200) {
        return http.StreamedResponse(
          const Stream<List<int>>.empty(),
          status,
          headers: {
            if (retryAfter[status] != null) 'retry-after': retryAfter[status]!,
          },
        );
      }
      final controller = live = StreamController<List<int>>();
      return http.StreamedResponse(
        controller.stream,
        200,
        headers: {if (sseContentType) 'content-type': 'text/event-stream'},
      );
    }
    reads.add(_Read(path, request.headers[kBackgroundRequestHeader]));
    return switch (path) {
      '/auth/login' => _json({'accessToken': 'tok-a', 'refreshToken': 'ref-a'}),
      '/auth/me' =>
        ++authMeCalls >= (refuseAuthMeFrom ?? 1 << 30)
            ? _json({'message': 'no'}, 403)
            : _json(fakeUserJson(id: _userId)),
      '/auth/logout' => _json({}),
      '/offers/mine' => _json([]),
      '/attendance/me/active' => _json({'attendance': null}),
      '/attendance/me/history' => _json([]),
      '/notifications/unread-count' => _json({'count': 0}),
      _ => _json([]),
    };
  });

  void push(String frame) => live!.add(utf8.encode(frame));
  Future<void> drop() => live!.close();

  String event(String type, {String target = _userId, String? id}) {
    eventCounter++;
    final eventId =
        id ??
        '11111111-1111-4111-8111-${eventCounter.toString().padLeft(12, '0')}';
    final body = jsonEncode({
      'version': 1,
      'eventId': eventId,
      'type': type,
      'organisationId': '22222222-2222-4222-8222-222222222222',
      'workspaceId': null,
      'targetUserId': target,
      'entityId': '44444444-4444-4444-8444-444444444444',
      'occurredAt': '2026-10-31T00:00:00.000Z',
    });
    return 'data: $body\n\n';
  }
}

typedef _Started = ({
  RealtimeConnectionService service,
  AuthProvider auth,
  OffersProvider offers,
  AttendanceProvider attendance,
  NotificationsProvider notifications,
});

/// Everything a test created, disposed INSIDE the test body (the framework
/// checks for pending timers before tear-downs run).
final _disposers = <VoidCallback>[];

void _rt(String description, Future<void> Function(WidgetTester) body) =>
    testWidgets(description, (tester) async {
      _disposers.clear();
      try {
        await body(tester);
      } finally {
        for (final dispose in _disposers.reversed) {
          dispose();
        }
        _disposers.clear();
        await tester.pump();
      }
    });

void main() {
  late Map<String, String> secureStore;
  setUp(() {
    secureStore = {};
    stubSecureStorageChannel(secureStore);
  });
  tearDown(clearSecureStorageChannel);

  void lifecycle(WidgetTester tester, List<AppLifecycleState> states) {
    for (final s in states) {
      tester.binding.handleAppLifecycleStateChanged(s);
    }
  }

  const toBackground = [
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
  ];
  const toForeground = [
    AppLifecycleState.hidden,
    AppLifecycleState.inactive,
    AppLifecycleState.resumed,
  ];

  Future<AuthProvider> signIn(WidgetTester tester, _Server server) async {
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: server.client),
      biometricAuthenticator: FakeBiometricAuthenticator(
        capability: BiometricCapability.unavailable,
      ),
    );
    _disposers.add(auth.dispose);
    await tester.pump();
    await auth.login('alice@example.test', 'not-a-real-password-1A!');
    await tester.pump();
    expect(auth.user?.id, _userId);
    return auth;
  }

  Future<_Started> start(
    WidgetTester tester,
    _Server server, {
    double random = 0,
  }) async {
    final auth = await signIn(tester, server);
    final offers = OffersProvider(auth.api);
    final attendance = AttendanceProvider(auth.api);
    final notifications = NotificationsProvider(auth.api);
    await tester.pump();
    server.reads.clear();
    final service = RealtimeConnectionService(
      api: auth.api,
      auth: auth,
      offers: offers,
      attendance: attendance,
      notifications: notifications,
      random: _Random(random),
    );
    await tester.pump();
    _disposers.addAll([
      offers.dispose,
      attendance.dispose,
      notifications.dispose,
      service.dispose,
    ]);
    return (
      service: service,
      auth: auth,
      offers: offers,
      attendance: attendance,
      notifications: notifications,
    );
  }

  group('disabled / refused', () {
    for (final status in [204, 404]) {
      _rt('$status: one request, then silence (no reconnect loop)', (
        tester,
      ) async {
        final server = _Server()..statuses.add(status);
        final s = await start(tester, server);
        expect(server.streams, 1);
        await tester.pump(const Duration(minutes: 30));
        expect(server.streams, 1);
        expect(s.service.status, RealtimeConnectionStatus.disabled);
        // Even a resume never reopens a disabled stream for this identity.
        lifecycle(tester, toBackground);
        lifecycle(tester, toForeground);
        await tester.pump(const Duration(minutes: 5));
        expect(server.streams, 1);
      });
    }

    _rt('a 200 that is not an event stream is treated as disabled', (
      tester,
    ) async {
      final server = _Server()..sseContentType = false;
      final s = await start(tester, server);
      await tester.pump(const Duration(minutes: 10));
      expect(server.streams, 1);
      expect(s.service.status, RealtimeConnectionStatus.disabled);
    });

    for (final status in [401, 403]) {
      _rt('$status: one shared refresh (/auth/me), one retry, then stopped', (
        tester,
      ) async {
        final server = _Server()..statuses.addAll([status, status]);
        final s = await start(tester, server);
        await tester.pump();
        expect(server.streams, 2);
        expect(server.readsOf('/auth/me'), 1);
        expect(s.service.status, RealtimeConnectionStatus.stopped);
        await tester.pump(const Duration(minutes: 30));
        expect(server.streams, 2);
      });
    }

    _rt('401 then accepted after the refresh: connected', (tester) async {
      final server = _Server()..statuses.add(401);
      final s = await start(tester, server);
      await tester.pump();
      expect(server.streams, 2);
      expect(s.service.status, RealtimeConnectionStatus.connected);
    });

    _rt('401 whose refresh is refused: stopped, never retried', (tester) async {
      final server = _Server()
        ..statuses.add(401)
        ..refuseAuthMeFrom = 2;
      final s = await start(tester, server);
      await tester.pump();
      await tester.pump(const Duration(minutes: 30));
      expect(server.streams, 1);
      expect(s.service.status, RealtimeConnectionStatus.stopped);
    });
  });

  _rt('stream request: background header, bearer header, no token in the URL', (
    tester,
  ) async {
    final server = _Server();
    final s = await start(tester, server);
    expect(s.service.status, RealtimeConnectionStatus.connected);
    expect(server.streamHeaders.single[kBackgroundRequestHeader], '1');
    expect(server.streamHeaders.single['Authorization'], 'Bearer tok-a');
    expect(server.streamHeaders.single['Accept'], 'text/event-stream');
    expect(server.streamUrls.single.toString(), isNot(contains('tok-a')));
  });

  _rt('429 waits Retry-After (never less), then reconnects', (tester) async {
    final server = _Server()
      ..statuses.add(429)
      ..retryAfter[429] = '90';
    final s = await start(tester, server);
    expect(s.service.lastDelay, const Duration(seconds: 90));
    await tester.pump(const Duration(seconds: 89));
    expect(server.streams, 1);
    await tester.pump(const Duration(seconds: 2));
    expect(server.streams, 2);
    expect(s.service.status, RealtimeConnectionStatus.connected);
  });

  _rt('F4: 429 with Retry-After 0 waits at least 1 s', (tester) async {
    final server = _Server()
      ..statuses.add(429)
      ..retryAfter[429] = '0';
    final s = await start(tester, server);
    expect(
      s.service.lastDelay!,
      greaterThanOrEqualTo(const Duration(seconds: 1)),
    );
    await tester.pump(const Duration(milliseconds: 999));
    expect(server.streams, 1);
    await tester.pump(const Duration(milliseconds: 2));
    expect(server.streams, 2);
  });

  _rt('429 without Retry-After waits 30 s plus up to 20 % jitter', (
    tester,
  ) async {
    final server = _Server()..statuses.add(429);
    final s = await start(tester, server, random: .999999);
    expect(s.service.lastDelay!, greaterThan(const Duration(seconds: 35)));
    expect(
      s.service.lastDelay!,
      lessThanOrEqualTo(const Duration(seconds: 36)),
    );
  });

  _rt('watchdog: no byte for 50 s reconnects; keepalives keep it up', (
    tester,
  ) async {
    final server = _Server();
    final s = await start(tester, server);
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(seconds: 25));
      server.push(': keepalive\n\n');
    }
    await tester.pump();
    expect(server.streams, 1, reason: '200 s of keepalives: same stream');
    await tester.pump(const Duration(seconds: 49));
    expect(server.streams, 1);
    await tester.pump(const Duration(seconds: 2));
    expect(server.streams, 2, reason: 'dropped and reopened (0.5 s backoff)');
    expect(s.service.status, RealtimeConnectionStatus.connected);
  });

  _rt('backoff grows on short-lived connections and resets only after one that '
      'stayed up for 60 s', (tester) async {
    final server = _Server();
    final s = await start(tester, server); // random 0 → 50 % of each step
    final delays = <Duration>[];
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 10)); // up, not for 60 s
      server.push(': keepalive\n\n');
      await server.drop();
      await tester.pump();
      delays.add(s.service.lastDelay!);
      await tester.pump(s.service.lastDelay!);
    }
    expect(delays, [
      const Duration(milliseconds: 500),
      const Duration(seconds: 1),
      const Duration(seconds: 2),
      const Duration(seconds: 4),
    ]);
    // A connection that stays up ≥ 60 s resets the backoff.
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(seconds: 21));
      server.push(': keepalive\n\n');
    }
    await server.drop();
    await tester.pump();
    expect(s.service.lastDelay, const Duration(milliseconds: 500));
  });

  _rt('a reconnect after a drop reconciles; the first connect does not', (
    tester,
  ) async {
    final server = _Server();
    await start(tester, server);
    await tester.pump(const Duration(seconds: 1));
    expect(server.reads, isEmpty, reason: 'no reconcile on first connect');
    await server.drop();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(server.streams, 2);
    await tester.pump(const Duration(milliseconds: 10));
    expect(server.readsOf('/offers/mine'), 1);
    expect(server.readsOf('/attendance/me/active'), 1);
    expect(server.readsOf('/attendance/me/history'), 1);
    expect(server.readsOf('/notifications/unread-count'), 1);
    expect(server.reads.every((r) => r.background == '1'), isTrue);
  });

  group('events', () {
    test('every catalogue type maps to the right refresh', () {
      Set<RealtimeRefresh> staff(String type) =>
          realtimeRefreshesFor({type}, staff: true, venueManager: false);
      Set<RealtimeRefresh> vm(String type) =>
          realtimeRefreshesFor({type}, staff: false, venueManager: true);
      for (final type in [
        'offer.sent',
        'offer.accepted',
        'offer.confirmed',
        'offer.declined',
        'offer.withdrawn',
        'offer.expired',
        'offer.rejected',
        'shift.updated',
        'shift.cancelled',
      ]) {
        expect(staff(type), {RealtimeRefresh.offers}, reason: type);
        expect(vm(type), {RealtimeRefresh.venueManager}, reason: type);
      }
      for (final type in [
        'shift_request.created',
        'shift_request.approved',
        'shift_request.declined',
      ]) {
        expect(staff(type), isEmpty, reason: type);
        expect(vm(type), {RealtimeRefresh.venueManager}, reason: type);
      }
      expect(staff('attendance.changed'), {
        RealtimeRefresh.attendance,
        RealtimeRefresh.history,
      });
      expect(vm('attendance.changed'), {RealtimeRefresh.venueManager});
      expect(staff('payroll.record_changed'), {RealtimeRefresh.history});
      expect(vm('payroll.record_changed'), isEmpty);
      expect(staff('notification.created'), {RealtimeRefresh.unreadCount});
      expect(vm('notification.created'), {RealtimeRefresh.unreadCount});
      expect(staff('navigation_layout.saved'), isEmpty);
    });

    _rt('a burst is coalesced (~0.5 s) into one background refresh of each '
        'affected provider', (tester) async {
      final server = _Server();
      await start(tester, server);
      server
        ..push(server.event('offer.declined'))
        ..push(server.event('offer.withdrawn'))
        ..push(server.event('shift.cancelled'))
        ..push(server.event('attendance.changed'))
        ..push(server.event('notification.created'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(server.reads, isEmpty, reason: 'still coalescing');
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
      expect(server.readsOf('/offers/mine'), 1);
      expect(server.readsOf('/attendance/me/active'), 1);
      expect(server.readsOf('/attendance/me/history'), 1);
      expect(server.readsOf('/notifications/unread-count'), 1);
      expect(server.reads.every((r) => r.background == '1'), isTrue);
    });

    _rt("another user's event, a duplicate id and a malformed frame refresh "
        'nothing', (tester) async {
      final server = _Server();
      await start(tester, server);
      server.push(server.event('offer.sent', target: _otherUserId));
      server.push('data: {not json}\n\n');
      await tester.pump(const Duration(seconds: 1));
      expect(server.reads, isEmpty);
      final frame = server.event('offer.sent');
      server.push(frame);
      await tester.pump(const Duration(seconds: 1));
      expect(server.readsOf('/offers/mine'), 1);
      server.push(frame); // at-least-once redelivery
      await tester.pump(const Duration(seconds: 1));
      expect(server.readsOf('/offers/mine'), 1);
    });

    _rt('after sign-out the stream stops and no event is applied', (
      tester,
    ) async {
      final server = _Server();
      final s = await start(tester, server);
      unawaited(s.auth.logout());
      await tester.pump();
      server.push(server.event('offer.sent'));
      await tester.pump(const Duration(seconds: 1));
      expect(server.readsOf('/offers/mine'), 0);
      expect(s.service.status, RealtimeConnectionStatus.stopped);
      await tester.pump(const Duration(minutes: 5));
      expect(server.streams, 1);
    });
  });

  _rt('while live the notification poll slows to 120 s; it reverts when the '
      'stream is gone', (tester) async {
    final server = _Server();
    final s = await start(tester, server);
    expect(s.service.isLive, isTrue);
    // Keepalives keep the stream (and the slow poll) alive. 120 s ±20 % =
    // 96–144 s: nothing by 95 s (a 60 s poll would have run by 72 s).
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(seconds: 19));
      server.push(': keepalive\n\n');
    }
    expect(server.readsOf('/notifications/unread-count'), 0);
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(seconds: 19));
      server.push(': keepalive\n\n');
    }
    expect(server.readsOf('/notifications/unread-count'), 1);
    // The server turns realtime off: back to 60 s ±20 %.
    server.statuses.add(204);
    await server.drop();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(s.service.status, RealtimeConnectionStatus.disabled);
    final before = server.readsOf('/notifications/unread-count');
    await tester.pump(const Duration(seconds: 73));
    expect(server.readsOf('/notifications/unread-count'), greaterThan(before));
  });

  _rt('a resume while already connected never opens a second stream', (
    tester,
  ) async {
    final server = _Server();
    final s = await start(tester, server);
    expect(s.service.status, RealtimeConnectionStatus.connected);
    lifecycle(tester, const [
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]);
    await tester.pump(const Duration(seconds: 5));
    expect(server.streams, 1, reason: 'no overlapping streams');
    expect(s.service.status, RealtimeConnectionStatus.connected);
  });

  _rt('dispose closes the stream: a later frame is ignored without error', (
    tester,
  ) async {
    final server = _Server();
    final s = await start(tester, server);
    _disposers.remove(s.service.dispose);
    s.service.dispose();
    await tester.pump();
    server.reads.clear();
    expect(() => server.push(server.event('offer.sent')), returnsNormally);
    await tester.pump(const Duration(seconds: 1));
    expect(server.reads, isEmpty);
    await tester.pump(const Duration(minutes: 5));
    expect(server.streams, 1, reason: 'never reconnects after dispose');
  });

  _rt('background closes the stream; resume reopens it without a reconcile '
      '(the shells own that)', (tester) async {
    final server = _Server();
    final s = await start(tester, server);
    lifecycle(tester, toBackground);
    await tester.pump();
    expect(s.service.status, RealtimeConnectionStatus.offline);
    await tester.pump(const Duration(minutes: 10));
    expect(server.streams, 1);
    server.reads.clear();
    lifecycle(tester, toForeground);
    await tester.pump();
    expect(server.streams, 2);
    expect(s.service.status, RealtimeConnectionStatus.connected);
    // NotificationsProvider's own resume refresh is the only read.
    expect(
      server.reads.where((r) => r.path != '/notifications/unread-count'),
      isEmpty,
    );
  });

  _rt('app startup instantiates realtime and push; a 204 server gets exactly '
      'one stream request, then silence', (tester) async {
    final server = _Server()..statuses.add(204);
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: server.client),
      biometricAuthenticator: FakeBiometricAuthenticator(
        capability: BiometricCapability.unavailable,
      ),
    );
    await tester.pumpWidget(
      ChangeNotifierProvider<AuthProvider>.value(
        value: auth,
        child: const RabApp(),
      ),
    );
    await tester.pumpAndSettle();
    expect(server.streams, 0, reason: 'signed out: no stream');
    await auth.login('alice@example.test', 'not-a-real-password-1A!');
    await tester.pumpAndSettle();
    final shell = tester.element(find.byType(AppShell));
    final realtime = Provider.of<RealtimeConnectionService>(
      shell,
      listen: false,
    );
    expect(
      Provider.of<PushRegistrationService>(shell, listen: false),
      isNotNull,
    );
    expect(server.streams, 1);
    expect(realtime.status, RealtimeConnectionStatus.disabled);
    await tester.pump(const Duration(minutes: 10));
    expect(server.streams, 1);
    await tester.pumpWidget(const SizedBox());
  });

  _rt('AppShell staff reconcile slows to 120 s while the stream is live and '
      'reverts to 30 s ±20 % when it is gone', (tester) async {
    final server = _Server();
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: server.client),
      biometricAuthenticator: FakeBiometricAuthenticator(
        capability: BiometricCapability.unavailable,
      ),
    );
    _disposers.add(auth.dispose);
    await tester.pumpWidget(
      ChangeNotifierProvider<AuthProvider>.value(
        value: auth,
        child: const RabApp(),
      ),
    );
    await tester.pumpAndSettle();
    await auth.login('alice@example.test', 'not-a-real-password-1A!');
    await tester.pumpAndSettle();
    final realtime = Provider.of<RealtimeConnectionService>(
      tester.element(find.byType(AppShell)),
      listen: false,
    );
    expect(realtime.isLive, isTrue);
    int timed() => server.reads
        .where((r) => r.path == '/offers/mine' && r.background == '1')
        .length;
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 23));
      server.push(': keepalive\n\n');
    }
    expect(
      timed(),
      0,
      reason: 'live: no 30 s reconcile within 92 s (120 s -20 % = 96 s)',
    );
    server.statuses.add(204);
    await server.drop();
    await tester.pump(const Duration(seconds: 1));
    expect(realtime.status, RealtimeConnectionStatus.disabled);
    await tester.pump(const Duration(seconds: 37));
    expect(timed(), 1, reason: 'reverted to 30 s ±20 %');
    await tester.pumpWidget(const SizedBox());
  });
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/realtime/realtime_connection_service.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';

import 'support/biometric_test_support.dart';

/// A controllable fake SSE server: `push`/`end` drive a real
/// `StreamController<List<int>>` that becomes the `StreamedResponse` body.
class _FakeSseServer {
  final controller = StreamController<List<int>>();
  int connectCount = 0;
  String? lastRequestAuthorizationHeader;
  Uri? lastRequestUrl;
  int nextStatusCode = 200;

  /// The actual response logic, callable directly from a composed
  /// `MockClient.streaming` callback — never via a second `Client.send()`
  /// on the SAME request object, which would re-finalize an already-
  /// finalized request and throw.
  Future<http.StreamedResponse> respond(http.BaseRequest request) async {
    connectCount++;
    lastRequestUrl = request.url;
    lastRequestAuthorizationHeader = request.headers['Authorization'];
    final status = nextStatusCode;
    if (status != 200) {
      return http.StreamedResponse(const Stream<List<int>>.empty(), status);
    }
    return http.StreamedResponse(controller.stream, 200);
  }

  http.Client get client => MockClient.streaming((request, bodyStream) => respond(request));

  void push(String frame) => controller.add(utf8.encode(frame));
  Future<void> end() => controller.close();
}

/// Real streaming tests: `MockClient.streaming` hands the service a genuine
/// `Stream<List<int>>` body, exactly like a real chunked HTTP response — a
/// test that only ever returns a canned `Response` could never exercise the
/// SSE parsing/dedup/reconnect logic at all (Stage 5 §14's own warning
/// against "passing merely because a mock never emitted an event").
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;
  setUp(() {
    secureStore = {};
    stubSecureStorageChannel(secureStore);
  });
  tearDown(clearSecureStorageChannel);

  const fastBackoff = Duration(milliseconds: 10);

  Future<AuthProvider> readyAuth(http.Client httpClient) async {
    final auth = AuthProvider(apiClient: ApiClient(httpClient: httpClient));
    await waitUntilPhaseNot(auth, AuthPhase.loading);
    return auth;
  }

  group('connection setup', () {
    test('connects to GET {baseUrl}/realtime/stream with a Bearer header, never a token in the URL', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await ApiClient(httpClient: server.client).storeTokens('tok-abc', 'refresh-1');
      // storeTokens above used a throwaway client; write through auth's own api instead so getAccessToken() in the service sees it.
      await auth.api.storeTokens('tok-abc', 'refresh-1');

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        httpClient: server.client,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();

      expect(server.lastRequestUrl?.path, endsWith('/realtime/stream'));
      expect(server.lastRequestUrl.toString(), isNot(contains('tok-abc'))); // never in the URL/query string
      expect(server.lastRequestAuthorizationHeader, 'Bearer tok-abc');
    });

    test('status transitions connecting -> connected on a successful 200 stream', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      final service = RealtimeConnectionService(api: auth.api, auth: auth, httpClient: server.client, baseBackoff: fastBackoff);
      addTearDown(service.dispose);
      await pumpEventQueue();

      expect(service.status, RealtimeConnectionStatus.connected);
    });
  });

  group('event parsing and routing', () {
    test('a valid offer.sent event triggers OffersProvider.load (silent refresh)', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      var offersLoadCalls = 0;
      final offersClient = MockClient((request) async {
        if (request.url.path.endsWith('/offers/mine')) {
          offersLoadCalls++;
          return http.Response(jsonEncode([]), 200);
        }
        return http.Response('not found', 404);
      });
      final offers = OffersProvider(ApiClient(httpClient: offersClient));
      await pumpEventQueue();
      final baseline = offersLoadCalls;

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        offers: offers,
        httpClient: server.client,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();

      server.push(
        'data: {"version":1,"eventId":"11111111-1111-1111-1111-111111111111",'
        '"type":"offer.sent","organisationId":"22222222-2222-2222-2222-222222222222",'
        '"workspaceId":null,"targetUserId":"33333333-3333-3333-3333-333333333333",'
        '"entityId":"44444444-4444-4444-4444-444444444444","occurredAt":"2026-01-01T00:00:00.000Z"}\n\n',
      );
      await pumpEventQueue();

      expect(offersLoadCalls, baseline + 1);
    });

    test('a duplicate eventId delivered twice triggers only one refresh', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      var offersLoadCalls = 0;
      final offersClient = MockClient((request) async {
        offersLoadCalls++;
        return http.Response(jsonEncode([]), 200);
      });
      final offers = OffersProvider(ApiClient(httpClient: offersClient));
      await pumpEventQueue();
      final baseline = offersLoadCalls;

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        offers: offers,
        httpClient: server.client,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();

      const frame =
          'data: {"version":1,"eventId":"11111111-1111-1111-1111-111111111111",'
          '"type":"offer.sent","organisationId":"22222222-2222-2222-2222-222222222222",'
          '"workspaceId":null,"targetUserId":"33333333-3333-3333-3333-333333333333",'
          '"entityId":"44444444-4444-4444-4444-444444444444","occurredAt":"2026-01-01T00:00:00.000Z"}\n\n';
      server.push(frame);
      await pumpEventQueue();
      server.push(frame); // exact repeat — at-least-once outbox delivery
      await pumpEventQueue();

      expect(offersLoadCalls, baseline + 1);
    });

    test('a malformed frame is dropped without crashing, and a later valid frame still works', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      var offersLoadCalls = 0;
      final offersClient = MockClient((request) async {
        offersLoadCalls++;
        return http.Response(jsonEncode([]), 200);
      });
      final offers = OffersProvider(ApiClient(httpClient: offersClient));
      await pumpEventQueue();
      final baseline = offersLoadCalls;

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        offers: offers,
        httpClient: server.client,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();

      server.push('data: {not-json-at-all\n\n');
      await pumpEventQueue();
      expect(offersLoadCalls, baseline); // dropped, no refresh

      server.push(
        'data: {"version":1,"eventId":"55555555-5555-5555-5555-555555555555",'
        '"type":"offer.sent","organisationId":"22222222-2222-2222-2222-222222222222",'
        '"workspaceId":null,"targetUserId":"33333333-3333-3333-3333-333333333333",'
        '"entityId":"44444444-4444-4444-4444-444444444444","occurredAt":"2026-01-01T00:00:00.000Z"}\n\n',
      );
      await pumpEventQueue();
      expect(offersLoadCalls, baseline + 1); // the stream survived, a real frame still works
    });
  });

  group('identity fencing', () {
    test('an event delivered after the identity generation changes is discarded', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      var offersLoadCalls = 0;
      final offersClient = MockClient((request) async {
        offersLoadCalls++;
        return http.Response(jsonEncode([]), 200);
      });
      final offers = OffersProvider(ApiClient(httpClient: offersClient));
      await pumpEventQueue();
      final baseline = offersLoadCalls;

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        offers: offers,
        httpClient: server.client,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();

      // Simulate a logout/different-login changing the ambient identity
      // generation without this connection having been torn down yet
      // (the exact race the fencing check in `_handleFrame` guards against).
      await auth.logout();

      server.push(
        'data: {"version":1,"eventId":"66666666-6666-6666-6666-666666666666",'
        '"type":"offer.sent","organisationId":"22222222-2222-2222-2222-222222222222",'
        '"workspaceId":null,"targetUserId":"33333333-3333-3333-3333-333333333333",'
        '"entityId":"44444444-4444-4444-4444-444444444444","occurredAt":"2026-01-01T00:00:00.000Z"}\n\n',
      );
      await pumpEventQueue();

      expect(offersLoadCalls, baseline); // discarded — never delivered into the stale identity
    });
  });

  group('auth failures', () {
    test('a 401 on connect that resolves via token refresh reconnects rather than giving up', () async {
      final server = _FakeSseServer()..nextStatusCode = 401;
      var meCalls = 0;
      final composedClient = MockClient.streaming((request, bodyStream) async {
        if (request.url.path.endsWith('/auth/me')) {
          meCalls++;
          server.nextStatusCode = 200; // refresh "succeeded" — next connect attempt gets a real stream
          return http.StreamedResponse(
            Stream<List<int>>.value(utf8.encode(jsonEncode({'id': 'u1', 'email': 'a@test', 'firstName': 'A', 'lastName': 'B', 'organisationId': 'org', 'roles': ['staff']}))),
            200,
          );
        }
        return server.respond(request);
      });
      final auth = await readyAuth(composedClient);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        httpClient: composedClient,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(meCalls, greaterThan(0));
      expect(service.status, RealtimeConnectionStatus.connected);
    });

    test('a 401 on connect whose refresh also fails does not keep retrying', () async {
      final server = _FakeSseServer()..nextStatusCode = 401;
      final composedClient = MockClient.streaming((request, bodyStream) async {
        if (request.url.path.endsWith('/auth/me') || request.url.path.endsWith('/auth/refresh')) {
          return http.StreamedResponse(Stream<List<int>>.value(utf8.encode('{"message":"expired"}')), 401);
        }
        return server.respond(request);
      });
      final auth = await readyAuth(composedClient);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        httpClient: composedClient,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();
      final connectAttemptsAfterFirstFailure = server.connectCount;
      await Future<void>.delayed(const Duration(milliseconds: 100));

      // An unrecoverable auth rejection must not retry forever.
      expect(server.connectCount, connectAttemptsAfterFirstFailure);
      expect(auth.phase, AuthPhase.unauthenticated);
    });
  });

  group('lifecycle', () {
    test('backgrounding closes the connection; resuming reconnects and reconciles', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      var offersLoadCalls = 0;
      final offersClient = MockClient((request) async {
        offersLoadCalls++;
        return http.Response(jsonEncode([]), 200);
      });
      final offers = OffersProvider(ApiClient(httpClient: offersClient));
      await pumpEventQueue();

      final service = RealtimeConnectionService(
        api: auth.api,
        auth: auth,
        offers: offers,
        httpClient: server.client,
        baseBackoff: fastBackoff,
      );
      addTearDown(service.dispose);
      await pumpEventQueue();
      expect(service.status, RealtimeConnectionStatus.connected);

      service.didChangeAppLifecycleState(AppLifecycleState.paused);
      await pumpEventQueue();
      expect(service.status, RealtimeConnectionStatus.offline);
      final connectCountWhileBackgrounded = server.connectCount;

      final beforeResumeLoadCalls = offersLoadCalls;
      service.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await pumpEventQueue();

      expect(server.connectCount, greaterThan(connectCountWhileBackgrounded)); // reconnected
      expect(offersLoadCalls, greaterThan(beforeResumeLoadCalls)); // reconciled via the existing refresh method
    });

    test('no duplicate connection is opened while already connected (no overlapping streams)', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      final service = RealtimeConnectionService(api: auth.api, auth: auth, httpClient: server.client, baseBackoff: fastBackoff);
      addTearDown(service.dispose);
      await pumpEventQueue();
      final countAfterInitialConnect = server.connectCount;

      // Lifecycle no-ops (inactive/hidden) must never trigger a second connect.
      service.didChangeAppLifecycleState(AppLifecycleState.inactive);
      await pumpEventQueue();
      expect(server.connectCount, countAfterInitialConnect);
    });
  });

  group('disposal', () {
    test('dispose() cancels the subscription and removes the lifecycle observer cleanly', () async {
      final server = _FakeSseServer();
      final auth = await readyAuth(server.client);
      await auth.api.storeTokens('tok-1', 'refresh-1');

      final service = RealtimeConnectionService(api: auth.api, auth: auth, httpClient: server.client, baseBackoff: fastBackoff);
      await pumpEventQueue();
      expect(service.status, RealtimeConnectionStatus.connected);

      service.dispose();
      // Pushing after dispose must never throw synchronously nor call notifyListeners on a disposed ChangeNotifier.
      expect(() => server.push('data: {}\n\n'), returnsNormally);
      await pumpEventQueue();
    });
  });
}

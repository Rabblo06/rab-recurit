import 'dart:convert';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/push/push_registration_service.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';

import 'support/biometric_test_support.dart';

/// `flutter test` runs on the host OS (Windows/macOS/Linux CI), never on a
/// real Android device — `Platform.isAndroid` is therefore always false
/// here, so `PushRegistrationService._register()`'s Firebase path can never
/// be exercised in this suite (nor anywhere else without a real device or
/// emulator). What IS testable regardless of host platform, and what these
/// tests cover: the lifecycle-driven refresh behaviour, and that the service
/// never throws or calls the backend when there is nothing to register or
/// deregister.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => stubSecureStorageChannel(<String, String>{}));
  tearDown(clearSecureStorageChannel);

  http.Client recordingClient(List<http.Request> requests, {Object? notificationsBody}) {
    return MockClient((request) async {
      requests.add(request);
      if (request.url.path.endsWith('/notifications')) {
        return http.Response(jsonEncode(notificationsBody ?? <dynamic>[]), 200);
      }
      if (request.url.path.endsWith('/notifications/unread-count')) {
        return http.Response(jsonEncode({'count': 0}), 200);
      }
      return http.Response('null', 200);
    });
  }

  test('construction never throws and never calls the backend when the host is not Android', () async {
    final requests = <http.Request>[];
    final api = ApiClient(httpClient: recordingClient(requests));
    final notifications = NotificationsProvider(api);
    await pumpEventQueue();
    requests.clear(); // drop NotificationsProvider's own constructor poll

    final service = PushRegistrationService(api: api, notifications: notifications);
    addTearDown(service.dispose);
    await pumpEventQueue();

    expect(requests.where((r) => r.url.path.contains('/push/devices')), isEmpty);
  });

  test('app resume refetches notifications — the same "go refetch" idiom RealtimeConnectionService uses', () async {
    final requests = <http.Request>[];
    final api = ApiClient(httpClient: recordingClient(requests));
    final notifications = NotificationsProvider(api);
    await pumpEventQueue();
    requests.clear();

    final service = PushRegistrationService(api: api, notifications: notifications);
    addTearDown(service.dispose);
    await pumpEventQueue();

    service.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await pumpEventQueue();

    expect(requests.any((r) => r.url.path.endsWith('/notifications')), isTrue);
  });

  test('other lifecycle transitions never trigger a refetch', () async {
    final requests = <http.Request>[];
    final api = ApiClient(httpClient: recordingClient(requests));
    final notifications = NotificationsProvider(api);
    await pumpEventQueue();
    requests.clear();

    final service = PushRegistrationService(api: api, notifications: notifications);
    addTearDown(service.dispose);
    await pumpEventQueue();

    service.didChangeAppLifecycleState(AppLifecycleState.paused);
    service.didChangeAppLifecycleState(AppLifecycleState.inactive);
    service.didChangeAppLifecycleState(AppLifecycleState.hidden);
    await pumpEventQueue();

    expect(requests.where((r) => r.url.path.endsWith('/notifications')), isEmpty);
  });

  test('dispose with nothing registered never calls the deactivate endpoint', () async {
    final requests = <http.Request>[];
    final api = ApiClient(httpClient: recordingClient(requests));
    final notifications = NotificationsProvider(api);
    await pumpEventQueue();

    final service = PushRegistrationService(api: api, notifications: notifications);
    await pumpEventQueue();
    requests.clear();

    service.dispose();
    await pumpEventQueue();

    expect(requests.where((r) => r.url.path.contains('/deactivate')), isEmpty);
  });

  test('works with no NotificationsProvider supplied at all (presentation with no bell)', () async {
    final requests = <http.Request>[];
    final api = ApiClient(httpClient: recordingClient(requests));

    final service = PushRegistrationService(api: api);
    addTearDown(service.dispose);
    await pumpEventQueue();

    expect(() => service.didChangeAppLifecycleState(AppLifecycleState.resumed), returnsNormally);
  });
}

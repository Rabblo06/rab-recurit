import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/push/push_device_store.dart';
import 'package:rab_staff/core/push/push_registration_service.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';

import 'support/biometric_test_support.dart';

/// Phase C1b push registration, against a fake [PushMessaging] (no Firebase
/// credentials, no device): opt-in only, UUID device id, identity-fenced,
/// deactivated on sign-out (explicit call + `pushDeviceId` on /auth/logout).
class _FakeMessaging implements PushMessaging {
  bool supported = true;
  bool permitted = true;
  bool grantOnRequest = true;
  int prompts = 0;
  Completer<String?>? tokenGate;
  final tokenRefresh = StreamController<String>.broadcast();
  final activity = StreamController<PushActivity>.broadcast();

  @override
  Future<bool> initialize() async => supported;
  @override
  Future<bool> isPermitted() async => permitted;
  @override
  Future<bool> requestPermission() async {
    prompts++;
    permitted = grantOnRequest;
    return permitted;
  }

  @override
  Future<String?> getToken() => tokenGate?.future ?? Future.value('fcm-1');
  @override
  Stream<String> get onTokenRefresh => tokenRefresh.stream;
  @override
  Stream<PushActivity> get onActivity => activity.stream;
}

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> store;
  setUp(() {
    store = {'rab.accessToken': 'tok', 'rab.refreshToken': 'ref'};
    stubSecureStorageChannel(store);
  });
  tearDown(clearSecureStorageChannel);

  ({ApiClient api, List<http.Request> requests}) client({
    bool rejectPushDeviceId = false,
  }) {
    final requests = <http.Request>[];
    final api = ApiClient(
      httpClient: MockClient((request) async {
        requests.add(request);
        final path = request.url.path;
        if (path.endsWith('/auth/logout') &&
            rejectPushDeviceId &&
            (jsonDecode(request.body) as Map).containsKey('pushDeviceId')) {
          return http.Response(
            '{"message":["property pushDeviceId should not exist"]}',
            400,
          );
        }
        if (path.endsWith('/notifications')) return http.Response('[]', 200);
        if (path.endsWith('/notifications/unread-count')) {
          return http.Response('{"count":0}', 200);
        }
        return http.Response('{}', 200);
      }),
    );
    return (api: api, requests: requests);
  }

  Iterable<http.Request> registrations(List<http.Request> r) =>
      r.where((x) => x.url.path.endsWith('/push/devices'));

  test('already-permitted device registers a UUID for this session '
      '(no permission prompt)', () async {
    final c = client();
    final messaging = _FakeMessaging();
    final service = PushRegistrationService(api: c.api, messaging: messaging);
    addTearDown(service.dispose);
    await pumpEventQueue();
    final body = jsonDecode(registrations(c.requests).single.body) as Map;
    expect(body['deviceId'], matches(_uuid));
    expect(body['platform'], 'android');
    expect(body['pushToken'], 'fcm-1');
    expect(body.keys, unorderedEquals(['deviceId', 'platform', 'pushToken']));
    expect(messaging.prompts, 0);
    expect(c.api.pushDeviceIdForLogout, body['deviceId']);
  });

  test('no permission yet: nothing registered and no prompt until the '
      'explicit enable()', () async {
    final c = client();
    final messaging = _FakeMessaging()..permitted = false;
    final service = PushRegistrationService(api: c.api, messaging: messaging);
    addTearDown(service.dispose);
    await pumpEventQueue();
    expect(registrations(c.requests), isEmpty);
    expect(messaging.prompts, 0);
    expect(await service.enable(), isTrue);
    expect(messaging.prompts, 1);
    expect(registrations(c.requests), hasLength(1));
  });

  test('declined prompt: nothing registered', () async {
    final c = client();
    final messaging = _FakeMessaging()
      ..permitted = false
      ..grantOnRequest = false;
    final service = PushRegistrationService(api: c.api, messaging: messaging);
    addTearDown(service.dispose);
    expect(await service.enable(), isFalse);
    expect(registrations(c.requests), isEmpty);
  });

  test('unsupported host (not Android / Firebase not configured): never '
      'calls the backend', () async {
    final c = client();
    final service = PushRegistrationService(
      api: c.api,
      messaging: _FakeMessaging()..supported = false,
    );
    await pumpEventQueue();
    service.dispose();
    await pumpEventQueue();
    expect(c.requests.where((r) => r.url.path.contains('/push/')), isEmpty);
  });

  test(
    'the real Firebase adapter is a no-op off Android (test host)',
    () async {
      expect(await FirebasePushMessaging().initialize(), isFalse);
    },
  );

  test('account switch while registering: the old session never registers '
      'and the new one is never named', () async {
    final c = client();
    final messaging = _FakeMessaging()..tokenGate = Completer<String?>();
    final service = PushRegistrationService(api: c.api, messaging: messaging);
    addTearDown(service.dispose);
    await pumpEventQueue();
    await c.api.clearTokens(); // logout / account switch
    messaging.tokenGate!.complete('fcm-1');
    await pumpEventQueue();
    expect(registrations(c.requests), isEmpty);
    expect(c.api.pushDeviceIdForLogout, isNull);
    expect(service.registeredDeviceId, isNull);
  });

  test(
    'sign-out: dispose deactivates the device and /auth/logout names it',
    () async {
      final c = client();
      final service = PushRegistrationService(
        api: c.api,
        messaging: _FakeMessaging(),
      );
      await pumpEventQueue();
      final deviceId = service.registeredDeviceId!;
      // AuthProvider.logout order: the tree (and this service) goes first, then
      // /auth/logout, then the tokens are cleared.
      service.dispose();
      await c.api.post('/auth/logout', body: {'refreshToken': 'ref'});
      await c.api.clearTokens();
      await pumpEventQueue();
      expect(
        c.requests.map((r) => r.url.path),
        contains(endsWith('/push/devices/$deviceId/deactivate')),
      );
      final logout = c.requests.lastWhere(
        (r) => r.url.path.endsWith('/auth/logout'),
      );
      expect(jsonDecode(logout.body), {
        'refreshToken': 'ref',
        'pushDeviceId': deviceId,
      });
      expect(c.api.pushDeviceIdForLogout, isNull);
    },
  );

  test('a server without pushDeviceId (400) gets the plain logout body once '
      'more', () async {
    final c = client(rejectPushDeviceId: true);
    c.api.pushDeviceIdForLogout = PushDeviceStore.generateUuidV4();
    await c.api.post('/auth/logout', body: {'refreshToken': 'ref'});
    final logouts = c.requests
        .where((r) => r.url.path.endsWith('/auth/logout'))
        .map((r) => jsonDecode(r.body))
        .toList();
    expect(logouts, hasLength(2));
    expect((logouts.first as Map).containsKey('pushDeviceId'), isTrue);
    expect(logouts.last, {'refreshToken': 'ref'});
  });

  test('no registration: logout body unchanged, no deactivate', () async {
    final c = client();
    final service = PushRegistrationService(
      api: c.api,
      messaging: _FakeMessaging()..permitted = false,
    );
    await pumpEventQueue();
    service.dispose();
    await c.api.post('/auth/logout', body: {'refreshToken': 'ref'});
    await pumpEventQueue();
    expect(
      c.requests.where((r) => r.url.path.contains('/deactivate')),
      isEmpty,
    );
    expect(
      jsonDecode(
        c.requests.lastWhere((r) => r.url.path.endsWith('/auth/logout')).body,
      ),
      {'refreshToken': 'ref'},
    );
  });

  test('a notification (arrival or tap) only refetches: the list and the '
      'reconcile callback', () async {
    final c = client();
    final messaging = _FakeMessaging();
    final notifications = NotificationsProvider(c.api);
    var reconciles = 0;
    final service = PushRegistrationService(
      api: c.api,
      messaging: messaging,
      notifications: notifications,
      onActivity: ({required bool background}) => reconciles++,
    );
    addTearDown(() {
      service.dispose();
      notifications.dispose();
    });
    await pumpEventQueue();
    c.requests.clear();
    messaging.activity.add(PushActivity.opened);
    await pumpEventQueue();
    expect(reconciles, 1);
    expect(c.requests.map((r) => r.url.path), [endsWith('/notifications')]);
  });

  test('F3: a push ARRIVAL refetches as background traffic only (it must '
      'not slide the idle window of an unattended app)', () async {
    final c = client();
    final messaging = _FakeMessaging();
    final notifications = NotificationsProvider(c.api);
    final service = PushRegistrationService(
      api: c.api,
      messaging: messaging,
      notifications: notifications,
    );
    addTearDown(() {
      service.dispose();
      notifications.dispose();
    });
    await pumpEventQueue();
    c.requests.clear();
    messaging.activity.add(PushActivity.arrived);
    await pumpEventQueue();
    final list = c.requests.singleWhere(
      (r) => r.url.path.endsWith('/notifications'),
    );
    expect(list.headers[kBackgroundRequestHeader], '1');
  });

  test('F3: a notification TAP is user activity: foreground refetch', () async {
    final c = client();
    final messaging = _FakeMessaging();
    final notifications = NotificationsProvider(c.api);
    final backgrounds = <bool>[];
    final service = PushRegistrationService(
      api: c.api,
      messaging: messaging,
      notifications: notifications,
      onActivity: ({required bool background}) => backgrounds.add(background),
    );
    addTearDown(() {
      service.dispose();
      notifications.dispose();
    });
    await pumpEventQueue();
    c.requests.clear();
    messaging.activity.add(PushActivity.opened);
    await pumpEventQueue();
    final list = c.requests.singleWhere(
      (r) => r.url.path.endsWith('/notifications'),
    );
    expect(list.headers[kBackgroundRequestHeader], isNull);
    messaging.activity.add(PushActivity.arrived);
    await pumpEventQueue();
    expect(backgrounds, [false, true]);
  });
}

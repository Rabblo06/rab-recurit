import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';

/// Increment 1 (Auth Foundation) of the Staff mobile rebuild — covers login,
/// session restore, and logout against a mocked HTTP layer (no real
/// server). `ApiClient`/`AuthProvider` both gained an optional
/// constructor-injection param purely to make this possible; production
/// call sites (`main.dart`) are unaffected.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  late Map<String, String> secureStore;

  setUp(() {
    secureStore = {};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      final args = call.arguments is Map ? call.arguments as Map : const {};
      switch (call.method) {
        case 'write':
          secureStore[args['key'] as String] = args['value'] as String;
          return null;
        case 'read':
          return secureStore[args['key'] as String];
        case 'delete':
          secureStore.remove(args['key'] as String);
          return null;
        case 'containsKey':
          return secureStore.containsKey(args['key'] as String);
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  Map<String, dynamic> currentUserJson({String id = 'user-1', String email = 'alice@example.test'}) => {
        'id': id,
        'email': email,
        'firstName': 'Alice',
        'lastName': 'Example',
        'organisationId': 'org-1',
        'roles': ['staff'],
        'mustResetPassword': false,
      };

  /// `AuthProvider`'s constructor fires `_restore()` without returning a
  /// Future — this waits for the `isReady` flag it eventually sets, the
  /// same signal `_RootGate` watches to leave its loading spinner.
  Future<void> waitUntilReady(AuthProvider auth) async {
    if (auth.isReady) return;
    final completer = Completer<void>();
    void listener() {
      if (auth.isReady) completer.complete();
    }

    auth.addListener(listener);
    await completer.future;
    auth.removeListener(listener);
  }

  test('successful login authenticates with the correct user', () async {
    final mockClient = MockClient((request) async {
      if (request.url.path.endsWith('/auth/login')) {
        return http.Response(jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}), 200);
      }
      if (request.url.path.endsWith('/auth/me')) {
        return http.Response(jsonEncode(currentUserJson(id: 'user-1', email: 'alice@example.test')), 200);
      }
      return http.Response('not found', 404);
    });

    final auth = AuthProvider(apiClient: ApiClient(httpClient: mockClient));
    await waitUntilReady(auth);
    expect(auth.isAuthenticated, isFalse);

    await auth.login('alice@example.test', 'password123');

    expect(auth.isAuthenticated, isTrue);
    expect(auth.user!.id, 'user-1');
    expect(auth.user!.email, 'alice@example.test');
  });

  test('failed login (401) leaves the session unauthenticated and throws ApiException', () async {
    final mockClient = MockClient((request) async {
      if (request.url.path.endsWith('/auth/login')) {
        return http.Response(jsonEncode({'message': 'Invalid email or password.'}), 401);
      }
      return http.Response('not found', 404);
    });

    final auth = AuthProvider(apiClient: ApiClient(httpClient: mockClient));
    await waitUntilReady(auth);

    await expectLater(
      auth.login('bob@example.test', 'wrong-password'),
      throwsA(isA<ApiException>()),
    );
    expect(auth.isAuthenticated, isFalse);
  });

  test('session restore with a stored token resolves to authenticated without a fresh login call', () async {
    secureStore['rab.accessToken'] = 'stored-access';
    secureStore['rab.refreshToken'] = 'stored-refresh';
    var loginCalls = 0;
    final mockClient = MockClient((request) async {
      if (request.url.path.endsWith('/auth/login')) {
        loginCalls++;
        return http.Response('{}', 200);
      }
      if (request.url.path.endsWith('/auth/me')) {
        return http.Response(jsonEncode(currentUserJson(id: 'user-2')), 200);
      }
      return http.Response('not found', 404);
    });

    final auth = AuthProvider(apiClient: ApiClient(httpClient: mockClient));
    await waitUntilReady(auth);

    expect(auth.isAuthenticated, isTrue);
    expect(auth.user!.id, 'user-2');
    expect(loginCalls, 0);
  });

  test('session restore where /auth/me rejects the token ends unauthenticated and clears stored tokens', () async {
    secureStore['rab.accessToken'] = 'stale-access';
    secureStore['rab.refreshToken'] = 'stale-refresh';
    final mockClient = MockClient((request) async {
      if (request.url.path.endsWith('/auth/me')) {
        return http.Response(jsonEncode({'message': 'expired'}), 401);
      }
      return http.Response('not found', 404);
    });

    final auth = AuthProvider(apiClient: ApiClient(httpClient: mockClient));
    await waitUntilReady(auth);

    expect(auth.isAuthenticated, isFalse);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);
    expect(secureStore.containsKey('rab.refreshToken'), isFalse);
  });

  test('logout revokes the refresh-token family server-side and clears the local session', () async {
    http.Request? logoutRequest;
    final mockClient = MockClient((request) async {
      if (request.url.path.endsWith('/auth/login')) {
        return http.Response(jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}), 200);
      }
      if (request.url.path.endsWith('/auth/me')) {
        return http.Response(jsonEncode(currentUserJson()), 200);
      }
      if (request.url.path.endsWith('/auth/logout')) {
        logoutRequest = request;
        return http.Response('', 200);
      }
      return http.Response('not found', 404);
    });

    final auth = AuthProvider(apiClient: ApiClient(httpClient: mockClient));
    await waitUntilReady(auth);
    await auth.login('alice@example.test', 'password123');
    expect(auth.isAuthenticated, isTrue);

    await auth.logout();

    expect(auth.isAuthenticated, isFalse);
    expect(auth.user, isNull);
    expect(logoutRequest, isNotNull);
    expect((jsonDecode(logoutRequest!.body) as Map)['refreshToken'], 'refresh-1');
    expect(secureStore.containsKey('rab.accessToken'), isFalse);
    expect(secureStore.containsKey('rab.refreshToken'), isFalse);
  });
}

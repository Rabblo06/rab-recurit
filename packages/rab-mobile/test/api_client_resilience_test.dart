import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';

/// CF-36 / CF-19 (October 15 audit): a stale 401 from the previous account must never wipe (or rotate) the next
/// account's session; a hung or failing network must never end the session either.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  late Map<String, String> secureStore;
  final writes = <String>[];

  setUp(() {
    secureStore = {};
    writes.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      final args = call.arguments is Map ? call.arguments as Map : const {};
      switch (call.method) {
        case 'write':
          writes.add(args['key'] as String);
          secureStore[args['key'] as String] = args['value'] as String;
          return null;
        case 'read':
          return secureStore[args['key'] as String];
        case 'delete':
          secureStore.remove(args['key'] as String);
          return null;
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  test('CF-36: a 401 for account A that arrives after B signed in neither refreshes nor clears B’s session', () async {
    final gate = Completer<void>();
    var refreshCalls = 0;
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/auth/refresh')) {
        refreshCalls++;
        return http.Response('{}', 401);
      }
      await gate.future; // A's request is slow…
      return http.Response(jsonEncode({'message': 'expired'}), 401);
    });
    final api = ApiClient(httpClient: client);
    await api.storeTokens('access-A', 'refresh-A');
    final aRequest = api.get('/shifts');
    // …meanwhile A signs out and B signs in on the same phone.
    await api.clearTokens();
    await api.storeTokens('access-B', 'refresh-B');
    gate.complete();
    await expectLater(aRequest, throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 401)));
    expect(refreshCalls, 0);
    expect(await api.getAccessToken(), 'access-B');
    expect(await api.getRefreshToken(), 'refresh-B');
  });

  test('CF-19 / CF-17: a refresh answered with 503 (rate-limit store down) keeps the tokens', () async {
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/auth/refresh')) return http.Response(jsonEncode({'code': 'RATE_LIMIT_UNAVAILABLE'}), 503);
      return http.Response('{}', 401);
    });
    final api = ApiClient(httpClient: client);
    await api.storeTokens('access-1', 'refresh-1');
    await expectLater(api.post('/attendance/clock-out', body: {}), throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 503)));
    expect(await api.getRefreshToken(), 'refresh-1');
    expect(await api.getAccessToken(), 'access-1');
  });

  test('CF-19: the rotated refresh token is written before the access token', () async {
    final api = ApiClient(httpClient: MockClient((_) async => http.Response('{}', 200)));
    await api.storeTokens('access-2', 'refresh-2');
    final relevant = writes.where((k) => k.contains('Token') || k.contains('token')).toList();
    expect(relevant.length, 2);
    expect(relevant.first.toLowerCase(), contains('refresh'));
  });

  test('CF-19: request and refresh timeouts are bounded', () {
    expect(ApiClient.requestTimeout, lessThanOrEqualTo(const Duration(seconds: 30)));
    expect(ApiClient.refreshTimeout, lessThanOrEqualTo(const Duration(seconds: 30)));
  });
}

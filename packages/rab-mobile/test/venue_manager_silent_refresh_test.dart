import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

import 'support/biometric_test_support.dart';

/// Mirrors `AttendanceProvider`'s own `silent` regression tests (and the web
/// Users-table fix both are modelled on): `VenueManagerProvider.refresh()`
/// unconditionally set `loading = true` on every call, including the 5s
/// Sent Shifts poll and the app-resume refresh — both of which already have
/// good data on screen. A real first load or a user-initiated action must
/// still show loading as before.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;
  setUp(() {
    secureStore = {};
    stubSecureStorageChannel(secureStore);
  });
  tearDown(clearSecureStorageChannel);

  MockClient emptyScheduleClient() => MockClient((request) async {
    final path = request.url.path;
    if (path.endsWith('/auth/capabilities')) {
      return http.Response(
        jsonEncode({'schedule.view': true, 'venue.view': true}),
        200,
      );
    }
    if (path.endsWith('/shifts') ||
        path.endsWith('/venues') ||
        path.endsWith('/job-roles') ||
        path.endsWith('/offers') ||
        path.endsWith('/shifts/sent')) {
      return http.Response(jsonEncode(<dynamic>[]), 200);
    }
    return http.Response('not found', 404);
  });

  test('refresh(silent: true) never sets loading', () async {
    final provider = VenueManagerProvider(
      ApiClient(httpClient: emptyScheduleClient()),
      'user-1',
    );
    await provider.refresh(); // settle the constructor's implicit `loading: true` start
    expect(provider.loading, isFalse);

    final refreshFuture = provider.refresh(silent: true);
    // Dart's async functions run synchronously up to their first `await` —
    // this is already past the point where a non-silent call would have set
    // `loading = true`.
    expect(provider.loading, isFalse);
    await refreshFuture;
    expect(provider.loading, isFalse);
  });

  test(
    'a non-silent refresh() still shows loading immediately (default behaviour preserved)',
    () async {
      final provider = VenueManagerProvider(
        ApiClient(httpClient: emptyScheduleClient()),
        'user-1',
      );
      await provider.refresh();
      expect(provider.loading, isFalse);

      final refreshFuture = provider.refresh();
      expect(provider.loading, isTrue);
      await refreshFuture;
      expect(provider.loading, isFalse);
    },
  );
}

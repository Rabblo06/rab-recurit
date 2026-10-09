import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/api/api_client.dart';

/// Development safety for the API base URL. A development or QA build must never reach the production API by accident:
/// profile and release builds need an explicit API_URL, and nothing falls back to a production host.
void main() {
  const productionApi = 'https://api.rabworkspaceteams.co.uk/rest/v1';

  group('debug builds (development)', () {
    test('Android emulator uses the host loopback alias when no API_URL is set', () {
      expect(
        ApiClient.resolveBaseUrl(override: '', production: false, android: true),
        'http://10.0.2.2:3000/rest/v1',
      );
    });

    test('other debug targets use localhost when no API_URL is set', () {
      expect(
        ApiClient.resolveBaseUrl(override: '', production: false, android: false),
        'http://localhost:3000/rest/v1',
      );
    });

    test('an explicit local API_URL is used as given', () {
      expect(
        ApiClient.resolveBaseUrl(override: 'http://localhost:3000/rest/v1', production: false, android: true),
        'http://localhost:3000/rest/v1',
      );
    });
  });

  group('profile and release builds (production)', () {
    test('a missing API_URL throws and never returns the production host', () {
      for (final android in [true, false]) {
        expect(
          () => ApiClient.resolveBaseUrl(override: '', production: true, android: android),
          throwsA(
            isA<StateError>().having((e) => e.message, 'message', allOf(contains('API_URL is required'), isNot(contains(productionApi)))),
          ),
        );
      }
    });

    test('a whitespace-only API_URL is treated as missing', () {
      expect(
        () => ApiClient.resolveBaseUrl(override: '   ', production: true, android: false),
        throwsA(isA<StateError>()),
      );
    });

    test('an explicit production API_URL is used, with trailing slashes removed', () {
      expect(
        ApiClient.resolveBaseUrl(override: '$productionApi/', production: true, android: false),
        productionApi,
      );
    });

    test('an explicit LAN API_URL is used for a physical device profile build', () {
      expect(
        ApiClient.resolveBaseUrl(override: 'http://192.168.1.20:3000/rest/v1', production: true, android: true),
        'http://192.168.1.20:3000/rest/v1',
      );
    });
  });

  test('an explicit endpoint keeps its path and drops surrounding spaces and trailing slashes', () {
    expect(
      ApiClient.resolveBaseUrl(override: ' https://api.rabworkspaceteams.co.uk/rest/v1/ ', production: false, android: true),
      productionApi,
    );
  });
}

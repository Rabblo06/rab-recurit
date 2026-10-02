import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/api/api_client.dart';

void main() {
  test('profile and release default to public versioned HTTPS API', () {
    for (final android in [true, false]) {
      expect(
        ApiClient.resolveBaseUrl(
          override: '',
          production: true,
          android: android,
        ),
        'https://api.rabworkspaceteams.co.uk/rest/v1',
      );
    }
  });
  test('debug keeps existing local development endpoints', () {
    expect(
      ApiClient.resolveBaseUrl(override: '', production: false, android: true),
      'http://10.0.2.2:3000/rest/v1',
    );
    expect(
      ApiClient.resolveBaseUrl(override: '', production: false, android: false),
      'http://localhost:3000/rest/v1',
    );
  });
  test(
    'explicit phone endpoint is preserved without duplicate prefix or slash',
    () {
      expect(
        ApiClient.resolveBaseUrl(
          override: ' https://api.rabworkspaceteams.co.uk/rest/v1/ ',
          production: false,
          android: true,
        ),
        'https://api.rabworkspaceteams.co.uk/rest/v1',
      );
    },
  );
}

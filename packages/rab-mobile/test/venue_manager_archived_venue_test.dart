import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

import 'support/biometric_test_support.dart';

/// Wave 5: `GET /venues` hides archived venues unless `includeArchived=true`.
/// The Venue Manager app resolves the venue NAME of every shift through that
/// list, so a historical shift at an archived venue used to show "Venue
/// unavailable". The provider must ask for archived venues too, use them for
/// names only, and never offer them for new work.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;
  setUp(() {
    secureStore = {};
    stubSecureStorageChannel(secureStore);
  });
  tearDown(clearSecureStorageChannel);

  final venueQueries = <Map<String, String>>[];

  /// Mimics the server's list rule: archived rows only with includeArchived=true.
  MockClient client() => MockClient((request) async {
    final path = request.url.path;
    Object body;
    if (path.endsWith('/auth/capabilities')) {
      body = {'schedule.view': true, 'venue.view': true};
    } else if (path.endsWith('/venues')) {
      venueQueries.add(request.url.queryParameters);
      final includeArchived =
          request.url.queryParameters['includeArchived'] == 'true';
      final rows = [
        {'id': 'venue-live', 'name': 'Riverside Hotel', 'status': 'active'},
        if (includeArchived)
          {
            'id': 'venue-archived',
            'name': 'Old Pier Bar',
            'status': 'archived',
            'archivedAt': '2026-10-01T09:00:00.000Z',
          },
        // Archived before wave 5: status only, no archivedAt.
        if (includeArchived)
          {'id': 'venue-legacy', 'name': 'Harbour Inn', 'status': 'archived'},
      ];
      body = {'data': rows, 'total': rows.length};
    } else if (path.endsWith('/shifts/sent')) {
      body = {'data': <dynamic>[], 'total': 0, 'counts': <String, int>{}};
    } else if (path.endsWith('/shifts')) {
      body = {
        'data': [
          for (final (id, venueId) in [
            ('shift-1', 'venue-archived'),
            ('shift-2', 'venue-live'),
            ('shift-3', 'venue-legacy'),
          ])
            {
              'id': id,
              'venueId': venueId,
              'jobRoleId': 'role-1',
              'status': 'completed',
              'startsAt': '2026-09-0${id.substring(6)}T18:00:00.000Z',
              'endsAt': '2026-09-0${id.substring(6)}T23:00:00.000Z',
              'requiredCount': 1,
              'filledCount': 1,
            },
        ],
        'total': 3,
      };
    } else if (path.endsWith('/job-roles')) {
      body = [
        {'id': 'role-1', 'name': 'Bartender'},
      ];
    } else if (path.endsWith('/offers')) {
      body = {'data': <dynamic>[], 'total': 0};
    } else {
      return http.Response('not found', 404);
    }
    return http.Response(jsonEncode(body), 200);
  });

  test(
    'archived venues still name historical shifts but are never offered as venues for new work',
    () async {
      venueQueries.clear();
      final provider = VenueManagerProvider(
        ApiClient(httpClient: client()),
        'user-1',
      );
      await provider.refresh();

      expect(provider.error, isNull);
      expect(venueQueries, isNotEmpty);
      expect(
        venueQueries.every((q) => q['includeArchived'] == 'true'),
        isTrue,
        reason: 'the provider must request archived venues for name lookup',
      );

      final namesByShift = {
        for (final e in provider.events) e.shiftId: e.venue,
      };
      expect(namesByShift, {
        'shift-1': 'Old Pier Bar',
        'shift-2': 'Riverside Hotel',
        'shift-3': 'Harbour Inn',
      });
      expect(
        provider.events.map((e) => e.venue),
        isNot(contains('Venue unavailable')),
      );

      // Pickers / the assigned-venues list only ever see live venues.
      expect(provider.venues.map((v) => v['id']), ['venue-live']);
    },
  );

  test('isArchivedVenue: status or archivedAt marks a venue archived', () {
    expect(isArchivedVenue({'status': 'active'}), isFalse);
    expect(isArchivedVenue({'status': 'archived'}), isTrue);
    expect(
      isArchivedVenue({'status': 'active', 'archivedAt': '2026-10-01'}),
      isTrue,
    );
  });
}

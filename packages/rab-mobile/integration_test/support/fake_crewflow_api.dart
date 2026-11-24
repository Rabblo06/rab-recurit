import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// A CI-local stand-in for the Crewflow API, served over real HTTP on the
/// device's own loopback interface. The app under test talks to it through
/// its normal `ApiClient` (real sockets, real JSON, real headers), pointed at
/// it with `--dart-define=API_URL=http://localhost:<port>/rest/v1` (debug
/// builds allow cleartext to `localhost` only; see
/// android/app/src/debug/res/xml/network_security_config.xml).
///
/// It never forwards anything anywhere: there is no production (or any other)
/// backend behind it. Responses follow the shapes the server's contract tests
/// pin (packages/rab-server/src/__tests__/contract/openapi/contract-responses.ts
/// and openapi-contract.integration.spec.ts on the server side).
class FakeCrewflowApi {
  FakeCrewflowApi._(this._server, this.staffEmail, this.staffPassword);

  /// The port the integration tests use; CI passes the matching API_URL.
  static const defaultPort = 38917;

  final HttpServer _server;
  final String staffEmail;
  final String staffPassword;

  /// Every request the app made, as `METHOD /path` (query string dropped).
  final List<String> requests = [];

  /// Requests this fake has no answer for (answered 404, like a missing route).
  final List<String> unhandled = [];

  static const accessToken = 'it-access-token';
  static const refreshToken = 'it-refresh-token';
  static const venueName = 'The Grand Hall';
  static const venueAddress = '1 Trafalgar Square, London';
  static const roleName = 'Bartender';
  static const shiftNotes = 'Black shirt, report to the cellar door.';
  static const shiftId = '6f1c7a2e-1b9d-4c3a-9e8f-2a4b6c8d0e1f';
  static const offerId = '0b7e9d4c-3a2f-4e1d-8c5b-7a9e1f3d5b2c';
  static const userId = '4d2c8b6a-9e1f-4a3b-8c7d-5e6f7a8b9c0d';
  static const organisationId = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
  static const staffProfileId = '2e4f6a8b-0c1d-4e3f-8a5b-7c9d1e3f5a7b';

  static Future<FakeCrewflowApi> start({
    int port = defaultPort,
    required String staffEmail,
    required String staffPassword,
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port, shared: true);
    final api = FakeCrewflowApi._(server, staffEmail, staffPassword);
    server.listen(api._handle);
    return api;
  }

  Future<void> close() => _server.close(force: true);

  String _iso(DateTime d) => d.toUtc().toIso8601String();

  /// A shift today that the manager has confirmed: starts in two hours, so it
  /// is "Today's Shift" on the home screen and not yet clockable.
  Map<String, dynamic> _todaysConfirmedOffer() {
    final now = DateTime.now().toUtc();
    final start = now.add(const Duration(hours: 2));
    final end = start.add(const Duration(hours: 6));
    return {
      'id': offerId,
      'status': 'manager_confirmed',
      'sentAt': _iso(now.subtract(const Duration(days: 2))),
      'expiresAt': _iso(now.subtract(const Duration(days: 1))),
      'respondedAt': _iso(now.subtract(const Duration(days: 2))),
      'declineReason': null,
      'staffAcceptedAt': _iso(now.subtract(const Duration(days: 2))),
      'managerConfirmedAt': _iso(now.subtract(const Duration(days: 1))),
      'managerRejectedAt': null,
      'rejectionReason': null,
      'estimatedPayPence': 8700,
      'shiftId': shiftId,
      'startsAt': _iso(start),
      'endsAt': _iso(end),
      'venueName': venueName,
      'roleName': roleName,
      'staffProfileId': staffProfileId,
      'staffName': 'Sam Shaker',
      'payRatePence': 1450,
      'venueAddress': venueAddress,
      'shiftNotes': shiftNotes,
      'venuePhotoFileId': null,
      'presentation': {
        'state': 'confirmed',
        'homeLabel': "Today's Shift",
        'isToday': true,
        'serverNow': _iso(now),
        'clockInAt': null,
        'nextTransitionAt': _iso(start.subtract(const Duration(minutes: 15))),
        'closedReason': null,
        'canAccept': false,
      },
      'checkInRequired': false,
      'checkedInAt': null,
      'checkInSource': null,
      'geofenceEnforced': false,
      'approvalDeadlineAt': null,
      'awaitingManagerConfirmation': false,
      'closedReason': null,
      'canAccept': false,
    };
  }

  Map<String, dynamic> _me() => {
    'id': userId,
    'email': staffEmail,
    'firstName': 'Sam',
    'lastName': 'Shaker',
    'organisationId': organisationId,
    'roles': ['staff'],
    'mustResetPassword': false,
    'isPlatformAdmin': false,
  };

  /// `null` = no route here (404).
  Object? _answer(String method, String path, Map<String, String> query, Object? body) {
    final page = query.containsKey('limit') || query.containsKey('cursor');
    switch ('$method $path') {
      case 'POST /rest/v1/auth/login':
        final credentials = body is Map ? body : const {};
        if (credentials['email'] != staffEmail || credentials['password'] != staffPassword) {
          return const _Status(401, {'statusCode': 401, 'message': 'Invalid email or password.'});
        }
        return {'accessToken': accessToken, 'refreshToken': refreshToken};
      case 'POST /rest/v1/auth/logout':
        return const _Status(204, null);
      case 'GET /rest/v1/auth/me':
        return _me();
      case 'GET /rest/v1/auth/capabilities':
        return {'offer.respond': true, 'payslip.view_own': true, 'attendance.clock': true};
      case 'GET /rest/v1/offers/mine':
        final rows = [_todaysConfirmedOffer()];
        return page ? {'data': rows, 'nextCursor': null} : rows;
      case 'GET /rest/v1/attendance/me/active':
        return {
          'attendance': null,
          'serverNow': _iso(DateTime.now()),
          'clockInEarlyMinutes': 15,
          'locationEvidence': {'maxAccuracyM': 100, 'maxAgeSeconds': 120, 'maxFutureSkewSeconds': 30},
        };
      case 'GET /rest/v1/attendance/me/history':
        return page ? {'data': <Object>[], 'nextCursor': null} : <Object>[];
      case 'GET /rest/v1/notifications':
        return <Object>[];
      case 'GET /rest/v1/notifications/unread-count':
        return {'count': 0};
      case 'GET /rest/v1/payroll/me/payslips':
        return {'data': <Object>[], 'unallocated': {'shiftCount': 0, 'grossPence': 0}};
      case 'GET /rest/v1/payroll/me/statements':
        return page ? {'data': <Object>[], 'nextCursor': null} : <Object>[];
      case 'GET /rest/v1/realtime/stream':
        return const _Status(204, null); // REALTIME_ENABLED=false: the client stops after this one request
    }
    if (method == 'GET' && path == '/rest/v1/attendance/me/shift/$shiftId/check-in') {
      return {
        'shiftId': shiftId,
        'checkInRequired': false,
        'checkedInAt': null,
        'checkInSource': null,
        'locationVerified': false,
        'geofenceEnforced': false,
        'clockedIn': false,
        'alreadyCheckedIn': false,
        'serverNow': _iso(DateTime.now()),
      };
    }
    if (method == 'GET' && path == '/rest/v1/attendance/me/shift/$shiftId/team') {
      return {'data': <Object>[]};
    }
    return null;
  }

  Future<void> _handle(HttpRequest request) async {
    final path = request.uri.path;
    final key = '${request.method} $path';
    requests.add(key);
    final raw = await utf8.decodeStream(request);
    Object? body;
    if (raw.isNotEmpty) {
      try {
        body = jsonDecode(raw);
      } on FormatException {
        body = raw;
      }
    }
    final authorised = request.headers.value(HttpHeaders.authorizationHeader) == 'Bearer $accessToken';
    final public = key == 'POST /rest/v1/auth/login';
    Object? answer;
    if (!public && !authorised) {
      answer = const _Status(401, {'statusCode': 401, 'message': 'Please sign in again.'});
    } else {
      answer = _answer(request.method, path, request.uri.queryParameters, body);
      if (answer == null) {
        unhandled.add(key);
        answer = const _Status(404, {'statusCode': 404, 'message': 'Not found.'});
      }
    }
    final status = answer is _Status ? answer.code : 200;
    final payload = answer is _Status ? answer.body : answer;
    request.response.statusCode = status;
    if (payload != null) {
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(payload));
    }
    await request.response.close();
  }
}

class _Status {
  const _Status(this.code, this.body);
  final int code;
  final Object? body;
}

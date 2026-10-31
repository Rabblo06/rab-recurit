import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform, HttpDate, SocketException, HandshakeException;

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../storage/secure_storage.dart';

/// Account security step 1 (P3): what this build can complete during sign-in, sent on EVERY request. `mfa-verify`
/// = the two-factor code step exists (login_sheet_content.dart). The server answers an older build (no header) with
/// 409 CLIENT_UPDATE_REQUIRED instead of a challenge it could not finish. Client-asserted and never a credential: it can
/// only enable the challenge path, never skip it.
const kClientCapabilitiesHeader = 'X-Client-Capabilities';
const kClientCapabilities = 'mfa-verify';

/// Marks a timer- or background-driven request (polling). The server still fully authenticates it but does not slide
/// the session's idle window, so an unattended open app cannot keep a session alive forever. User-initiated requests
/// (taps, pull-to-refresh, the refresh on app resume) never send it. Mirrors iOS `RequestOptions.backgroundPoll`.
const kBackgroundRequestHeader = 'X-Crewflow-Background';

class ApiException implements Exception {
  final int statusCode;
  final String message;
  final int? retryAfterSeconds;

  /// The server's own `Retry-After` on a 429 (seconds or HTTP date), or null when it sent none. Unlike
  /// [retryAfterSeconds] (which falls back to 60 s for the message text) this is never a guess: pollers use their own
  /// default when it is absent.
  final Duration? retryAfter;

  /// The decoded JSON error body, when the response was structured JSON
  /// (e.g. `{code: 'CLOCK_IN_TOO_EARLY', shiftStart, availableAt}` from
  /// AttendanceService) — lets a caller branch on `code` for a tailored UI
  /// instead of pattern-matching the human-readable `message` string.
  final Map<String, dynamic>? body;

  ApiException(
    this.statusCode,
    this.message, {
    this.retryAfterSeconds,
    this.retryAfter,
    this.body,
  });

  /// The structured error `code`, if the backend sent one — null for a
  /// plain `{message}` error or a non-JSON body.
  String? get code => body?['code'] as String?;

  /// Friendly text for the UI. The server's own domain message is kept when
  /// it reads as user-facing (e.g. "This shift is not confirmed for you.");
  /// anything technical (HTTP reason phrases, identifiers, SQL, stack text)
  /// is replaced by a status-specific message. 5xx never shows server text.
  String get userMessage {
    final server = isUserFacingMessage(message) ? message.trim() : null;
    return switch (statusCode) {
      0 => ApiMessages.offline,
      // Client-authored session texts ("Your session changed …") are precise.
      401 =>
        message.startsWith('Your session')
            ? message
            : ApiMessages.sessionExpired,
      403 => server ?? ApiMessages.forbidden,
      404 => server ?? ApiMessages.notFound,
      // 408 and 429 messages are authored by ApiClient itself, never the server.
      408 => server ?? ApiMessages.timeout,
      409 => server ?? ApiMessages.conflict,
      429 => server ?? ApiMessages.tooManyRequests,
      >= 500 => ApiMessages.serverError,
      _ => server ?? ApiMessages.serverError,
    };
  }

  @override
  String toString() => message;
}

/// The one place API failures become user-facing text.
abstract final class ApiMessages {
  static const offline = 'Connection lost. Check your internet connection.';
  static const timeout =
      'The connection timed out. Check your connection and try again.';
  static const sessionExpired =
      'Your session has expired. Please sign in again.';
  static const forbidden = "You don't have permission to do that.";
  static const notFound =
      'This item could not be found. It may have been removed.';
  static const conflict =
      'This has changed since it was loaded. Refresh and try again.';
  static const tooManyRequests =
      'Too many requests. Please wait a moment and try again.';
  static const serverError = 'Something went wrong. Please try again.';
}

final _technical = RegExp(
  r'exception|error:|stack|\bat [\w$.<>]+ ?\(|\bsql\b|relation "|column "|'
  r'violates|constraint|syntax|econn|undefined|\bnull\b|\bnan\b|<html|'
  r'<!doctype|cannot (get|post|put|patch|delete) /|should not exist|'
  r'\buuid\b|\bjwt\b|iso-8601|[{}\[\]]|'
  r'^(internal server error|bad request|not found|forbidden( resource)?|'
  r'unauthorized|conflict|too many requests|unprocessable entity|'
  r'service unavailable|bad gateway|gateway timeout|not acceptable)\.?$',
  caseSensitive: false,
);
// camelCase / snake_case identifiers leak from validators and internal codes.
final _identifier = RegExp(r'\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b');

/// True when a server message is plain domain text a person can act on.
bool isUserFacingMessage(String message) {
  final text = message.trim();
  return text.length >= 4 &&
      text.length <= 240 &&
      !_technical.hasMatch(text) &&
      !_identifier.hasMatch(text);
}

/// Friendly text for any error caught around an API call: [ApiException]
/// via [ApiException.userMessage], lost connectivity (socket, TLS, client or
/// timeout failures) as [ApiMessages.offline], anything else as [fallback].
String userMessageFor(Object error, {String? fallback}) {
  if (error is ApiException) return error.userMessage;
  if (error is SocketException ||
      error is HandshakeException ||
      error is http.ClientException) {
    return ApiMessages.offline;
  }
  if (error is TimeoutException) return ApiMessages.timeout;
  return fallback ?? ApiMessages.serverError;
}

/// The shortest wait any `Retry-After` may produce: a 0, negative or past
/// value must never become an immediate retry (a retry storm).
const minRetryAfter = Duration(seconds: 1);

/// A `Retry-After` header (delta seconds or HTTP date) as a wait of at least
/// [minRetryAfter], or null when absent or unreadable.
Duration? parseRetryAfter(String? header, {DateTime? now}) {
  final value = header?.trim();
  if (value == null || value.isEmpty) return null;
  final seconds = int.tryParse(value);
  if (seconds != null) return Duration(seconds: seconds < 1 ? 1 : seconds);
  try {
    final wait = HttpDate.parse(value).difference(now ?? DateTime.now());
    return Duration(
      seconds: (wait.inMilliseconds / 1000).ceil().clamp(1, 1 << 31),
    );
  } catch (_) {
    return null;
  }
}

/// Thin REST client mirroring `rab-front/src/api.ts` and the Expo build's
/// `rab-mobile/src/api/client.ts` this replaces: bearer token attached per
/// request, single-flight refresh-on-401 (concurrent 401s share one
/// `/auth/refresh` call instead of each racing to rotate the same refresh
/// token — a second rotation is reuse-detected and revokes the whole
/// session, see rab-workforce-architecture.md §8.1), tokens in
/// `flutter_secure_storage` rather than anything readable by other apps.
class ApiClient {
  // Discard the obsolete manual app preference; sessions are server-derived.
  Future<void> clearLegacyApplicationPreference() =>
      _storage.delete(key: 'rab.applicationTarget');

  static const _accessTokenKey = 'rab.accessToken';
  static const _refreshTokenKey = 'rab.refreshToken';

  /// Accepts an injected [http.Client] so tests can substitute
  /// `http.testing.MockClient` — production call sites never pass one (nor a
  /// [storage]; the default is the shared, device-only [appSecureStorage]).
  ApiClient({http.Client? httpClient, FlutterSecureStorage? storage})
    : _http = httpClient ?? http.Client(),
      _storage = storage ?? appSecureStorage;

  final http.Client _http;

  /// CF-19: upper bounds for one API request and for one token refresh.
  static const Duration requestTimeout = Duration(seconds: 30);
  static const Duration refreshTimeout = Duration(seconds: 20);
  final FlutterSecureStorage _storage;

  /// Set after construction (the callback usually needs `this` from
  /// whoever owns the client, e.g. `AuthProvider`, which can't be passed
  /// into its own field initializer).
  VoidCallback? onSessionExpired;
  Future<bool>? _refreshInFlight;
  int _tokenGeneration = 0;

  /// API_URL includes /rest/v1; request paths add only /auth, /offers, etc.
  /// Debug uses the local development API. Profile and release REQUIRE an explicit API_URL (--dart-define):
  /// there is no implicit production endpoint, so a development or QA build can never reach production by accident.
  String get baseUrl => resolveBaseUrl(
    override: const String.fromEnvironment('API_URL'),
    production: !kDebugMode,
    android: !kIsWeb && Platform.isAndroid,
  );

  /// Resolves the API base URL for this build.
  ///
  /// - An explicit API_URL always wins (production, LAN or localhost), trailing slashes removed.
  /// - Debug (production == false) with no API_URL uses the local development API.
  /// - Profile or release (production == true) with no API_URL throws. It never falls back to a production host.
  static String resolveBaseUrl({
    required String override,
    required bool production,
    required bool android,
  }) {
    final explicit = override.trim();
    if (explicit.isNotEmpty) {
      return explicit.replaceFirst(RegExp(r'/+$'), '');
    }
    if (production) {
      throw StateError(
        'API_URL is required for profile and release builds. Pass --dart-define=API_URL=<base including /rest/v1>. '
        'No default production endpoint is used.',
      );
    }
    return 'http://${android ? '10.0.2.2' : 'localhost'}:3000/rest/v1';
  }

  /// Bumped by every [clearTokens] (logout / account switch). Pollers capture it before a request and drop the result
  /// (and stop) when it changed, so nothing loaded under one identity is ever applied under another.
  int get sessionGeneration => _tokenGeneration;

  Future<String?> getAccessToken() => _storage.read(key: _accessTokenKey);
  Future<String?> getRefreshToken() => _storage.read(key: _refreshTokenKey);

  // CF-19: the rotated refresh token is persisted FIRST. If the app is killed between the two writes, the stored refresh
  // token is still the live one (a stale access token just triggers one more refresh). The opposite order could leave the
  // already-rotated refresh token behind, and presenting it again is reuse, which revokes the whole session family.
  Future<void> storeTokens(String accessToken, String refreshToken) async {
    await _storage.write(key: _refreshTokenKey, value: refreshToken);
    await _storage.write(key: _accessTokenKey, value: accessToken);
  }

  Future<String?> getSessionUserId() => _storage.read(key: 'rab.sessionUserId');
  Future<void> setSessionUserId(String id) =>
      _storage.write(key: 'rab.sessionUserId', value: id);

  /// The push installation registered for the CURRENT session (set by
  /// `PushRegistrationService` right before it registers). `/auth/logout`
  /// names it (`pushDeviceId`, Phase C1b) so the server deactivates exactly
  /// this device with the session; forgotten with the session's tokens.
  String? pushDeviceIdForLogout;

  Future<void> clearTokens() async {
    ++_tokenGeneration;
    pushDeviceIdForLogout = null;
    await _storage.delete(key: 'rab.sessionUserId');
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
  }

  /// [background]: a timer/poll-driven read (sends [kBackgroundRequestHeader]); never set it for a user action.
  Future<dynamic> get(String path, {bool background = false}) =>
      _request('GET', path, background: background);

  /// Raw response bytes (e.g. an image via `GET /files/:id`, which always streams through the API and never
  /// redirects). Same token, refresh and error handling as every other request.
  Future<Uint8List> getBytes(String path) async =>
      await _request('GET', path, rawBytes: true) as Uint8List;

  /// A document from `GET /files/:id/download`. The API either streams the bytes (LOCAL storage) or answers 302 with a
  /// short-lived presigned storage URL (S3). The redirect is followed here WITHOUT the bearer token, so the credential
  /// never reaches the storage host, and the token is never placed in a URL. One refresh-and-retry on 401, exactly
  /// like `_request` (never replayed across a logout).
  Future<DownloadedFile> downloadFile(String path, {bool retried = false}) async {
    final generation = _tokenGeneration;
    final token = await getAccessToken();
    final request = http.Request('GET', Uri.parse('$baseUrl$path'))
      ..followRedirects = false
      ..headers.addAll({
        if (token != null) 'Authorization': 'Bearer $token',
        'X-Client-Platform': 'mobile',
        kClientCapabilitiesHeader: kClientCapabilities,
      });
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(request)).timeout(requestTimeout);
    } on TimeoutException {
      throw ApiException(408, 'The connection timed out. Check your connection and try again.');
    }
    if (res.statusCode == 401 && !retried) {
      final refreshed = generation == _tokenGeneration && await _refreshAccessToken();
      if (refreshed && generation == _tokenGeneration) return downloadFile(path, retried: true);
      if (generation == _tokenGeneration) {
        await clearTokens();
        onSessionExpired?.call();
      }
      throw ApiException(401, 'Your session has expired. Please sign in again.');
    }
    if (res.statusCode >= 300 && res.statusCode < 400) {
      final location = res.headers['location'];
      if (location == null) throw ApiException(502, 'The download link was missing. Please try again.');
      final http.Response stored;
      try {
        // Deliberately no headers: the presigned URL is its own short-lived authorisation.
        stored = await _http.get(Uri.parse(baseUrl).resolve(location)).timeout(requestTimeout);
      } on TimeoutException {
        throw ApiException(408, 'The download timed out. Check your connection and try again.');
      }
      if (stored.statusCode != 200) {
        throw ApiException(stored.statusCode, 'The file could not be fetched from storage. Please try again.');
      }
      return DownloadedFile(stored.bodyBytes, filename: _dispositionFilename(stored.headers) ?? _dispositionFilename(res.headers), mimeType: stored.headers['content-type']);
    }
    if (res.statusCode >= 400) {
      throw ApiException(res.statusCode, _extractMessage(res.body), body: _tryDecodeBody(res.body));
    }
    return DownloadedFile(res.bodyBytes, filename: _dispositionFilename(res.headers), mimeType: res.headers['content-type']);
  }

  static String? _dispositionFilename(Map<String, String> headers) {
    final cd = headers['content-disposition'];
    if (cd == null) return null;
    final star = RegExp(r"filename\*=UTF-8''([^;]+)", caseSensitive: false).firstMatch(cd);
    if (star != null) return Uri.decodeComponent(star.group(1)!.trim());
    final plain = RegExp(r'filename="?([^";]+)"?', caseSensitive: false).firstMatch(cd);
    return plain?.group(1)?.trim();
  }
  Future<dynamic> post(String path, {Map<String, dynamic>? body}) async {
    final pushDeviceId = pushDeviceIdForLogout;
    if (path != '/auth/logout' || pushDeviceId == null) {
      return _request('POST', path, body: body);
    }
    try {
      return await _request(
        'POST',
        path,
        body: {...?body, 'pushDeviceId': pushDeviceId},
      );
    } on ApiException catch (e) {
      // A server without the optional field rejects the whole body (400,
      // forbidNonWhitelisted) BEFORE anything is revoked: send it once more
      // without it. The explicit deactivate call covers the device.
      if (e.statusCode != 400) rethrow;
      return _request('POST', path, body: body);
    }
  }

  /// Opens a long-lived stream (`GET /realtime/stream`, Server-Sent Events)
  /// with the session's bearer token in a header — never in the URL. Always
  /// background traffic: an open stream must not keep an idle session alive.
  /// Returns the raw response; the caller handles every status (no refresh
  /// here: the realtime client uses the shared refresh path itself).
  Future<http.StreamedResponse> openStream(String path) async {
    final token = await getAccessToken();
    final request = http.Request('GET', Uri.parse('$baseUrl$path'))
      ..headers.addAll({
        if (token != null) 'Authorization': 'Bearer $token',
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Client-Platform': 'mobile',
        kClientCapabilitiesHeader: kClientCapabilities,
        kBackgroundRequestHeader: '1',
      });
    return _http.send(request).timeout(requestTimeout);
  }
  Future<dynamic> patch(String path, {Map<String, dynamic>? body}) =>
      _request('PATCH', path, body: body);
  Future<dynamic> put(String path, {Map<String, dynamic>? body}) =>
      _request('PUT', path, body: body);

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool retried = false,
    int? dispatchGeneration,
    bool rawBytes = false,
    bool background = false,
  }) async {
    // P0.1/#9 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B): captured on the FIRST attempt only (a
    // retry passes its own already-captured value through) — before this fix, the 401-retry below
    // only ever checked `_doRefresh`'s OWN internal generation window (the refresh call's own
    // async gap), never the gap between THIS request's original dispatch and the moment its retry
    // is about to run. `clearTokens()` (logout) is the one thing that bumps `_tokenGeneration`,
    // and every real account switch on this client goes through it first — so a request dispatched
    // under user A that reaches its retry decision AFTER a logout (whether or not a different user
    // has since logged back in) must never be replayed with whatever token is current by then.
    final generation = dispatchGeneration ?? _tokenGeneration;
    final token = await getAccessToken();
    final uri = Uri.parse('$baseUrl$path');
    final headers = {
      'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
      // Web moved its refresh token into an HttpOnly cookie a browser
      // manages automatically — this app has no cookie jar in that sense,
      // and flutter_secure_storage is already OS-secured (no browser-XSS
      // surface to defend against), so nothing here needs to change except
      // this: it tells `AuthController` to keep returning the refresh token
      // in the JSON body, exactly as before, instead of trying to set a
      // cookie this client would never read.
      'X-Client-Platform': 'mobile',
      kClientCapabilitiesHeader: kClientCapabilities,
      if (background) kBackgroundRequestHeader: '1',
    };

    final encodedBody = body != null ? jsonEncode(body) : null;
    // CF-19: bounded, so a hung network can never block clock-out (or anything else) until the app restarts. A timeout
    // never touches the stored session.
    final http.Response res;
    try {
      res = await switch (method) {
        'GET' => _http.get(uri, headers: headers),
        'PATCH' => _http.patch(uri, headers: headers, body: encodedBody),
        'PUT' => _http.put(uri, headers: headers, body: encodedBody),
        _ => _http.post(uri, headers: headers, body: encodedBody),
      }.timeout(requestTimeout);
    } on TimeoutException {
      throw ApiException(408, 'The connection timed out. Check your connection and try again.');
    }

    if (res.statusCode == 401 && !retried && _refreshesOn401(path, res.body)) {
      // CF-36: this request was sent under an identity that has since been signed out (and possibly replaced by another
      // account). Its 401 says nothing about the CURRENT session: never refresh with (and so rotate) the current
      // account's token for it, and never clear the current account's tokens because of it.
      if (generation != _tokenGeneration) {
        throw ApiException(401, 'Your session changed while this was loading. Please try again.');
      }
      final refreshed = await _refreshAccessToken();
      if (generation != _tokenGeneration) {
        throw ApiException(401, 'Your session changed while this was loading. Please try again.');
      }
      // P0.1/#9: refreshed succeeding is not sufficient — this specific request's own captured
      // generation (from before the 401 even arrived) must still match the current one. A logout
      // that happened anywhere while this request/refresh was in flight bumped `_tokenGeneration`;
      // replaying now would attach whatever token is current (possibly a different user's) to a
      // request this tab dispatched under the OLD identity — the same class of bug as the web
      // account-mixing finding this whole section mirrors.
      if (refreshed && generation == _tokenGeneration) {
        final retryBody = path == '/auth/logout'
            ? {...?body, 'refreshToken': await getRefreshToken()}
            : body;
        return _request(
          method,
          path,
          body: retryBody,
          retried: true,
          dispatchGeneration: generation,
          rawBytes: rawBytes,
          background: background,
        );
      }
      await clearTokens();
      onSessionExpired?.call();
      throw ApiException(
        401,
        'Your session has expired. Please sign in again.',
      );
    }

    if (res.statusCode == 429) {
      // The throttler's own body is a bare JSON string ("ThrottlerException:
      // Too Many Requests"), not the {message, error, statusCode} shape
      // every other error response uses — worth a friendlier message on its
      // own account rather than falling through to _extractMessage.
      final sent = parseRetryAfter(res.headers['retry-after'])?.inSeconds;
      final seconds = sent ?? 60;
      final minutes = ((seconds + 59) ~/ 60).clamp(1, 100000);
      throw ApiException(
        429,
        'Too many requests. Please try again in $minutes ${minutes == 1 ? 'minute' : 'minutes'}.',
        retryAfterSeconds: seconds,
        retryAfter: sent == null ? null : Duration(seconds: sent),
      );
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        res.statusCode,
        _extractMessage(res.body),
        body: _tryDecodeBody(res.body),
      );
    }
    if (rawBytes) return res.bodyBytes;
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  /// Account security: the signed-in user's own two-factor routes (Bearer
  /// authenticated, unlike the pre-session `/auth/mfa/challenge/*`). An expired
  /// access token there must refresh like any other signed-in call. The one
  /// 401 that is NOT about the session is a wrong first code on enrolment
  /// confirm (`MFA_CODE_INVALID`): replaying it would only burn an attempt.
  static const _signedInMfaPaths = {
    '/auth/mfa',
    '/auth/mfa/enrolment',
    '/auth/mfa/enrolment/confirm',
    '/auth/mfa/recovery-codes',
    '/auth/mfa/disable',
  };

  /// Whether a 401 on [path] means "the access token expired" (refresh, retry
  /// once) rather than a credential refusal the caller must show.
  bool _refreshesOn401(String path, String responseBody) {
    if (!path.startsWith('/auth/')) return true;
    if (path == '/auth/me' || path == '/auth/logout') return true;
    if (_signedInMfaPaths.contains(path)) {
      return _tryDecodeBody(responseBody)?['code'] != 'MFA_CODE_INVALID';
    }
    return false;
  }

  Future<bool> _refreshAccessToken() {
    return _refreshInFlight ??= _doRefresh().whenComplete(
      () => _refreshInFlight = null,
    );
  }

  Future<bool> _doRefresh() async {
    final generation = _tokenGeneration;
    final refreshToken = await getRefreshToken();
    if (refreshToken == null) return false;
    final http.Response res;
    try {
      res = await _http
          .post(
            Uri.parse('$baseUrl/auth/refresh'),
            headers: {
              'Content-Type': 'application/json',
              'X-Client-Platform': 'mobile',
              kClientCapabilitiesHeader: kClientCapabilities,
            },
            body: jsonEncode({'refreshToken': refreshToken}),
          )
          .timeout(refreshTimeout);
    } on TimeoutException {
      // CF-19: an unanswered refresh is a network problem, not an ended session: keep the tokens and let the caller retry.
      throw ApiException(408, 'The connection timed out. Check your connection and try again.');
    }
    if (res.statusCode == 401 || res.statusCode == 403) return false;
    if (res.statusCode >= 400) {
      throw ApiException(res.statusCode, _extractMessage(res.body));
    }
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    if (generation != _tokenGeneration) {
      throw ApiException(401, 'Session ended. Please sign in again.');
    }
    await storeTokens(
      data['accessToken'] as String,
      data['refreshToken'] as String,
    );
    return true;
  }

  /// NestJS's default error body is `{message, error, statusCode}`, but
  /// `message` itself varies: a plain string for most thrown exceptions, or
  /// an array of strings for a `class-validator` DTO rejection (e.g.
  /// `["email must be an email"]`) — and a small number of routes (the
  /// throttler, handled separately above) return a bare JSON string with no
  /// wrapping object at all. All three are handled here so a real backend
  /// message reaches the user instead of silently degrading to the generic
  /// fallback whenever the shape isn't the single common case.
  Map<String, dynamic>? _tryDecodeBody(String body) {
    try {
      final decoded = jsonDecode(body);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  String _extractMessage(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map && decoded['message'] != null) {
        final message = decoded['message'];
        if (message is List && message.isNotEmpty) {
          return message.first.toString();
        }
        return message.toString();
      }
      if (decoded is String && decoded.isNotEmpty) return decoded;
    } catch (_) {
      // Not JSON — fall through to the generic message.
    }
    return 'Something went wrong. Please try again.';
  }
}

/// Bytes of a downloaded document plus what the server said about them.
class DownloadedFile {
  DownloadedFile(this.bytes, {this.filename, this.mimeType});
  final Uint8List bytes;
  final String? filename;
  final String? mimeType;

  /// `%PDF-` magic: never show or save something that is not actually a PDF.
  bool get isPdf =>
      bytes.length > 4 && bytes[0] == 0x25 && bytes[1] == 0x50 && bytes[2] == 0x44 && bytes[3] == 0x46 && bytes[4] == 0x2D;
}

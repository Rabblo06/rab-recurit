import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform, HttpDate;

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

class ApiException implements Exception {
  final int statusCode;
  final String message;
  final int? retryAfterSeconds;

  /// The decoded JSON error body, when the response was structured JSON
  /// (e.g. `{code: 'CLOCK_IN_TOO_EARLY', shiftStart, availableAt}` from
  /// AttendanceService) — lets a caller branch on `code` for a tailored UI
  /// instead of pattern-matching the human-readable `message` string.
  final Map<String, dynamic>? body;

  ApiException(
    this.statusCode,
    this.message, {
    this.retryAfterSeconds,
    this.body,
  });

  /// The structured error `code`, if the backend sent one — null for a
  /// plain `{message}` error or a non-JSON body.
  String? get code => body?['code'] as String?;

  @override
  String toString() => message;
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
  /// `http.testing.MockClient` — production call sites never pass one.
  ApiClient({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  final http.Client _http;

  /// CF-19: upper bounds for one API request and for one token refresh.
  static const Duration requestTimeout = Duration(seconds: 30);
  static const Duration refreshTimeout = Duration(seconds: 20);
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

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

  Future<void> clearTokens() async {
    ++_tokenGeneration;
    await _storage.delete(key: 'rab.sessionUserId');
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
  }

  Future<dynamic> get(String path) => _request('GET', path);
  Future<dynamic> post(String path, {Map<String, dynamic>? body}) =>
      _request('POST', path, body: body);
  Future<dynamic> patch(String path, {Map<String, dynamic>? body}) =>
      _request('PATCH', path, body: body);

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool retried = false,
    int? dispatchGeneration,
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
    };

    final encodedBody = body != null ? jsonEncode(body) : null;
    // CF-19: bounded, so a hung network can never block clock-out (or anything else) until the app restarts. A timeout
    // never touches the stored session.
    final http.Response res;
    try {
      res = await switch (method) {
        'GET' => _http.get(uri, headers: headers),
        'PATCH' => _http.patch(uri, headers: headers, body: encodedBody),
        _ => _http.post(uri, headers: headers, body: encodedBody),
      }.timeout(requestTimeout);
    } on TimeoutException {
      throw ApiException(408, 'The connection timed out. Check your connection and try again.');
    }

    if (res.statusCode == 401 &&
        !retried &&
        (!path.startsWith('/auth/') ||
            path == '/auth/me' ||
            path == '/auth/logout')) {
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
            ? {'refreshToken': await getRefreshToken()}
            : body;
        return _request(
          method,
          path,
          body: retryBody,
          retried: true,
          dispatchGeneration: generation,
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
      final header = res.headers['retry-after'];
      final seconds = int.tryParse(header ?? '') ?? _retryDate(header) ?? 60;
      final minutes = ((seconds + 59) ~/ 60).clamp(1, 100000);
      throw ApiException(
        429,
        'Too many requests. Please try again in $minutes ${minutes == 1 ? 'minute' : 'minutes'}.',
        retryAfterSeconds: seconds,
      );
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        res.statusCode,
        _extractMessage(res.body),
        body: _tryDecodeBody(res.body),
      );
    }
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  int? _retryDate(String? header) {
    if (header == null) return null;
    try {
      return (HttpDate.parse(header).difference(DateTime.now()).inMilliseconds /
              1000)
          .ceil()
          .clamp(0, 2147483647);
    } catch (_) {
      return null;
    }
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

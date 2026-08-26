import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

class ApiException implements Exception {
  final int statusCode;
  final String message;
  ApiException(this.statusCode, this.message);
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
  static const _accessTokenKey = 'rab.accessToken';
  static const _refreshTokenKey = 'rab.refreshToken';

  /// Accepts an injected [http.Client] so tests can substitute
  /// `http.testing.MockClient` — production call sites never pass one.
  ApiClient({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  final http.Client _http;
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  /// Set after construction (the callback usually needs `this` from
  /// whoever owns the client, e.g. `AuthProvider`, which can't be passed
  /// into its own field initializer).
  VoidCallback? onSessionExpired;
  Future<bool>? _refreshInFlight;

  /// The Android emulator's loopback alias for the host machine is
  /// 10.0.2.2, not localhost — inside the emulator, localhost means the
  /// emulator itself, not the dev machine running rab-server. Override with
  /// --dart-define=API_URL=... for a physical device or a different port.
  String get baseUrl {
    const override = String.fromEnvironment('API_URL');
    if (override.isNotEmpty) return override;
    final host = (!kIsWeb && Platform.isAndroid) ? '10.0.2.2' : 'localhost';
    return 'http://$host:3000/rest/v1';
  }

  Future<String?> getAccessToken() => _storage.read(key: _accessTokenKey);
  Future<String?> getRefreshToken() => _storage.read(key: _refreshTokenKey);

  Future<void> storeTokens(String accessToken, String refreshToken) async {
    await _storage.write(key: _accessTokenKey, value: accessToken);
    await _storage.write(key: _refreshTokenKey, value: refreshToken);
  }

  Future<void> clearTokens() async {
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
  }

  Future<dynamic> get(String path) => _request('GET', path);
  Future<dynamic> post(String path, {Map<String, dynamic>? body}) => _request('POST', path, body: body);

  Future<dynamic> _request(String method, String path, {Map<String, dynamic>? body, bool retried = false}) async {
    final token = await getAccessToken();
    final uri = Uri.parse('$baseUrl$path');
    final headers = {
      'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };

    final res = method == 'GET'
        ? await _http.get(uri, headers: headers)
        : await _http.post(uri, headers: headers, body: body != null ? jsonEncode(body) : null);

    if (res.statusCode == 401 && !retried && !path.startsWith('/auth/')) {
      final refreshed = await _refreshAccessToken();
      if (refreshed) return _request(method, path, body: body, retried: true);
      await clearTokens();
      onSessionExpired?.call();
      throw ApiException(401, 'Your session has expired. Please sign in again.');
    }

    if (res.statusCode == 429) {
      // The throttler's own body is a bare JSON string ("ThrottlerException:
      // Too Many Requests"), not the {message, error, statusCode} shape
      // every other error response uses — worth a friendlier message on its
      // own account rather than falling through to _extractMessage.
      throw ApiException(429, 'Too many attempts. Please wait a minute and try again.');
    }
    if (res.statusCode >= 400) {
      throw ApiException(res.statusCode, _extractMessage(res.body));
    }
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  Future<bool> _refreshAccessToken() {
    return _refreshInFlight ??= _doRefresh().whenComplete(() => _refreshInFlight = null);
  }

  Future<bool> _doRefresh() async {
    final refreshToken = await getRefreshToken();
    if (refreshToken == null) return false;
    try {
      final res = await _http.post(
        Uri.parse('$baseUrl/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refreshToken': refreshToken}),
      );
      if (res.statusCode >= 400) return false;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      await storeTokens(data['accessToken'] as String, data['refreshToken'] as String);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// NestJS's default error body is `{message, error, statusCode}`, but
  /// `message` itself varies: a plain string for most thrown exceptions, or
  /// an array of strings for a `class-validator` DTO rejection (e.g.
  /// `["email must be an email"]`) — and a small number of routes (the
  /// throttler, handled separately above) return a bare JSON string with no
  /// wrapping object at all. All three are handled here so a real backend
  /// message reaches the user instead of silently degrading to the generic
  /// fallback whenever the shape isn't the single common case.
  String _extractMessage(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map && decoded['message'] != null) {
        final message = decoded['message'];
        if (message is List && message.isNotEmpty) return message.first.toString();
        return message.toString();
      }
      if (decoded is String && decoded.isNotEmpty) return decoded;
    } catch (_) {
      // Not JSON — fall through to the generic message.
    }
    return 'Something went wrong. Please try again.';
  }
}

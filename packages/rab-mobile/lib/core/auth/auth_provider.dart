import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../models/current_user.dart';

/// Session state for the whole app. `ChangeNotifierProvider` at the root
/// makes this available everywhere; screens read it via `context.watch` /
/// `context.read` rather than each screen owning its own auth logic.
class AuthProvider extends ChangeNotifier {
  /// Accepts an injected [ApiClient] so tests can substitute one built with
  /// a mocked HTTP client — production call sites never pass one.
  AuthProvider({ApiClient? apiClient}) : api = apiClient ?? ApiClient() {
    api.onSessionExpired = _handleSessionExpired;
    _restore();
  }

  final ApiClient api;

  bool isReady = false;
  CurrentUser? user;

  bool get isAuthenticated => user != null;

  Future<void> _restore() async {
    final token = await api.getAccessToken();
    if (token != null) {
      try {
        await refreshUser();
      } catch (_) {
        await api.clearTokens();
      }
    }
    isReady = true;
    notifyListeners();
  }

  Future<void> refreshUser() async {
    final data = await api.get('/auth/me');
    user = CurrentUser.fromJson(data as Map<String, dynamic>);
    notifyListeners();
  }

  /// No organisation slug — `/auth/login` resolves the org from email +
  /// password alone (see AuthService.login's trade-off note server-side).
  /// Always followed by `refreshUser()` — `/auth/me` is the one route
  /// `MustResetPasswordGuard` exempts, so `user.mustResetPassword` is known
  /// either way and `_RootGate` can route to `SetPasswordScreen` instead of
  /// the main shell. A running shift timer or paid-hours figure must never
  /// render on a token that hasn't cleared that forced-reset gate.
  Future<void> login(String email, String password) async {
    final data = await api.post('/auth/login', body: {
      'email': email,
      'password': password,
    });
    final map = data as Map<String, dynamic>;
    await api.storeTokens(map['accessToken'] as String, map['refreshToken'] as String);
    await refreshUser();
  }

  /// Always succeeds from the caller's point of view regardless of whether
  /// the email matches a real account — no enumeration (mirrors the web
  /// ForgotPassword flow).
  Future<void> forgotPassword(String email) async {
    await api.post('/auth/forgot-password', body: {'email': email});
  }

  /// Completes the forced-reset flow — only callable while
  /// `user.mustResetPassword` is still true (server-enforced via
  /// `AuthService.setPassword`, same rule as the web SetPassword screen).
  Future<void> setPassword(String newPassword) async {
    await api.post('/auth/set-password', body: {'newPassword': newPassword});
    await refreshUser();
  }

  Future<void> logout() async {
    // Revokes the refresh token family server-side — clearing local storage
    // alone would just make this device forget a session still valid
    // everywhere else.
    try {
      final refreshToken = await api.getRefreshToken();
      if (refreshToken != null) {
        await api.post('/auth/logout', body: {'refreshToken': refreshToken});
      }
    } catch (_) {
      // Best-effort: still clear the local session even if the revoke call fails.
    }
    await api.clearTokens();
    user = null;
    notifyListeners();
  }

  void _handleSessionExpired() {
    user = null;
    notifyListeners();
  }
}

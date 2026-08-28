import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../models/current_user.dart';
import 'biometric_authenticator.dart';
import 'biometric_config.dart';
import 'biometric_store.dart';

/// Drives `_RootGate`'s routing (see app.dart). `loading` while state is
/// being resolved; `biometricLocked`/`reauthRequired` are the two states a
/// device with biometrics enabled can land in on a fresh app open, before
/// any backend call happens; `offeringBiometricSetup` is shown exactly once
/// right after a fresh password login on hardware that supports it;
/// `unauthenticated`/`mustResetPassword`/`authenticated` are unchanged from
/// Increment 1.
enum AuthPhase { loading, biometricLocked, reauthRequired, offeringBiometricSetup, unauthenticated, mustResetPassword, authenticated }

/// Session state for the whole app. `ChangeNotifierProvider` at the root
/// makes this available everywhere; screens read it via `context.watch` /
/// `context.read` rather than each screen owning its own auth logic.
class AuthProvider extends ChangeNotifier {
  /// Accepts injected collaborators so tests can substitute fakes —
  /// production call sites never pass any of these.
  AuthProvider({
    ApiClient? apiClient,
    BiometricAuthenticator? biometricAuthenticator,
    BiometricStore? biometricStore,
    DateTime Function()? now,
  })  : api = apiClient ?? ApiClient(),
        _biometricAuthenticator = biometricAuthenticator ?? LocalAuthBiometricAuthenticator(),
        _biometricStore = biometricStore ?? BiometricStore(),
        _now = now ?? DateTime.now {
    api.onSessionExpired = _handleSessionExpired;
    _init();
  }

  final ApiClient api;
  final BiometricAuthenticator _biometricAuthenticator;
  final BiometricStore _biometricStore;
  final DateTime Function() _now;

  AuthPhase phase = AuthPhase.loading;
  CurrentUser? user;
  bool biometricEnabledForCurrentUser = false;

  /// Kept for the handful of call sites that only care "is state resolved"
  /// / "do we have a user record" — unchanged semantics from Increment 1.
  bool get isReady => phase != AuthPhase.loading;
  bool get isAuthenticated => user != null;

  Future<BiometricCapability> checkBiometricCapability() => _biometricAuthenticator.getCapability();

  Future<void> _init() async {
    final enabledUserId = await _biometricStore.getEnabledUserId();
    if (enabledUserId == null) {
      await _restore();
      return;
    }

    final lastAuth = await _biometricStore.getLastFullAuthenticationAt();
    if (lastAuth == null || _now().difference(lastAuth) >= const Duration(days: biometricFullReauthDays)) {
      phase = AuthPhase.reauthRequired;
      notifyListeners();
      return;
    }

    final capability = await _biometricAuthenticator.getCapability();
    if (!capability.isAvailable) {
      // Hardware/enrollment changed since biometrics were enabled — fall
      // back to a full password login rather than a lock screen that could
      // never succeed.
      phase = AuthPhase.reauthRequired;
      notifyListeners();
      return;
    }

    phase = AuthPhase.biometricLocked;
    notifyListeners();
  }

  /// Unchanged Increment-1 behavior: silent restore from the stored refresh
  /// token, with no biometric gate — the path anyone who hasn't opted into
  /// biometrics always takes.
  Future<void> _restore() async {
    final token = await api.getAccessToken();
    if (token != null) {
      try {
        await refreshUser();
      } catch (_) {
        await api.clearTokens();
      }
    }
    phase = _phaseAfterUserLoaded();
    notifyListeners();
  }

  Future<void> refreshUser() async {
    final data = await api.get('/auth/me');
    user = CurrentUser.fromJson(data as Map<String, dynamic>);
    notifyListeners();
  }

  AuthPhase _phaseAfterUserLoaded() {
    if (user == null) return AuthPhase.unauthenticated;
    return user!.mustResetPassword ? AuthPhase.mustResetPassword : AuthPhase.authenticated;
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
    await _afterFreshCredentialAuth();
  }

  /// A password login always counts as "full authentication" for the
  /// biometric reauth window — resets the 30-day timer, and (once past the
  /// forced-reset gate, if any) offers biometric setup for hardware that
  /// supports it and isn't already enabled for this account.
  Future<void> _afterFreshCredentialAuth() async {
    if (user == null || user!.mustResetPassword) {
      phase = AuthPhase.mustResetPassword;
      notifyListeners();
      return;
    }

    await _biometricStore.setLastFullAuthenticationAt(_now());
    final enabledUserId = await _biometricStore.getEnabledUserId();
    biometricEnabledForCurrentUser = enabledUserId == user!.id;

    if (!biometricEnabledForCurrentUser) {
      final capability = await _biometricAuthenticator.getCapability();
      if (capability.isAvailable) {
        phase = AuthPhase.offeringBiometricSetup;
        notifyListeners();
        return;
      }
    }

    phase = AuthPhase.authenticated;
    notifyListeners();
  }

  /// Called from the post-login setup prompt. `enable: true` runs one live
  /// biometric check to confirm the sensor actually works before persisting
  /// anything; `enable: false` ("Not Now") writes nothing and just proceeds
  /// — biometrics can always be turned on later from Profile > Security.
  /// Returns the live check's outcome (null when `enable` was false) so the
  /// caller can react — e.g. showing the "$biometricLabel not available"
  /// dialog when the sensor turns out unavailable, rather than silently
  /// continuing.
  Future<BiometricOutcome?> completeBiometricSetup({required bool enable}) async {
    BiometricOutcome? outcome;
    if (enable) {
      outcome = await _biometricAuthenticator.authenticate(reason: 'Confirm biometric login for rab');
      if (outcome == BiometricOutcome.success) {
        await _biometricStore.setEnabledUserId(user!.id);
        biometricEnabledForCurrentUser = true;
      }
    }
    phase = AuthPhase.authenticated;
    notifyListeners();
    return outcome;
  }

  /// The returning-user unlock flow: a local biometric success only ever
  /// gates whether the app *attempts* the real `/auth/me` call — the
  /// backend's answer is what actually decides. A revoked/expired session,
  /// disabled account, etc. all still deny access even after local success.
  Future<BiometricOutcome> attemptBiometricRestore() async {
    final outcome = await _biometricAuthenticator.authenticate(reason: 'Unlock rab to continue');
    if (outcome != BiometricOutcome.success) return outcome;

    try {
      await refreshUser();
      biometricEnabledForCurrentUser = true;
      phase = _phaseAfterUserLoaded();
      notifyListeners();
    } catch (_) {
      await api.clearTokens();
      await _biometricStore.clearEnabledUserId();
      user = null;
      biometricEnabledForCurrentUser = false;
      phase = AuthPhase.unauthenticated;
      notifyListeners();
    }
    return outcome;
  }

  /// "Use password instead" on the lock screen — leaves stored tokens and
  /// the biometric enablement flag untouched (the user may still succeed
  /// biometrically next time); just routes back to the normal Welcome/Login
  /// flow for this app open.
  void fallBackToPassword() {
    phase = AuthPhase.unauthenticated;
    notifyListeners();
  }

  /// Profile > Security toggle.
  Future<bool> enableBiometric() async {
    final outcome = await _biometricAuthenticator.authenticate(reason: 'Confirm biometric login for rab');
    if (outcome != BiometricOutcome.success) return false;
    await _biometricStore.setEnabledUserId(user!.id);
    biometricEnabledForCurrentUser = true;
    notifyListeners();
    return true;
  }

  Future<void> disableBiometric() async {
    await _biometricStore.clearEnabledUserId();
    biometricEnabledForCurrentUser = false;
    notifyListeners();
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
  /// Setting a real password for the first time counts as a full
  /// authentication the same way an ordinary login does.
  Future<void> setPassword(String newPassword) async {
    await api.post('/auth/set-password', body: {'newPassword': newPassword});
    await refreshUser();
    await _afterFreshCredentialAuth();
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
    // Clears the biometric binding so old biometric access cannot silently
    // reopen this account afterward — a subsequent app open goes through
    // the normal Welcome/Login flow, never straight back to a lock screen.
    await _biometricStore.clearEnabledUserId();
    user = null;
    biometricEnabledForCurrentUser = false;
    phase = AuthPhase.unauthenticated;
    notifyListeners();
  }

  void _handleSessionExpired() {
    user = null;
    phase = AuthPhase.unauthenticated;
    notifyListeners();
  }
}

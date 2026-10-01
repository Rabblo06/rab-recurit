import 'dart:async';

import 'package:flutter/widgets.dart';

import '../api/api_client.dart';
import '../models/current_user.dart';
import '../onboarding/onboarding_store.dart';
import 'biometric_authenticator.dart';
import 'biometric_config.dart';
import 'biometric_store.dart';

/// Drives `_RootGate`'s routing (see app.dart). `loading` while state is
/// being resolved; `biometricLocked`/`reauthRequired` are the two states a
/// device with biometrics enabled can land in on a fresh app open, before
/// any backend call happens; `offeringBiometricSetup` is shown exactly once
/// right after a fresh password login on hardware that supports it.
enum AppUnlockState { locked, unlocked }

enum AuthPhase {
  loading,
  biometricLocked,
  reauthRequired,
  offeringBiometricSetup,
  unauthenticated,
  mustResetPassword,
  authenticated,
}

/// Session state for the whole app. `ChangeNotifierProvider` at the root
/// makes this available everywhere; screens read it via `context.watch` /
/// `context.read` rather than each screen owning its own auth logic.
class AuthProvider extends ChangeNotifier with WidgetsBindingObserver {
  /// Accepts injected collaborators so tests can substitute fakes —
  /// production call sites never pass any of these.
  AuthProvider({
    ApiClient? apiClient,
    BiometricAuthenticator? biometricAuthenticator,
    BiometricStore? biometricStore,
    OnboardingStore? onboardingStore,
    DateTime Function()? now,
  }) : api = apiClient ?? ApiClient(),
       _biometricAuthenticator =
           biometricAuthenticator ?? LocalAuthBiometricAuthenticator(),
       _biometricStore = biometricStore ?? BiometricStore(),
       _onboardingStore = onboardingStore ?? OnboardingStore(),
       _now = now ?? DateTime.now {
    WidgetsBinding.instance.addObserver(this);
    api.onSessionExpired = _handleSessionExpired;
    initialized = _init();
  }

  final ApiClient api;
  late final Future<void> initialized;
  final BiometricAuthenticator _biometricAuthenticator;
  final BiometricStore _biometricStore;
  final OnboardingStore _onboardingStore;
  final DateTime Function() _now;
  Timer? _deadlineTimer;
  bool _disposed = false;

  bool _loginPending = false;
  bool _logoutPending = false;
  bool _biometricPending = false;
  int _sessionGeneration = 0;
  String? rememberedUserId;
  String? rememberedEmail;
  DateTime? loginCooldownUntil;
  AppPresentation get presentation =>
      user?.presentation ?? AppPresentation.unsupported;

  AuthPhase phase = AuthPhase.loading;
  CurrentUser? user;
  // Never persisted: each fresh provider/process starts locked.
  AppUnlockState _unlockState = AppUnlockState.locked;
  AppUnlockState get unlockState => _unlockState;
  bool get canAccessAuthenticatedUi =>
      user != null &&
      phase == AuthPhase.authenticated &&
      _unlockState == AppUnlockState.unlocked;
  bool biometricEnabledForCurrentUser = false;

  /// Device-level, not session-level — set once on the very first app open
  /// and never cleared by logout. Drives `AuthFlowShell`'s decision to show
  /// Welcome (only when this is still false) vs. going straight to Login.
  bool hasSeenWelcome = false;

  /// Called by `AuthFlowShell` once the user proceeds past Welcome.
  Future<void> completeWelcome() async {
    hasSeenWelcome = true;
    await _onboardingStore.setHasSeenWelcome();
    notifyListeners();
  }

  /// Kept for the handful of call sites that only care "is state resolved"
  /// / "do we have a user record".
  bool get isReady => phase != AuthPhase.loading;
  bool get isAuthenticated => user != null;

  Future<BiometricCapability> checkBiometricCapability() =>
      _biometricAuthenticator.getCapability();

  /// MOB-02 fix: the 90-day deadline is anchored to `lastFullAuthAt` (the
  /// most recent PASSWORD authentication), never to `confirmedAt` (the most
  /// recent NATIVE BIOMETRIC confirmation). Profile > Enable Biometric
  /// (`enableBiometric` below) can set `confirmedAt` to a moment well after
  /// the original password login — if the deadline were computed from
  /// `confirmedAt` instead, that re-confirmation would silently PUSH the
  /// 90-day boundary out further, exactly the "extend biometric trust
  /// without satisfying the password reauthentication policy" defect this
  /// phase closes. `confirmedAt` plays no part in the deadline itself — it's
  /// only ever an existence/liveness check ("has this binding ever passed a
  /// real biometric prompt, and is that record not obviously clock-tampered
  /// into the future"); `enableBiometric()`'s own upfront gate (below) is
  /// what stops a stale password-auth window from producing a fresh
  /// `confirmedAt` in the first place, so no separate cross-check against
  /// `lastFullAuthAt` is needed — and adding one here is actively wrong: a
  /// LATER password re-login legitimately advances `lastFullAuthAt` without
  /// touching `confirmedAt` at all (no new biometric prompt needed on a
  /// routine re-login), which would make any older confirmedAt spuriously
  /// "before" it.
  bool _bindingValid(DateTime? confirmedAt, DateTime? lastFullAuthAt) =>
      confirmedAt != null &&
      !confirmedAt.isAfter(_now()) &&
      _passwordAuthFresh(lastFullAuthAt);

  /// Whether `lastFullAuthAt` (a PASSWORD authentication timestamp) still
  /// satisfies the 90-day policy — the one check that gates both routine
  /// unlock (`_bindingValid` above) and a fresh Profile > Enable Biometric
  /// re-confirmation (`enableBiometric` below), so neither path can drift
  /// from the other.
  bool _passwordAuthFresh(DateTime? lastFullAuthAt) =>
      lastFullAuthAt != null &&
      !lastFullAuthAt.isAfter(_now()) &&
      _now().isBefore(
        lastFullAuthAt.add(const Duration(days: biometricFullReauthDays)),
      );

  Future<bool> _hasSession() async =>
      await api.getAccessToken() != null || await api.getRefreshToken() != null;

  Future<void> _init() async {
    await api.clearLegacyApplicationPreference();
    hasSeenWelcome = await _onboardingStore.getHasSeenWelcome();
    final remembered = await _biometricStore.getRememberedAccount();
    rememberedUserId = remembered?.userId;
    rememberedEmail = remembered?.email;
    if (!await _hasSession()) {
      _setPhase(AuthPhase.unauthenticated);
      notifyListeners();
      return;
    }
    final preference = await _biometricStore.getEnabledUserId();
    if (preference == null) {
      await _restore();
      return;
    }
    // Missing ownership/confirmation on legacy installations requires password.
    final owner = await api.getSessionUserId();
    if (owner == null ||
        owner != preference ||
        owner != rememberedUserId ||
        !_bindingValid(
          await _biometricStore.getBiometricConfirmedAt(),
          await _biometricStore.getLastFullAuthenticationAt(),
        ) ||
        !(await checkBiometricCapability()).isAvailable) {
      _setPhase(AuthPhase.reauthRequired);
    } else {
      _setPhase(AuthPhase.biometricLocked);
    }
    notifyListeners();
  }

  Future<void> _restore() async {
    try {
      await refreshUser();
    } catch (error) {
      user = null;
      if (error is ApiException &&
          (error.statusCode == 401 || error.statusCode == 403)) {
        await api.clearTokens();
      }
    }
    // A restored server identity is not proof of local presence.
    _setPhase(
      user == null ? AuthPhase.unauthenticated : AuthPhase.reauthRequired,
    );
    notifyListeners();
  }

  Future<void> refreshUser() async {
    final generation = _sessionGeneration;
    final data = await api.get('/auth/me');
    if (generation != _sessionGeneration) return;
    user = CurrentUser.fromJson(data as Map<String, dynamic>);
    notifyListeners();
  }

  AuthPhase _phaseAfterUserLoaded() {
    if (user == null) return AuthPhase.unauthenticated;
    if (_unlockState != AppUnlockState.unlocked) {
      return AuthPhase.reauthRequired;
    }
    return user!.mustResetPassword
        ? AuthPhase.mustResetPassword
        : AuthPhase.authenticated;
  }

  /// No organisation slug — `/auth/login` resolves the org from email +
  /// password alone (see AuthService.login's trade-off note server-side).
  /// Always followed by `refreshUser()` — `/auth/me` is the one route
  /// `MustResetPasswordGuard` exempts, so `user.mustResetPassword` is known
  /// either way and `_RootGate` can route to `SetPasswordScreen` instead of
  /// the main shell. A running shift timer or paid-hours figure must never
  /// render on a token that hasn't cleared that forced-reset gate.
  Future<void> login(String email, String password) async {
    if (_loginPending || _logoutPending) return;
    final until = loginCooldownUntil;
    if (until != null && until.isAfter(_now())) {
      throw ApiException(
        429,
        'Too many sign-in attempts. Please try again later.',
        retryAfterSeconds: until.difference(_now()).inSeconds + 1,
      );
    }
    _loginPending = true;
    final generation = ++_sessionGeneration;
    bool tokensWritten = false;
    try {
      final data = await api.post(
        '/auth/login',
        body: {'email': email, 'password': password},
      );
      if (generation != _sessionGeneration) return;
      final map = data as Map<String, dynamic>;
      await api.storeTokens(
        map['accessToken'] as String,
        map['refreshToken'] as String,
      );
      tokensWritten = true;
      final current = CurrentUser.fromJson(
        await api.get('/auth/me') as Map<String, dynamic>,
      );
      if (generation != _sessionGeneration) return;
      user = current;
      await api.setSessionUserId(current.id);
      await _biometricStore.setRememberedAccount(current.id, current.email);
      rememberedUserId = current.id;
      rememberedEmail = current.email;
      await _afterFreshCredentialAuth();
    } on ApiException catch (e) {
      if (e.statusCode == 429) {
        loginCooldownUntil = _now().add(
          Duration(seconds: e.retryAfterSeconds ?? 60),
        );
      }
      rethrow;
    } finally {
      if (tokensWritten && (user == null || generation != _sessionGeneration)) {
        await api.clearTokens();
      }
      _loginPending = false;
    }
  }

  /// Password auth records identity; only native confirmation creates trust.
  Future<void> _afterFreshCredentialAuth() async {
    // The anchor as it stood BEFORE this login — used below to judge whether
    // the EXISTING confirmedAt is still within policy. Using the brand-new
    // timestamp we're about to write instead would be a tautology (any
    // pre-existing confirmedAt is always "before" a timestamp computed this
    // instant), which would force a fresh biometric confirmation on every
    // single password login even when the existing one is still genuinely
    // fresh — not what MOB-02 asks for; MOB-02 is about `enableBiometric()`
    // (below) silently resetting this anchor, not about routine re-logins.
    final priorFullAuthAt = await _biometricStore.getLastFullAuthenticationAt();
    await _biometricStore.setLastFullAuthenticationAt(_now());
    final preference = await _biometricStore.getEnabledUserId();
    final valid =
        preference == user!.id &&
        _bindingValid(
          await _biometricStore.getBiometricConfirmedAt(),
          priorFullAuthAt,
        );
    if (!valid) await _biometricStore.clearEnabledUserId();
    biometricEnabledForCurrentUser = false;
    _unlockState = AppUnlockState.unlocked;
    if (user!.mustResetPassword) {
      _setPhase(AuthPhase.mustResetPassword);
    } else {
      final available = (await checkBiometricCapability()).isAvailable;
      biometricEnabledForCurrentUser = valid && available;
      _setPhase(
        available && !valid
            ? AuthPhase.offeringBiometricSetup
            : AuthPhase.authenticated,
      );
    }
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
  Future<BiometricOutcome?> completeBiometricSetup({
    required bool enable,
  }) async {
    if (phase != AuthPhase.offeringBiometricSetup ||
        user == null ||
        user!.mustResetPassword ||
        _biometricPending) {
      return null;
    }
    final generation = _sessionGeneration;
    final id = user!.id;
    _biometricPending = true;
    BiometricOutcome? outcome;
    try {
      if (enable) {
        outcome = await _biometricAuthenticator.authenticate(
          reason: 'Confirm biometric login for rab',
        );
        if (outcome == BiometricOutcome.success) {
          if (generation != _sessionGeneration || user?.id != id) {
            return outcome;
          }
          await _biometricStore.confirmBiometric(id, _now());
          biometricEnabledForCurrentUser = true;
        }
      }
      if (generation == _sessionGeneration &&
          user?.id == id &&
          (!enable || outcome == BiometricOutcome.success)) {
        _setPhase(AuthPhase.authenticated);
        notifyListeners();
      }
      return outcome;
    } finally {
      _biometricPending = false;
    }
  }

  /// The returning-user unlock flow: a local biometric success only ever
  /// gates whether the app *attempts* the real `/auth/me` call — the
  /// backend's answer is what actually decides. A revoked/expired session,
  /// disabled account, etc. all still deny access even after local success.
  Future<BiometricOutcome> attemptBiometricRestore() async {
    if (phase != AuthPhase.biometricLocked || _biometricPending) {
      return BiometricOutcome.cancelled;
    }
    _biometricPending = true;
    final generation = _sessionGeneration;
    try {
      if (!await _canUnlock()) return BiometricOutcome.notAvailable;
      final outcome = await _biometricAuthenticator.authenticate(
        reason: 'Unlock rab to continue',
      );
      if (generation != _sessionGeneration) return BiometricOutcome.cancelled;
      if (outcome != BiometricOutcome.success) return outcome;
      if (!await _canUnlock()) return BiometricOutcome.notAvailable;
      final current = CurrentUser.fromJson(
        await api.get('/auth/me') as Map<String, dynamic>,
      );
      if (generation != _sessionGeneration) return BiometricOutcome.cancelled;
      if (!await _canUnlock()) return BiometricOutcome.notAvailable;
      if (current.id != rememberedUserId ||
          current.id != await api.getSessionUserId()) {
        await api.clearTokens();
        _handleSessionExpired();
        return BiometricOutcome.failed;
      }
      user = current;
      _unlockState = AppUnlockState.unlocked;
      biometricEnabledForCurrentUser = true;
      _setPhase(_phaseAfterUserLoaded());
      notifyListeners();
      return BiometricOutcome.success;
    } catch (error) {
      if (generation != _sessionGeneration) return BiometricOutcome.cancelled;
      if (error is ApiException &&
          (error.statusCode == 401 || error.statusCode == 403)) {
        await api.clearTokens();
        _handleSessionExpired();
      }
      // Connectivity failures keep the session/preference available for retry.
      return BiometricOutcome.error;
    } finally {
      _biometricPending = false;
    }
  }

  Future<bool> _canUnlock() async {
    if (!await _hasSession()) {
      _handleSessionExpired();
      return false;
    }
    final preference = await _biometricStore.getEnabledUserId();
    final owner = await api.getSessionUserId();
    if (preference == null ||
        owner != preference ||
        owner != rememberedUserId ||
        !_bindingValid(
          await _biometricStore.getBiometricConfirmedAt(),
          await _biometricStore.getLastFullAuthenticationAt(),
        )) {
      user = null;
      biometricEnabledForCurrentUser = false;
      _setPhase(AuthPhase.reauthRequired);
      notifyListeners();
      return false;
    }
    if (!(await checkBiometricCapability()).isAvailable) {
      fallBackToPassword();
      return false;
    }
    return true;
  }

  /// "Use password instead" on the lock screen — leaves stored tokens and
  /// the biometric enablement flag untouched (the user may still succeed
  /// biometrically next time); just routes back to the normal Welcome/Login
  /// flow for this app open.
  void fallBackToPassword() {
    _setPhase(AuthPhase.unauthenticated);
    notifyListeners();
  }

  /// Profile > Security toggle.
  ///
  /// MOB-02: gated on the age of the last PASSWORD authentication before the
  /// native biometric challenge is even attempted. Without this check, a
  /// successful re-confirmation here would `confirmBiometric()` with a fresh
  /// timestamp while `lastFullAuthenticationAt` stays stale — `_bindingValid`
  /// would then read that fresh `confirmedAt` as if the 90-day window had
  /// just restarted, when no real password reauthentication occurred. The
  /// deadline is only ever allowed to move by an actual password login.
  Future<bool> enableBiometric() async {
    if (phase != AuthPhase.authenticated || user == null || _biometricPending) {
      return false;
    }
    if (!_passwordAuthFresh(
      await _biometricStore.getLastFullAuthenticationAt(),
    )) {
      return false;
    }
    final generation = _sessionGeneration;
    final id = user!.id;
    _biometricPending = true;
    try {
      final outcome = await _biometricAuthenticator.authenticate(
        reason: 'Confirm biometric login for rab',
      );
      if (outcome != BiometricOutcome.success ||
          generation != _sessionGeneration ||
          user?.id != id) {
        return false;
      }
      await api.setSessionUserId(id);
      await _biometricStore.setRememberedAccount(id, user!.email);
      rememberedUserId = id;
      rememberedEmail = user!.email;
      await _biometricStore.confirmBiometric(id, _now());
      biometricEnabledForCurrentUser = true;
      notifyListeners();
      unawaited(_enforceDeadlineIfAuthenticated());
      return true;
    } finally {
      _biometricPending = false;
    }
  }

  Future<void> disableBiometric() async {
    await _biometricStore.clearEnabledUserId();
    biometricEnabledForCurrentUser = false;
    notifyListeners();
    unawaited(_enforceDeadlineIfAuthenticated());
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
  /// Success stays on the setup screen; explicit return requires a new login.
  Future<void> setPassword(String newPassword) async {
    await api.post('/auth/set-password', body: {'newPassword': newPassword});
    // Keep the setup screen mounted until the user explicitly returns to login.
  }

  Future<void> logout() async {
    if (_logoutPending) return;
    _logoutPending = true;
    ++_sessionGeneration;
    user = null;
    biometricEnabledForCurrentUser = false;
    _setPhase(AuthPhase.unauthenticated);
    notifyListeners();
    // Revokes the refresh token family server-side — clearing local storage
    // alone would just make this device forget a session still valid
    // everywhere else.
    try {
      final refreshToken = await api.getRefreshToken();
      if (refreshToken != null) {
        await api
            .post('/auth/logout', body: {'refreshToken': refreshToken})
            .timeout(const Duration(seconds: 10));
      }
    } catch (_) {
      // Best-effort: still clear the local session even if the revoke call fails.
    }
    await api.clearTokens();
    await api.clearLegacyApplicationPreference();
    // Normal logout preserves the remembered account and account-owned trust.
    _logoutPending = false;
    user = null;
    biometricEnabledForCurrentUser = false;
    _setPhase(AuthPhase.unauthenticated);
    notifyListeners();
  }

  void _handleSessionExpired() {
    user = null;
    biometricEnabledForCurrentUser = false;
    // Initialization owns its final notification after storage cleanup finishes.
    if (phase == AuthPhase.loading) return;
    _setPhase(AuthPhase.unauthenticated);
    notifyListeners();
  }

  /// MOB-01 — the one place (shared across every presentation: staff, venue
  /// manager, manager) that keeps the 90-day full-credential deadline
  /// enforced while the app stays authenticated. Re-entered every time
  /// `_setPhase` runs, so entering `authenticated` starts the check/timer
  /// and leaving it (logout, session expiry, falling back to password, a
  /// failed unlock) cancels the timer automatically — no separate
  /// bookkeeping needed at each of those call sites. The two triggers, per
  /// Phase 10's "use the existing lifecycle architecture, don't scatter
  /// observers" instruction: `didChangeAppLifecycleState` below (deadline
  /// passed while backgrounded/killed) and exactly one scheduled `Timer`
  /// (deadline passes while the app stays open and foregrounded).
  ///
  /// Scoped to `biometricEnabledForCurrentUser` — this mirrors exactly which
  /// sessions `_bindingValid`/`_canUnlock()` already gate: a user who never
  /// enabled biometrics never goes through those checks either, and their
  /// session validity is already fully governed by the server-side refresh
  /// token family's own `family_expires_at` (same 90-day policy, enforced on
  /// the next real API call — see `SessionValidityService` server-side).
  /// Enforcing this a second time, client-side, for a plain token-restore
  /// session would force a reauth this population was never meant to hit.
  Future<void> _enforceDeadlineIfAuthenticated() async {
    if (_disposed) return;
    _deadlineTimer?.cancel();
    _deadlineTimer = null;
    if (phase != AuthPhase.authenticated || !biometricEnabledForCurrentUser) {
      return;
    }
    final lastFullAuthAt = await _biometricStore.getLastFullAuthenticationAt();
    // Disposed (or moved on) while awaiting the storage read above — without
    // this check, a provider disposed mid-read would have nothing left to
    // cancel the Timer this function is about to create, leaking it past
    // the widget tree's lifetime.
    if (_disposed || phase != AuthPhase.authenticated) return;
    if (!_passwordAuthFresh(lastFullAuthAt)) {
      user = null;
      biometricEnabledForCurrentUser = false;
      _setPhase(AuthPhase.reauthRequired);
      notifyListeners();
      return;
    }
    final deadline = lastFullAuthAt!.add(
      const Duration(days: biometricFullReauthDays),
    );
    _deadlineTimer = Timer(deadline.difference(_now()), () {
      unawaited(_enforceDeadlineIfAuthenticated());
    });
  }

  void _setPhase(AuthPhase newPhase) {
    if (newPhase == AuthPhase.loading ||
        newPhase == AuthPhase.unauthenticated ||
        newPhase == AuthPhase.reauthRequired ||
        newPhase == AuthPhase.biometricLocked) {
      _unlockState = AppUnlockState.locked;
    }
    phase = newPhase;
    unawaited(_enforceDeadlineIfAuthenticated());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_enforceDeadlineIfAuthenticated());
    }
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _deadlineTimer?.cancel();
    super.dispose();
  }
}

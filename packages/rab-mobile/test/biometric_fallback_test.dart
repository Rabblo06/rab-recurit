import 'dart:convert';
import 'dart:async';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/rab_biometric_visual.dart';
import 'package:rab_staff/features/auth_flow/auth_flow_shell.dart';
import 'package:rab_staff/features/login/login_sheet_content.dart';
import 'package:rab_staff/features/biometric_lock/biometric_lock_sheet_content.dart';
import 'package:rab_staff/features/forgot_password/forgot_password_screen.dart';
import 'package:rab_staff/navigation/app_shell.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — a cancelled/failed/locked-out biometric attempt must never
/// be a dead end: the lock screen stays up (retry available) and "Use
/// password instead" always works.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    final fonts =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    await (FontLoader('Roboto')..addFont(
          File(
            '$fonts/roboto-regular.ttf',
          ).readAsBytes().then(ByteData.sublistView),
        ))
        .load();
  });

  late Map<String, String> secureStore;

  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  void seedEnabledUser() {
    secureStore['rab.biometric.enabledUserId'] = 'user-1';
    secureStore['rab.sessionUserId'] = 'user-1';
    secureStore['rab.biometric.rememberedAccount'] =
        '{"userId":"user-1","email":"alice@example.test"}';
    secureStore['rab.accessToken'] = 'stored-access';
    secureStore['rab.refreshToken'] = 'stored-refresh';
    secureStore['rab.biometric.confirmedAt'] = DateTime.now()
        .toUtc()
        .toIso8601String();
    // MOB-01/MOB-02: the 90-day deadline is anchored here, not confirmedAt —
    // a fixture representing a genuinely-valid existing binding needs both.
    secureStore['rab.biometric.lastFullAuthenticationAt'] = DateTime.now()
        .toUtc()
        .toIso8601String();
  }

  MockClient buildClient() => MockClient((request) async {
    if (request.url.path.endsWith('/auth/login')) {
      return http.Response(
        jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}),
        200,
      );
    }
    if (request.url.path.endsWith('/auth/me')) {
      return http.Response(jsonEncode(fakeUserJson()), 200);
    }
    return http.Response('not found', 404);
  });

  for (final outcome in [
    BiometricOutcome.cancelled,
    BiometricOutcome.failed,
    BiometricOutcome.lockedOut,
  ]) {
    test('$outcome keeps the lock state, never grants access', () async {
      seedEnabledUser();
      stubSecureStorageChannel(secureStore);

      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: buildClient()),
        biometricAuthenticator: FakeBiometricAuthenticator(outcome: outcome),
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);
      expect(auth.phase, AuthPhase.biometricLocked);

      final result = await auth.attemptBiometricRestore();

      expect(result, outcome);
      expect(auth.phase, AuthPhase.biometricLocked);
      expect(auth.user, isNull);
    });
  }

  test(
    '"Use password instead" reaches a working plain login, no dead end',
    () async {
      seedEnabledUser();
      stubSecureStorageChannel(secureStore);

      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: buildClient()),
        biometricAuthenticator: FakeBiometricAuthenticator(
          outcome: BiometricOutcome.failed,
        ),
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);
      await auth.attemptBiometricRestore();
      expect(auth.phase, AuthPhase.biometricLocked);

      auth.fallBackToPassword();
      expect(auth.phase, AuthPhase.unauthenticated);

      await auth.login('alice@example.test', 'password123');
      expect(auth.phase, AuthPhase.authenticated);
    },
  );
  Future<AuthProvider> mount(
    WidgetTester t,
    FakeBiometricAuthenticator bio, {
    Size size = const Size(393, 852),
    double scale = 1,
    double keyboard = 0,
    bool reauth = false,
    bool enabled = true,
    bool root = false,
    String role = 'staff',
    bool rejected = false,
  }) async {
    t.view.physicalSize = size;
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    stubSecureStorageChannel(secureStore);
    secureStore['rab.onboarding.hasSeenWelcome'] = 'true';
    if (enabled) seedEnabledUser();
    if (reauth) {
      // The 90-day deadline is anchored to lastFullAuthenticationAt, not
      // confirmedAt — staleness has to be simulated on that field.
      secureStore['rab.biometric.lastFullAuthenticationAt'] = DateTime.now()
          .subtract(const Duration(days: 91))
          .toIso8601String();
    }
    final auth = AuthProvider(
      apiClient: ApiClient(
        httpClient: MockClient((r) async {
          if (r.url.path.endsWith('/auth/me')) {
            return http.Response(
              jsonEncode({
                ...fakeUserJson(),
                'roles': [role],
              }),
              rejected ? 403 : 200,
            );
          }
          if (r.url.path.endsWith('/unread-count')) {
            return http.Response('{"count":0}', 200);
          }
          if (r.url.path.endsWith('/active')) {
            return http.Response('{"attendance":null}', 200);
          }
          if (r.url.path.endsWith('/capabilities')) {
            return http.Response('{}', 200);
          }
          return http.Response('[]', 200);
        }),
      ),
      biometricAuthenticator: bio,
    );
    await auth.initialized;
    // `create:` (not `.value()`) so provider disposes `auth` when the
    // framework unmounts the tree between tests — MOB-01's 90-day deadline
    // Timer must be cancelled before flutter_test's own pending-timer check,
    // which runs before `addTearDown` callbacks ever get a chance to.
    await t.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => auth,
        child: root
            ? const RabApp()
            : MaterialApp(
                theme: buildLightTheme(),
                home: MediaQuery(
                  data: MediaQueryData(
                    size: size,
                    textScaler: TextScaler.linear(scale),
                    viewInsets: EdgeInsets.only(bottom: keyboard),
                    disableAnimations: scale > 1,
                  ),
                  child: const AuthFlowShell(),
                ),
              ),
      ),
    );
    await t.pumpAndSettle();
    return auth;
  }

  testWidgets(
    'ready, explicit prompt, duplicate guard, clean retry and stable sheet',
    (t) async {
      final bio = _ControlledBiometric();
      await mount(t, bio);
      expect(bio.authenticateCalls, 0);
      expect(find.text('Welcome back'), findsOneWidget);
      expect(find.byType(RabBiometricVisual), findsNothing);
      final heading = t.getTopLeft(find.text('Welcome back'));
      expect(find.text('alice@example.test'), findsOneWidget);
      expect(find.text('Saved account'), findsNothing);
      expect(find.byType(TextField), findsNothing);
      bio.pending = Completer<BiometricOutcome>();
      await t.tap(find.text('Continue with passkey'));
      await t.pump();
      expect(bio.authenticateCalls, 1);
      expect(find.text('Authenticating...'), findsOneWidget);
      await t.tap(find.text('Authenticating...'));
      expect(bio.authenticateCalls, 1);
      bio.pending!.complete(BiometricOutcome.cancelled);
      await t.pumpAndSettle();
      expect(find.text('Try again'), findsOneWidget);
      expect(t.getTopLeft(find.text('Welcome back')), heading);
      bio.pending = null;
      bio.outcome = BiometricOutcome.failed;
      await t.tap(find.text('Try again'));
      await t.pumpAndSettle();
      expect(bio.authenticateCalls, 2);
      expect(t.getTopLeft(find.text('Welcome back')), heading);
    },
  );
  testWidgets(
    'fallback reuses mounted form, no new route, return resets ready',
    (t) async {
      final bio = FakeBiometricAuthenticator();
      final auth = await mount(t, bio);
      final shell = t.state(find.byType(AuthFlowShell));
      final heading = t.getTopLeft(find.text('Welcome back'));
      await t.tap(find.text('Use password instead'));
      await t.pumpAndSettle();
      expect(find.text('Sign in with a password'), findsOneWidget);
      expect(find.byType(LoginSheetContent), findsOneWidget);
      expect(auth.phase, AuthPhase.biometricLocked);
      final login = t.state(find.byType(LoginSheetContent));
      expect(
        t.widget<TextField>(find.byType(TextField).first).controller!.text,
        'alice@example.test',
      );
      expect(t.state(find.byType(AuthFlowShell)), same(shell));
      expect(t.getTopLeft(find.text('Welcome back')), heading);
      expect(
        Navigator.of(t.element(find.byType(LoginSheetContent))).canPop(),
        false,
      );
      await t.enterText(find.byType(TextField).first, 'typed@example.test');
      await t.enterText(find.byType(TextField).last, 'not-persisted');
      FocusManager.instance.primaryFocus?.unfocus();
      await t.pumpAndSettle();
      await t.ensureVisible(find.text('Continue with passkey'));
      await t.tap(find.text('Continue with passkey'));
      await t.pumpAndSettle();
      expect(find.byType(BiometricLockSheetContent), findsOneWidget);
      expect(bio.authenticateCalls, 0);
      await t.tap(find.text('Use password instead'));
      await t.pumpAndSettle();
      expect(t.state(find.byType(LoginSheetContent)), same(login));
      expect(
        t.widget<TextField>(find.byType(TextField).first).controller!.text,
        'typed@example.test',
      );
      await t.tap(find.text('Forgot password?'));
      await t.pumpAndSettle();
      expect(find.byType(ForgotPasswordScreen), findsOneWidget);
    },
  );
  for (final reauth in [false, true]) {
    testWidgets('normal/mandatory reauth has no biometric escape $reauth', (
      t,
    ) async {
      final bio = FakeBiometricAuthenticator();
      await mount(t, bio, enabled: reauth, reauth: reauth);
      expect(find.text('Sign in to your account'), findsOneWidget);
      expect(find.text('Continue with passkey'), findsNothing);
      expect(bio.authenticateCalls, 0);
    });
  }
  testWidgets(
    'hardware loss goes to normal password and lockout stays recoverable',
    (t) async {
      final bio = FakeBiometricAuthenticator(
        outcome: BiometricOutcome.lockedOut,
      );
      await mount(t, bio);
      await t.tap(find.text('Continue with passkey'));
      await t.pumpAndSettle();
      expect(
        find.text('Too many attempts. Use your password or try again shortly.'),
        findsOneWidget,
      );
      bio.outcome = BiometricOutcome.notAvailable;
      await t.tap(find.text('Try again'));
      await t.pumpAndSettle();
      expect(find.text('Sign in to your account'), findsOneWidget);
      expect(find.text('Continue with passkey'), findsNothing);
    },
  );
  for (final role in ['staff', 'venue_manager']) {
    testWidgets('explicit biometric validates session and routes $role', (
      t,
    ) async {
      final bio = FakeBiometricAuthenticator();
      final auth = await mount(t, bio, root: true, role: role);
      expect(auth.user, isNull);
      await t.tap(find.text('Continue with passkey'));
      await t.pumpAndSettle();
      expect(auth.phase, AuthPhase.authenticated);
      expect(
        find.byType(role == 'staff' ? AppShell : VenueManagerShell),
        findsOneWidget,
      );
    });
  }
  testWidgets(
    'local success with rejected server session never grants access',
    (t) async {
      final auth = await mount(
        t,
        FakeBiometricAuthenticator(),
        root: true,
        rejected: true,
      );
      await t.tap(find.text('Continue with passkey'));
      await t.pumpAndSettle();
      expect(auth.user, isNull);
      expect(auth.phase, AuthPhase.unauthenticated);
      expect(find.text('Continue with passkey'), findsNothing);
    },
  );
  for (final size in [
    const Size(320, 568),
    const Size(393, 852),
    const Size(430, 932),
    const Size(390, 844),
  ]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('four-state auth responsive $size at $scale', (t) async {
        await mount(
          t,
          FakeBiometricAuthenticator(outcome: BiometricOutcome.failed),
          size: size,
          scale: scale,
        );
        await t.ensureVisible(find.text('Continue with passkey'));
        await t.tap(find.text('Continue with passkey'));
        await t.pumpAndSettle();
        expect(find.text('Try again'), findsOneWidget);
        await t.ensureVisible(find.text('Use password instead'));
        await t.tap(find.text('Use password instead'));
        await t.pumpAndSettle();
        await t.ensureVisible(find.text('Sign In'));
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
      });
    }
  }
  for (final enabled in [false, true]) {
    testWidgets(
      'keyboard and 200 percent text keep sign in reachable $enabled',
      (t) async {
        await mount(
          t,
          FakeBiometricAuthenticator(),
          enabled: enabled,
          size: const Size(320, 568),
          scale: 2,
          keyboard: 260,
        );
        if (enabled) {
          await t.ensureVisible(find.text('Use password instead'));
          await t.tap(find.text('Use password instead'));
          await t.pumpAndSettle();
        }
        await t.ensureVisible(find.byType(TextField).last);
        await t.enterText(find.byType(TextField).last, 'not-persisted');
        await t.ensureVisible(find.text('Sign In'));
        await t.pumpAndSettle();
        expect(
          t.getBottomRight(find.widgetWithText(FilledButton, 'Sign In')).dy,
          lessThanOrEqualTo(308),
        );
        expect(t.takeException(), isNull);
      },
    );
  }
}

class _ControlledBiometric extends FakeBiometricAuthenticator {
  Completer<BiometricOutcome>? pending;
  @override
  Future<BiometricOutcome> authenticate({required String reason}) async {
    authenticateCalls++;
    return pending == null ? outcome : pending!.future;
  }
}

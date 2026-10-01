import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/widgets/rab_auth_sheet.dart';
import 'package:rab_staff/core/widgets/rab_biometric_visual.dart';
import 'package:rab_staff/features/auth_flow/auth_flow_shell.dart';
import 'package:rab_staff/features/biometric_setup/biometric_setup_sheet_content.dart';
import 'package:rab_staff/navigation/app_shell.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — the post-first-login setup offer: shown when capability is
/// available+enrolled and not yet enabled for this account; skipped
/// entirely otherwise.
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

  MockClient buildClient() => MockClient((request) async {
    final path = request.url.path;
    if (path.endsWith('/auth/login')) {
      return http.Response(
        jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}),
        200,
      );
    }
    if (path.endsWith('/auth/me')) {
      return http.Response(jsonEncode(fakeUserJson()), 200);
    }
    return http.Response('not found', 404);
  });

  test(
    'capability available + enrolled -> offered after login; enabling persists it',
    () async {
      stubSecureStorageChannel(secureStore);
      final fakeAuth = FakeBiometricAuthenticator();
      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: buildClient()),
        biometricAuthenticator: fakeAuth,
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);

      await auth.login('alice@example.test', 'password123');

      expect(auth.phase, AuthPhase.offeringBiometricSetup);
      expect(secureStore.containsKey('rab.biometric.enabledUserId'), isFalse);

      await auth.completeBiometricSetup(enable: true);

      expect(auth.phase, AuthPhase.authenticated);
      expect(auth.biometricEnabledForCurrentUser, isTrue);
      expect(secureStore['rab.biometric.enabledUserId'], 'user-1');
      expect(
        fakeAuth.authenticateCalls,
        1,
      ); // one live check to confirm the sensor works
    },
  );

  test('"Not Now" proceeds without persisting anything', () async {
    stubSecureStorageChannel(secureStore);
    final fakeAuth = FakeBiometricAuthenticator();
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: fakeAuth,
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    await auth.login('alice@example.test', 'password123');
    expect(auth.phase, AuthPhase.offeringBiometricSetup);

    await auth.completeBiometricSetup(enable: false);

    expect(auth.phase, AuthPhase.authenticated);
    expect(auth.biometricEnabledForCurrentUser, isFalse);
    expect(secureStore.containsKey('rab.biometric.enabledUserId'), isFalse);
    expect(
      fakeAuth.authenticateCalls,
      0,
    ); // never touches the sensor for a decline
  });

  test(
    'device with no biometric hardware/enrollment: never offered, straight to authenticated',
    () async {
      stubSecureStorageChannel(secureStore);
      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: buildClient()),
        biometricAuthenticator: FakeBiometricAuthenticator(
          capability: BiometricCapability.unavailable,
        ),
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);

      await auth.login('alice@example.test', 'password123');

      expect(auth.phase, AuthPhase.authenticated);
    },
  );

  Future<AuthProvider> mount(
    WidgetTester t,
    FakeBiometricAuthenticator bio, {
    Size size = const Size(393, 851),
    double scale = 1,
    String role = 'staff',
    bool removeHardware = false,
  }) async {
    t.view.physicalSize = size;
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    stubSecureStorageChannel(secureStore);
    secureStore['rab.onboarding.hasSeenWelcome'] = 'true';
    final auth = AuthProvider(
      biometricAuthenticator: bio,
      apiClient: ApiClient(
        httpClient: MockClient((r) async {
          final path = r.url.path;
          if (path.endsWith('/auth/login')) {
            return http.Response(
              '{"accessToken":"fixture-access","refreshToken":"fixture-refresh"}',
              200,
            );
          }
          if (path.endsWith('/auth/me')) {
            return http.Response(
              jsonEncode({
                ...fakeUserJson(),
                'roles': [role],
              }),
              200,
            );
          }
          if (path.endsWith('/unread-count')) {
            return http.Response('{"count":0}', 200);
          }
          if (path.endsWith('/active')) {
            return http.Response('{"attendance":null}', 200);
          }
          if (path.endsWith('/capabilities')) return http.Response('{}', 200);
          return http.Response('[]', 200);
        }),
      ),
    );
    await auth.initialized;
    await auth.login('alice@example.test', 'fixture-password');
    if (removeHardware) bio.capability = BiometricCapability.unavailable;
    t.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
    // `create:` (not `.value()`) so provider disposes `auth` when the
    // framework unmounts the tree between tests — MOB-01's 90-day deadline
    // Timer must be cancelled before flutter_test's own pending-timer check,
    // which runs before `addTearDown` callbacks ever get a chance to.
    await t.pumpWidget(
      ChangeNotifierProvider(create: (_) => auth, child: const RabApp()),
    );
    await t.pumpAndSettle();
    return auth;
  }

  testWidgets(
    'reference composition uses shared sheet/button/footer and no green hero',
    (t) async {
      await mount(t, FakeBiometricAuthenticator());
      expect(find.text('Set up Biometric Login'), findsOneWidget);
      expect(find.text('Log in to see your shifts.'), findsOneWidget);
      expect(find.text('Setup the passkey Login'), findsOneWidget);
      expect(find.text('Protected by your device biometrics.'), findsOneWidget);
      expect(find.byIcon(Icons.verified_user_outlined), findsOneWidget);
      expect(find.byIcon(Icons.fingerprint), findsNWidgets(2));
      expect(find.byType(RabBiometricVisual), findsNothing);
      expect(find.byType(AuthSheet), findsOneWidget);
      expect(find.byType(AuthPrimaryButton), findsOneWidget);
      expect(t.widget<AuthSheet>(find.byType(AuthSheet)).isSetup, isTrue);
      final circle = t.widget<Container>(
        find.byKey(const ValueKey('biometric-setup-circle')),
      );
      expect((circle.decoration as BoxDecoration).shape, BoxShape.circle);
      expect(
        t.getSize(find.byKey(const ValueKey('biometric-setup-circle'))),
        const Size(80, 80),
      );
      final button = t.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Enable Passkey'),
      );
      expect(button.style!.backgroundColor!.resolve({}), Colors.black);
      expect(find.text('Skip for now'), findsOneWidget);
    },
  );

  for (final outcome in [
    BiometricOutcome.cancelled,
    BiometricOutcome.failed,
    BiometricOutcome.lockedOut,
    BiometricOutcome.error,
  ]) {
    testWidgets('$outcome stays mounted, writes no trust, permits retry/skip', (
      t,
    ) async {
      final bio = FakeBiometricAuthenticator(outcome: outcome);
      final auth = await mount(t, bio);
      final shell = t.state(find.byType(AuthFlowShell));
      final setup = t.state(find.byType(BiometricSetupSheetContent));
      final nav = Navigator.of(
        t.element(find.byType(BiometricSetupSheetContent)),
      );
      await t.tap(find.text('Enable Passkey'));
      await t.pumpAndSettle();
      expect(bio.authenticateCalls, 1);
      expect(auth.phase, AuthPhase.offeringBiometricSetup);
      expect(auth.biometricEnabledForCurrentUser, isFalse);
      expect(secureStore['rab.biometric.confirmedAt'], isNull);
      expect(t.state(find.byType(AuthFlowShell)), same(shell));
      expect(t.state(find.byType(BiometricSetupSheetContent)), same(setup));
      expect(nav.canPop(), isFalse);
      expect(find.textContaining('skip for now.'), findsOneWidget);
      await t.ensureVisible(find.text('Skip for now'));
      await t.tap(find.text('Skip for now'));
      await t.pumpAndSettle();
      expect(auth.phase, AuthPhase.authenticated);
      expect(find.byType(AppShell), findsOneWidget);
      expect(bio.authenticateCalls, 1);
    });
  }
  for (final role in ['staff', 'venue_manager']) {
    testWidgets(
      'native success enables trust and preserves $role root routing',
      (t) async {
        final auth = await mount(t, FakeBiometricAuthenticator(), role: role);
        await t.tap(find.text('Enable Passkey'));
        await t.pumpAndSettle();
        expect(auth.phase, AuthPhase.authenticated);
        expect(auth.biometricEnabledForCurrentUser, isTrue);
        expect(secureStore['rab.biometric.enabledUserId'], 'user-1');
        expect(secureStore['rab.biometric.confirmedAt'], isNotNull);
        expect(
          find.byType(role == 'staff' ? AppShell : VenueManagerShell),
          findsOneWidget,
        );
        expect(find.byType(BiometricSetupSheetContent), findsNothing);
      },
    );
  }
  testWidgets('skip never opens native prompt or saves binding', (t) async {
    final bio = FakeBiometricAuthenticator();
    final auth = await mount(t, bio);
    await t.tap(find.text('Skip for now'));
    await t.pumpAndSettle();
    expect(auth.phase, AuthPhase.authenticated);
    expect(bio.authenticateCalls, 0);
    expect(secureStore['rab.biometric.confirmedAt'], isNull);
  });
  testWidgets('hardware removed before mounting skips unusable setup', (
    t,
  ) async {
    final auth = await mount(
      t,
      FakeBiometricAuthenticator(),
      removeHardware: true,
    );
    expect(auth.phase, AuthPhase.authenticated);
    expect(find.byType(BiometricSetupSheetContent), findsNothing);
  });
  testWidgets('busy confirmation blocks repeated Enable and Skip taps', (
    t,
  ) async {
    final bio = _DeferredSetup();
    final auth = await mount(t, bio);
    await t.tap(find.text('Enable Passkey'));
    await t.pump();
    await t.tap(find.text('Enable Passkey'));
    await t.tap(find.text('Skip for now'));
    expect(bio.authenticateCalls, 1);
    expect(auth.phase, AuthPhase.offeringBiometricSetup);
    bio.result.complete(BiometricOutcome.cancelled);
    await t.pumpAndSettle();
    expect(auth.phase, AuthPhase.offeringBiometricSetup);
  });
  for (final size in [
    const Size(320, 568),
    const Size(393, 851),
    const Size(430, 932),
    const Size(390, 844),
  ]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('setup responsive $size at $scale text', (t) async {
        await mount(t, FakeBiometricAuthenticator(), size: size, scale: scale);
        expect(t.takeException(), isNull);
        await t.ensureVisible(find.text('Enable Passkey'));
        await t.pumpAndSettle();
        expect(find.text('Enable Passkey').hitTestable(), findsOneWidget);
        await t.ensureVisible(find.text('Skip for now'));
        await t.pumpAndSettle();
        expect(find.text('Skip for now').hitTestable(), findsOneWidget);
        await t.ensureVisible(
          find.text('Protected by your device biometrics.'),
        );
        expect(t.takeException(), isNull);
      });
    }
  }
}

class _DeferredSetup extends FakeBiometricAuthenticator {
  final result = Completer<BiometricOutcome>();
  @override
  Future<BiometricOutcome> authenticate({required String reason}) {
    authenticateCalls++;
    return result.future;
  }
}

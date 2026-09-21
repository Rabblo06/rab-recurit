import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/rab_auth_sheet.dart';
import 'package:rab_staff/core/widgets/rab_atmospheric_background.dart';
import 'package:rab_staff/core/widgets/rab_round_back_button.dart';
import 'package:rab_staff/features/auth_flow/auth_flow_shell.dart';

import 'support/biometric_test_support.dart';

/// Welcome only ever offers one action ("Get Started" — see the reference
/// design; there is no self-registration flow anywhere in the app, so a
/// separate "Create Account" control never existed as real functionality
/// here). Proves: Get Started reveals the Login step in-place (no separate
/// pushed screen), and that completing it persists `hasSeenWelcome` so a
/// fresh `AuthFlowShell` mount (simulating an app restart) skips Welcome.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;
  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 80; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  AuthProvider freshAuth() => AuthProvider(
    apiClient: ApiClient(),
    biometricAuthenticator: FakeBiometricAuthenticator(
      capability: BiometricCapability.unavailable,
    ),
  );

  testWidgets(
    'Back sends the sheet below the viewport before contracting the header',
    (tester) async {
      stubSecureStorageChannel(secureStore);
      final auth = freshAuth();
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: auth,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: const AuthFlowShell(),
          ),
        ),
      );
      await settle(tester);
      await tester.tap(find.text('Get Started'));
      await settle(tester);
      await tester.tap(find.byType(RabRoundBackButton));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 240));
      expect(tester.widget<AuthBackdrop>(find.byType(AuthBackdrop)).t, 1);
      expect(
        tester.widget<AuthSheet>(find.byType(AuthSheet)).progress,
        lessThan(1),
      );
      await tester.pump(const Duration(milliseconds: 250));
      expect(tester.widget<AuthSheet>(find.byType(AuthSheet)).progress, 0);
      await settle(tester);
      expect(find.byType(AuthSheet), findsNothing);
      expect(tester.widget<AuthBackdrop>(find.byType(AuthBackdrop)).t, 0);
      expect(find.text('Get Started'), findsOneWidget);
    },
  );

  testWidgets(
    'Get Started reveals Login in place, with no separate pushed screen',
    (tester) async {
      stubSecureStorageChannel(secureStore);
      final auth = freshAuth();

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: auth,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: const AuthFlowShell(),
          ),
        ),
      );
      await settle(tester);

      expect(find.text('Get Started'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);

      await tester.tap(find.text('Get Started'));
      await settle(tester);

      expect(find.byType(TextField), findsNWidgets(2));
      expect(find.text('Get Started'), findsNothing);
    },
  );

  testWidgets(
    'completing Welcome persists hasSeenWelcome for the next app open',
    (tester) async {
      stubSecureStorageChannel(secureStore);
      final auth = freshAuth();
      await waitUntilPhaseNot(auth, AuthPhase.loading);
      expect(auth.hasSeenWelcome, isFalse);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: auth,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: const AuthFlowShell(),
          ),
        ),
      );
      await settle(tester);

      await tester.tap(find.text('Get Started'));
      await settle(tester);
      expect(auth.hasSeenWelcome, isTrue);
      expect(secureStore['rab.onboarding.hasSeenWelcome'], 'true');

      // A brand new `AuthProvider` reading the same persisted store — the
      // "next app open" this device will actually see.
      final restarted = freshAuth();
      await waitUntilPhaseNot(restarted, AuthPhase.loading);
      expect(restarted.hasSeenWelcome, isTrue);

      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: restarted,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: const AuthFlowShell(),
          ),
        ),
      );
      await settle(tester);

      expect(find.text('Get Started'), findsNothing);
      expect(find.byType(TextField), findsNWidgets(2));
    },
  );
}

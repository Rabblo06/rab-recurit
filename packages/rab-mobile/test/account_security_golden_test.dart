import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/features/login/second_factor_screen.dart';
import 'package:rab_staff/features/login/update_required_screen.dart';
import 'package:rab_staff/features/profile/security_screen.dart';
import 'package:rab_staff/features/security/two_factor/change_two_factor_screens.dart';
import 'package:rab_staff/features/security/two_factor/enrolment_screens.dart';
import 'package:rab_staff/features/security/two_factor/two_factor_api.dart';

import 'support/account_security_test_support.dart';
import 'support/biometric_test_support.dart';

/// Goldens for the 13 mobile states of `docs/design/crewflow-account-security.html`
/// at 390×844 and 360×800 (logical px, DPR 1). They are the visual evidence
/// for the FLAG_SECURE screens (setup key, recovery codes), which an emulator
/// screenshot shows black by design.
///
/// `--dart-define=ACCOUNT_SECURITY_CAPTURE_DIR=<dir>` additionally writes each
/// state at 2× as `and-<state>@<w>x<h>.png` for the design comparison.
const _captureDir = String.fromEnvironment('ACCOUNT_SECURITY_CAPTURE_DIR');

void main() {
  setUpAll(loadGoldenFonts);

  const sizes = [Size(390, 844), Size(360, 800)];
  final rootKey = GlobalKey();

  Future<void> snap(WidgetTester tester, String state, Size size) async {
    FocusManager.instance.primaryFocus?.unfocus();
    await settleFrames(tester, 30);
    // Let any ink from a tap in the setup finish.
    await tester.pump(const Duration(seconds: 2));
    final name = '$state-${size.width.toInt()}x${size.height.toInt()}';
    await expectLater(
      find.byKey(rootKey),
      matchesGoldenFile('goldens/account_security/$name.png'),
    );
    if (_captureDir.isNotEmpty) {
      await tester.runAsync(() async {
        final boundary =
            rootKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        final file = File(
          '$_captureDir/and-$state@${size.width.toInt()}x${size.height.toInt()}.png',
        );
        await file.parent.create(recursive: true);
        await file.writeAsBytes(bytes!.buffer.asUint8List());
      });
    }
  }

  Future<void> pumpScreen(
    WidgetTester tester,
    Size size,
    AuthProvider auth,
    Widget home,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      RepaintBoundary(key: rootKey, child: securityHarness(auth, home)),
    );
    await settleFrames(tester);
  }

  MockClient statusClient(Map<String, dynamic> status) => MockClient(
    (request) async => request.url.path.endsWith('/auth/mfa')
        ? jsonResponse(status, 200)
        : http.Response('not found', 404),
  );

  Future<AuthProvider> challenged(WidgetTester tester, http.Response Function() verify) async {
    stubSecureStorageChannel({});
    addTearDown(clearSecureStorageChannel);
    final auth = AuthProvider(
      apiClient: ApiClient(
        httpClient: MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/auth/login')) {
            return jsonResponse({'code': 'SECOND_FACTOR_REQUIRED', 'requirement': 'verify', 'challengeToken': 'mfc_g', 'challengeExpiresAt': 'x'}, 409);
          }
          if (path.endsWith('/auth/mfa/challenge/verify')) return verify();
          return http.Response('', 204);
        }),
      ),
      biometricAuthenticator: FakeBiometricAuthenticator(capability: BiometricCapability.unavailable),
    );
    addTearDown(auth.dispose);
    await tester.runAsync(() async {
      await auth.initialized;
      try {
        await auth.login('stafftest1@example.test', 'pw');
      } on SecondFactorRequired {
        // the state under test
      }
    });
    return auth;
  }

  final states = <String, Future<void> Function(WidgetTester, Size)>{
    'off': (tester, size) async {
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson()), biometricOn: true);
      await pumpScreen(tester, size, auth, const SecurityScreen());
    },
    'password': (tester, size) async {
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson()));
      await pumpScreen(tester, size, auth, ConfirmIdentityScreen(api: TwoFactorApi(auth.api), hasPassword: true));
      await tester.enterText(find.byKey(const ValueKey('current-password')), 'sample-password');
    },
    'setup': (tester, size) async {
      installFakeSecurityPlatform();
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson()));
      await pumpScreen(
        tester,
        size,
        auth,
        ConnectAuthenticatorScreen(
          api: TwoFactorApi(auth.api),
          material: const EnrolmentMaterial(otpauthUri: testOtpauthUri, manualKey: testManualKey),
        ),
      );
      await tester.enterText(find.byKey(const ValueKey('otp-input')), '482913');
    },
    'codes': (tester, size) async {
      installFakeSecurityPlatform();
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson()));
      await pumpScreen(tester, size, auth, const RecoveryCodesScreen(codes: testRecoveryCodes));
    },
    'on': (tester, size) async {
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson(enabled: true, remaining: 8, total: 10)), biometricOn: true);
      await pumpScreen(tester, size, auth, const SecurityScreen());
    },
    'low': (tester, size) async {
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson(enabled: true, remaining: 2, total: 10)), biometricOn: true);
      await pumpScreen(tester, size, auth, const SecurityScreen());
    },
    'code': (tester, size) async {
      final auth = await challenged(tester, () => jsonResponse({}, 500));
      await pumpScreen(tester, size, auth, const SecondFactorScreen(email: 'stafftest1@example.test'));
    },
    'invalid': (tester, size) async {
      final auth = await challenged(tester, () => jsonResponse({'code': 'MFA_CODE_INVALID', 'state': 'invalid_code', 'attemptsRemaining': 3, 'message': 'x'}, 401));
      await pumpScreen(tester, size, auth, const SecondFactorScreen(email: 'stafftest1@example.test'));
      await tester.enterText(find.byKey(const ValueKey('otp-input')), '123456');
      await tester.pump();
      await tester.tap(find.text('Verify'));
    },
    'recovery': (tester, size) async {
      final auth = await challenged(tester, () => jsonResponse({}, 500));
      await pumpScreen(tester, size, auth, const SecondFactorScreen(email: 'stafftest1@example.test'));
      await tester.tap(find.text('Use a recovery code'));
      await settleFrames(tester);
      await tester.enterText(find.byKey(const ValueKey('recovery-code')), testRecoveryCodes.first);
    },
    'expired': (tester, size) async {
      final auth = await challenged(tester, () => jsonResponse({'code': 'MFA_CHALLENGE_EXPIRED', 'state': 'expired', 'message': 'x'}, 401));
      await pumpScreen(tester, size, auth, const SecondFactorScreen(email: 'stafftest1@example.test'));
      await tester.enterText(find.byKey(const ValueKey('otp-input')), '123456');
      await tester.pump();
      await tester.tap(find.text('Verify'));
    },
    'update': (tester, size) async {
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson()));
      await pumpScreen(tester, size, auth, const UpdateRequiredScreen());
    },
    'disable': (tester, size) async {
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson(enabled: true, remaining: 8, total: 10)));
      await pumpScreen(tester, size, auth, TurnOffTwoFactorScreen(api: TwoFactorApi(auth.api), hasPassword: true));
      await tester.enterText(find.byKey(const ValueKey('current-password')), 'sample-password');
      await tester.enterText(find.byKey(const ValueKey('otp-input')), '482913');
    },
    'regenerate': (tester, size) async {
      final auth = await signedInAuth(tester, statusClient(mfaStatusJson(enabled: true, remaining: 8, total: 10)));
      await pumpScreen(tester, size, auth, RegenerateCodesScreen(api: TwoFactorApi(auth.api), hasPassword: true));
      await tester.enterText(find.byKey(const ValueKey('current-password')), 'sample-password');
      await tester.enterText(find.byKey(const ValueKey('otp-input')), '482913');
    },
  };

  for (final size in sizes) {
    for (final entry in states.entries) {
      testWidgets('${entry.key} @ ${size.width.toInt()}x${size.height.toInt()} golden', (tester) async {
        await entry.value(tester, size);
        await snap(tester, entry.key, size);
        expect(tester.takeException(), isNull);
      });
    }
  }
}

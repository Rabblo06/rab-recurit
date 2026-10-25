import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/features/login/second_factor_screen.dart';
import 'package:rab_staff/features/login/update_required_screen.dart';
import 'package:rab_staff/features/profile/security_screen.dart';
import 'package:rab_staff/features/security/security_platform.dart';
import 'package:rab_staff/features/security/security_tokens.dart';
import 'package:rab_staff/features/security/two_factor/enrolment_screens.dart';
import 'package:rab_staff/features/security/two_factor/two_factor_api.dart';
import 'package:rab_staff/features/security/widgets/otp_code_field.dart';

import 'support/account_security_test_support.dart';
import 'support/biometric_test_support.dart';

/// Account security on Android (design M1–M13): every state renders from the
/// real API contract (STEP1_REPORT), success is shown only after the server
/// confirms, codes and setup keys are never stored, FLAG_SECURE covers the
/// setup key and recovery codes and is cleared when they leave.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Finder text(String value) => find.text(value);

  /// A phone-width surface tall enough that nothing in a flow is off screen.
  void tallPhone(WidgetTester tester) {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 2000);
    addTearDown(tester.view.reset);
  }

  group('OTP field (one real TextField behind six boxes)', () {
    testWidgets(
      'paste "482 913" lands whole; one-time-code autofill; digits only; max 6',
      (tester) async {
        tallPhone(tester);
        final controller = TextEditingController();
        addTearDown(controller.dispose);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(24),
                child: OtpCodeField(controller: controller),
              ),
            ),
          ),
        );
        expect(find.byType(TextField), findsOneWidget);
        final field = tester.widget<TextField>(find.byType(TextField));
        expect(field.autofillHints, [AutofillHints.oneTimeCode]);
        expect(field.keyboardType, TextInputType.number);

        // A paste arrives as one editing value: the formatters keep the digits.
        await tester.enterText(find.byType(TextField), '482 913');
        await tester.pump();
        expect(controller.text, '482913');
        for (final d in ['4', '8', '2', '9', '1', '3']) {
          expect(text(d), findsOneWidget);
        }
        expect(text('—'), findsNothing);

        // A full code pasted / autofilled over a full field replaces it.
        tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: '482913654321',
            selection: TextSelection.collapsed(offset: 12),
          ),
        );
        await tester.pump();
        expect(controller.text, '654321');
        await tester.enterText(find.byType(TextField), '');
        await tester.enterText(find.byType(TextField), '12345678ab');
        await tester.pump();
        expect(controller.text, '123456');

        await tester.enterText(find.byType(TextField), '');
        await tester.pump();
        expect(text('—'), findsNWidgets(6));
      },
    );

    testWidgets('exposes one labelled text field to accessibility', (
      tester,
    ) async {
      tallPhone(tester);
      final handle = tester.ensureSemantics();
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: OtpCodeField(controller: controller)),
        ),
      );
      expect(
        find.bySemanticsLabel(RegExp('6-digit authentication code')),
        findsOneWidget,
      );
      handle.dispose();
    });
  });

  group('sign-in verification (M7–M11)', () {
    late List<Map<String, dynamic>> verifyBodies;
    late int cancels;

    MockClient challengeClient(
      http.Response Function(Map<String, dynamic> body, int attempt) verify,
    ) {
      verifyBodies = [];
      cancels = 0;
      return MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/auth/login')) {
          return jsonResponse({
            'code': 'SECOND_FACTOR_REQUIRED',
            'requirement': 'verify',
            'challengeToken': 'mfc_t',
            'challengeExpiresAt': 'x',
          }, 409);
        }
        if (path.endsWith('/auth/mfa/challenge/verify')) {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          verifyBodies.add(body);
          return verify(body, verifyBodies.length);
        }
        if (path.endsWith('/auth/mfa/challenge/cancel')) {
          cancels++;
          return http.Response('', 204);
        }
        if (path.endsWith('/auth/me')) return jsonResponse(fakeUserJson(), 200);
        return http.Response('not found', 404);
      });
    }

    Future<AuthProvider> pendingChallenge(
      WidgetTester tester,
      MockClient client,
    ) async {
      final secure = <String, String>{};
      stubSecureStorageChannel(secure);
      addTearDown(clearSecureStorageChannel);
      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: client),
        biometricAuthenticator: FakeBiometricAuthenticator(
          capability: BiometricCapability.unavailable,
        ),
      );
      addTearDown(auth.dispose);
      await tester.runAsync(() async {
        await auth.initialized;
        try {
          await auth.login('stafftest1@example.test', 'pw');
          fail('expected a second factor');
        } on SecondFactorRequired {
          // expected
        }
      });
      expect(auth.secondFactorPending, isTrue);
      return auth;
    }

    /// Pushes the screen over a stand-in login page and records how it left.
    Future<List<SecondFactorOutcome?>> openScreen(
      WidgetTester tester,
      AuthProvider auth,
    ) async {
      final outcomes = <SecondFactorOutcome?>[];
      await tester.pumpWidget(
        securityHarness(
          auth,
          Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () async => outcomes.add(
                    await Navigator.of(context).push<SecondFactorOutcome>(
                      MaterialPageRoute(
                        builder: (_) => const SecondFactorScreen(
                          email: 'stafftest1@example.test',
                        ),
                      ),
                    ),
                  ),
                  child: const Text('login page'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(text('login page'));
      await settleFrames(tester);
      return outcomes;
    }

    Future<void> enterAndVerify(
      WidgetTester tester,
      String code, {
      String button = 'Verify',
    }) async {
      await tester.enterText(find.byType(TextField).first, code);
      await tester.pump();
      await tester.tap(text(button));
      await settleFrames(tester);
    }

    testWidgets(
      'code view: account chip, empty boxes, Verify disabled below 6 digits; nothing stored',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient((_, _) => jsonResponse({}, 500)),
        );
        await openScreen(tester, auth);
        expect(text('Verify your sign-in'), findsOneWidget);
        expect(text('stafftest1@example.test'), findsOneWidget);
        expect(text('—'), findsNWidgets(6));
        await tester.enterText(find.byType(TextField).first, '123');
        await tester.pump();
        await tester.tap(text('Verify'));
        await settleFrames(tester);
        expect(verifyBodies, isEmpty);
        expect(auth.isAuthenticated, isFalse);
      },
    );

    testWidgets(
      'invalid code shows the SERVER\'s attemptsRemaining; the rejected code is not re-sent; then success signs in',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient((body, attempt) {
            if (body['code'] == '654321') {
              return jsonResponse({
                'accessToken': 'a',
                'refreshToken': 'r',
              }, 200);
            }
            return jsonResponse({
              'code': 'MFA_CODE_INVALID',
              'state': 'invalid_code',
              'message': 'x',
              'attemptsRemaining': attempt == 1 ? 3 : 1,
            }, 401);
          }),
        );
        final outcomes = await openScreen(tester, auth);
        await enterAndVerify(tester, '111111');
        expect(
          find.textContaining(
            'That code didn’t work. Check your app and try again. 3 tries left.',
          ),
          findsOneWidget,
        );
        expect(auth.secondFactorPending, isTrue);
        // The rejected code is still shown (in red); Verify stays off until it changes.
        await tester.tap(text('Verify'));
        await settleFrames(tester);
        expect(verifyBodies, hasLength(1));

        await enterAndVerify(tester, '222222');
        expect(find.textContaining('1 try left.'), findsOneWidget);

        await enterAndVerify(tester, '654321');
        expect(verifyBodies.last, {
          'challengeToken': 'mfc_t',
          'code': '654321',
        });
        expect(outcomes, [SecondFactorOutcome.signedIn]);
        expect(auth.isAuthenticated, isTrue);
      },
    );

    testWidgets(
      'invalid code without attemptsRemaining shows no invented count',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient(
            (_, _) =>
                jsonResponse({'code': 'MFA_CODE_INVALID', 'message': 'x'}, 401),
          ),
        );
        await openScreen(tester, auth);
        await enterAndVerify(tester, '111111');
        expect(
          text('That code didn’t work. Check your app and try again.'),
          findsOneWidget,
        );
        expect(find.textContaining('left'), findsNothing);
      },
    );

    testWidgets(
      'attemptsRemaining 0 → "Let’s start again" (locked); Back to sign in abandons the challenge',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient(
            (_, _) => jsonResponse({
              'code': 'MFA_CODE_INVALID',
              'attemptsRemaining': 0,
              'message': 'x',
            }, 401),
          ),
        );
        final outcomes = await openScreen(tester, auth);
        await enterAndVerify(tester, '111111');
        expect(text('Let’s start again'), findsOneWidget);
        expect(
          find.textContaining('Too many incorrect codes were entered'),
          findsOneWidget,
        );
        expect(
          text(
            'Lost your phone and codes?\nContact your workspace admin or Crewflow support.',
          ),
          findsOneWidget,
        );
        await tester.tap(text('Back to sign in'));
        await settleFrames(tester);
        expect(cancels, 1);
        expect(outcomes, [SecondFactorOutcome.backToSignIn]);
        expect(auth.secondFactorPending, isFalse);
      },
    );

    testWidgets('MFA_CHALLENGE_EXHAUSTED → locked', (tester) async {
      tallPhone(tester);
      final auth = await pendingChallenge(
        tester,
        challengeClient(
          (_, _) => jsonResponse({
            'code': 'MFA_CHALLENGE_EXHAUSTED',
            'state': 'locked',
            'message': 'x',
          }, 401),
        ),
      );
      await openScreen(tester, auth);
      await enterAndVerify(tester, '111111');
      expect(
        text('Verification is temporarily unavailable for this session.'),
        findsOneWidget,
      );
      expect(auth.secondFactorPending, isFalse);
    });

    testWidgets('MFA_CHALLENGE_EXPIRED → expired (no TTL number shown)', (
      tester,
    ) async {
      tallPhone(tester);
      final auth2 = await pendingChallenge(
        tester,
        challengeClient(
          (_, _) => jsonResponse({
            'code': 'MFA_CHALLENGE_EXPIRED',
            'state': 'expired',
            'message': 'x',
          }, 401),
        ),
      );
      await openScreen(tester, auth2);
      await enterAndVerify(tester, '111111');
      expect(text('Let’s start again'), findsOneWidget);
      expect(
        text('Verification sessions expire after a few minutes.'),
        findsOneWidget,
      );
      expect(find.textContaining('5 minutes'), findsNothing);
      expect(auth2.isAuthenticated, isFalse);
    });

    testWidgets(
      '429 MFA_RATE_LIMITED: cooldown from Retry-After, challenge kept, Verify off until it passes',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient(
            (_, _) => http.Response(
              jsonEncode({'code': 'MFA_RATE_LIMITED', 'state': 'locked'}),
              429,
              headers: {'retry-after': '120'},
            ),
          ),
        );
        await openScreen(tester, auth);
        await enterAndVerify(tester, '111111');
        expect(
          text('Too many requests. Please try again in 2 minutes.'),
          findsOneWidget,
        );
        expect(auth.secondFactorPending, isTrue);
        await tester.enterText(find.byType(TextField).first, '222222');
        await tester.pump();
        await tester.tap(text('Verify'));
        await settleFrames(tester);
        expect(verifyBodies, hasLength(1));
        await tester.pump(const Duration(seconds: 121));
        await tester.tap(text('Verify'));
        await settleFrames(tester);
        expect(verifyBodies, hasLength(2));
      },
    );

    testWidgets(
      'network error: stays on the code view with the challenge kept; retry succeeds',
      (tester) async {
        tallPhone(tester);
        var offline = true;
        final auth = await pendingChallenge(
          tester,
          challengeClient((_, _) {
            if (offline) {
              offline = false;
              throw const SocketException('offline');
            }
            return jsonResponse({'accessToken': 'a', 'refreshToken': 'r'}, 200);
          }),
        );
        final outcomes = await openScreen(tester, auth);
        await enterAndVerify(tester, '654321');
        expect(
          text(
            'Unable to reach the server. Check your connection and try again.',
          ),
          findsOneWidget,
        );
        expect(text('Verify your sign-in'), findsOneWidget);
        expect(auth.secondFactorPending, isTrue);
        await tester.tap(text('Verify'));
        await settleFrames(tester);
        expect(outcomes, [SecondFactorOutcome.signedIn]);
      },
    );

    testWidgets(
      'a 503 keeps the challenge (AuthProvider) and shows a retryable error',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient((_, _) => jsonResponse({'message': 'down'}, 503)),
        );
        await openScreen(tester, auth);
        await enterAndVerify(tester, '654321');
        expect(text(ApiMessages.serverError), findsOneWidget);
        expect(auth.secondFactorPending, isTrue);
      },
    );

    testWidgets(
      'recovery view: toggle, uppercase code sent, back returns to the code view',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient(
            (body, _) => body['code'] == 'K7MP-2XQ9-4TZR-8HWE'
                ? jsonResponse({'accessToken': 'a', 'refreshToken': 'r'}, 200)
                : jsonResponse({
                    'code': 'MFA_CODE_INVALID',
                    'attemptsRemaining': 4,
                    'message': 'x',
                  }, 401),
          ),
        );
        final outcomes = await openScreen(tester, auth);
        await tester.tap(text('Use a recovery code'));
        await settleFrames(tester);
        expect(text('Use a recovery code'), findsOneWidget); // the heading
        expect(text('Each code can only be used once.'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('security-back')));
        await settleFrames(tester);
        expect(text('Verify your sign-in'), findsOneWidget);
        expect(outcomes, isEmpty);

        await tester.tap(text('Use a recovery code'));
        await settleFrames(tester);
        await enterAndVerify(
          tester,
          'zzzz-zzzz-zzzz-zzzz',
          button: 'Verify recovery code',
        );
        expect(verifyBodies.last['code'], 'ZZZZ-ZZZZ-ZZZZ-ZZZZ');
        expect(find.textContaining('4 tries left.'), findsOneWidget);
        await enterAndVerify(
          tester,
          'k7mp-2xq9-4tzr-8hwe',
          button: 'Verify recovery code',
        );
        expect(outcomes, [SecondFactorOutcome.signedIn]);
      },
    );

    testWidgets(
      'header back and system back on the code view abandon the challenge',
      (tester) async {
        tallPhone(tester);
        final auth = await pendingChallenge(
          tester,
          challengeClient((_, _) => jsonResponse({}, 500)),
        );
        final outcomes = await openScreen(tester, auth);
        final dynamic widgetsAppState = tester.state(find.byType(WidgetsApp));
        await widgetsAppState.didPopRoute();
        await settleFrames(tester);
        expect(cancels, 1);
        expect(outcomes, [SecondFactorOutcome.backToSignIn]);
      },
    );
  });

  group('update required (M11)', () {
    test('only https Play links for this package are allowlisted', () {
      expect(
        allowlistedUpdateUri(
          'https://play.google.com/store/apps/details?id=com.rab.rab_staff',
        ),
        isNotNull,
      );
      for (final bad in [
        null,
        42,
        'http://play.google.com/store/apps/details?id=com.rab.rab_staff',
        'https://play.google.com.evil.test/store/apps/details?id=com.rab.rab_staff',
        'https://evil.test/store/apps/details?id=com.rab.rab_staff',
        'https://play.google.com/store/apps/details?id=com.other.app',
        'https://user@play.google.com/store/apps/details?id=com.rab.rab_staff',
        'https://play.google.com:8443/store/apps/details?id=com.rab.rab_staff',
        'market://details?id=com.rab.rab_staff',
        'javascript:alert(1)',
      ]) {
        expect(allowlistedUpdateUri(bad), isNull, reason: '$bad');
      }
    });

    testWidgets('design copy; store button only for an allowlisted updateUrl', (
      tester,
    ) async {
      tallPhone(tester);
      final fake = installFakeSecurityPlatform();
      await tester.pumpWidget(const MaterialApp(home: UpdateRequiredScreen()));
      expect(text('Update to sign in securely'), findsOneWidget);
      expect(text('Open Google Play'), findsNothing);
      expect(text('Back'), findsOneWidget);

      await tester.pumpWidget(
        const MaterialApp(
          home: UpdateRequiredScreen(updateUrl: 'https://evil.test/x'),
        ),
      );
      expect(text('Open Google Play'), findsNothing);

      const url =
          'https://play.google.com/store/apps/details?id=com.rab.rab_staff';
      await tester.pumpWidget(
        const MaterialApp(home: UpdateRequiredScreen(updateUrl: url)),
      );
      await tester.tap(text('Open Google Play'));
      await tester.pump();
      expect(fake.opened.single.toString(), url);
    });
  });

  group('Profile > Security (M1, M5, M6)', () {
    MockClient statusClient(
      Map<String, dynamic> Function() status, {
      List<http.Request>? log,
    }) => MockClient((request) async {
      log?.add(request);
      if (request.url.path.endsWith('/auth/mfa') && request.method == 'GET') {
        return jsonResponse(status(), 200);
      }
      return http.Response('not found', 404);
    });

    testWidgets(
      'off: badge Off, Turn on 2FA, real biometric label + switch, Change password, caption',
      (tester) async {
        tallPhone(tester);
        final auth = await signedInAuth(
          tester,
          statusClient(() => mfaStatusJson()),
        );
        await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
        await settleFrames(tester);
        expect(text('Staff Test 1'), findsOneWidget);
        expect(text('stafftest1@example.test'), findsOneWidget);
        expect(text('Off'), findsOneWidget);
        expect(text('Turn on 2FA'), findsOneWidget);
        expect(text('Fingerprint'), findsOneWidget);
        expect(text('Face ID'), findsNothing);
        expect(find.byType(Switch), findsOneWidget);
        expect(text('Change password'), findsOneWidget);
        expect(
          text(
            'Two-factor authentication is optional.\nOnce enabled, it’s required at every sign-in.',
          ),
          findsOneWidget,
        );
        expect(text('Get new recovery codes'), findsNothing);
      },
    );

    testWidgets(
      'on: the server\'s "8 of 10 left", regenerate, Turn off; no low warning at 4; warning at 3',
      (tester) async {
        tallPhone(tester);
        var remaining = 8;
        final auth = await signedInAuth(
          tester,
          statusClient(
            () => mfaStatusJson(enabled: true, remaining: remaining, total: 10),
          ),
        );
        await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
        await settleFrames(tester);
        expect(text('On'), findsOneWidget);
        expect(text('8 of 10 left'), findsOneWidget);
        expect(text('Get new recovery codes'), findsOneWidget);
        expect(text('Turn off 2FA'), findsOneWidget);
        expect(
          find.textContaining('recovery codes left. Save a new set'),
          findsNothing,
        );

        for (final (count, warn) in [(4, false), (3, true), (1, true)]) {
          remaining = count;
          await tester.pumpWidget(
            securityHarness(auth, SecurityScreen(key: ValueKey(count))),
          );
          await settleFrames(tester);
          expect(text('$count of 10 left'), findsOneWidget);
          expect(
            find.textContaining('left. Save a new set'),
            warn ? findsOneWidget : findsNothing,
            reason: '$count',
          );
        }
        expect(
          text(
            'Only 1 recovery code left. Save a new set to keep access to your account.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'enforced: no Turn off; enrolment unavailable: Turn on disabled with a notice',
      (tester) async {
        tallPhone(tester);
        final auth = await signedInAuth(
          tester,
          statusClient(
            () => mfaStatusJson(
              enabled: true,
              remaining: 10,
              total: 10,
              enforced: true,
            ),
          ),
        );
        await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
        await settleFrames(tester);
        expect(text('Turn off 2FA'), findsNothing);
        expect(
          find.textContaining('required for your account'),
          findsOneWidget,
        );

        final auth2 = await signedInAuth(
          tester,
          statusClient(() => mfaStatusJson(enrolmentAvailable: false)),
        );
        await tester.pumpWidget(
          securityHarness(auth2, const SecurityScreen(key: ValueKey(2))),
        );
        await settleFrames(tester);
        expect(
          text('Two-factor setup isn’t available right now.'),
          findsOneWidget,
        );
        await tester.tap(text('Turn on 2FA'));
        await settleFrames(tester);
        expect(text('Confirm it’s you'), findsNothing);
      },
    );

    testWidgets(
      'no biometrics on the device: the row is omitted; no password: no Change password row',
      (tester) async {
        tallPhone(tester);
        final auth = await signedInAuth(
          tester,
          statusClient(() => mfaStatusJson(hasPassword: false)),
          capability: BiometricCapability.unavailable,
        );
        await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
        await settleFrames(tester);
        expect(find.byType(Switch), findsNothing);
        expect(text('Change password'), findsNothing);
        expect(text('Turn on 2FA'), findsOneWidget);
      },
    );

    testWidgets('status network error → error + Try again → loads', (
      tester,
    ) async {
      tallPhone(tester);
      var fail = true;
      final client = MockClient((request) async {
        if (fail) {
          fail = false;
          throw const SocketException('offline');
        }
        return jsonResponse(mfaStatusJson(), 200);
      });
      final auth = await signedInAuth(tester, client);
      await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
      await settleFrames(tester);
      expect(text(ApiMessages.offline), findsOneWidget);
      expect(text('Turn on 2FA'), findsNothing);
      await tester.tap(text('Try again'));
      await settleFrames(tester);
      expect(text('Turn on 2FA'), findsOneWidget);
    });
  });

  group('enrolment flow (M2 → M3 → M4 → M5)', () {
    testWidgets(
      'password proof, same-phone setup, FLAG_SECURE, codes acknowledged before Done, server-confirmed On',
      (tester) async {
        tallPhone(tester);
        final fake = installFakeSecurityPlatform();
        var enabled = false;
        final posts = <String, Map<String, dynamic>>{};
        final client = MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/auth/mfa') && request.method == 'GET') {
            return jsonResponse(
              mfaStatusJson(enabled: enabled, remaining: 10, total: 10),
              200,
            );
          }
          final body = request.body.isEmpty
              ? <String, dynamic>{}
              : jsonDecode(request.body) as Map<String, dynamic>;
          if (path.endsWith('/auth/mfa/enrolment')) {
            posts['start'] = body;
            if (body['currentPassword'] != 'right password') {
              return jsonResponse({
                'statusCode': 403,
                'message': 'Re-enter your current password to continue.',
                'error': 'Forbidden',
              }, 403);
            }
            return jsonResponse({
              'otpauthUri': testOtpauthUri,
              'qrDataUrl': 'data:image/png;base64,AAAA',
              'manualKey': testManualKey,
            }, 200);
          }
          if (path.endsWith('/auth/mfa/enrolment/confirm')) {
            posts['confirm'] = body;
            if (body['code'] != '482913') {
              return jsonResponse({
                'code': 'MFA_CODE_INVALID',
                'message': 'x',
              }, 401);
            }
            enabled = true;
            return jsonResponse({'recoveryCodes': testRecoveryCodes}, 200);
          }
          return http.Response('not found', 404);
        });
        final auth = await signedInAuth(tester, client);
        await tester.pumpWidget(
          securityHarness(
            auth,
            Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () =>
                      Navigator.of(context).push(SecurityScreen.route()),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(text('open'));
        await settleFrames(tester);
        await tester.tap(text('Turn on 2FA'));
        await settleFrames(tester);

        // M2: wrong password stays put with the error.
        expect(text('Confirm it’s you'), findsOneWidget);
        expect(text('Confirm identity'), findsOneWidget);
        await tester.enterText(
          find.byKey(const ValueKey('current-password')),
          'wrong',
        );
        await tester.pump();
        await tester.tap(text('Continue'));
        await settleFrames(tester);
        expect(text(TwoFactorFailure.wrongPassword), findsOneWidget);
        expect(text('Connect your authenticator'), findsNothing);

        await tester.enterText(
          find.byKey(const ValueKey('current-password')),
          'right password',
        );
        await tester.pump();
        await tester.tap(text('Continue'));
        await settleFrames(tester);

        // M3: FLAG_SECURE on; key + account from the server's material.
        expect(text('Connect your authenticator'), findsOneWidget);
        expect(fake.secure, isTrue);
        expect(text(testManualKey), findsOneWidget);
        expect(text('Account · stafftest1@example.test'), findsOneWidget);
        expect(find.textContaining('QR'), findsNothing);

        await tester.tap(text('Open authenticator app'));
        await tester.pump();
        expect(fake.opened.single.toString(), testOtpauthUri);
        expect(
          find.textContaining('No authenticator app opened'),
          findsNothing,
        );
        fake.openSucceeds = false;
        await tester.tap(text('Open authenticator app'));
        await tester.pump();
        expect(
          find.textContaining(
            'No authenticator app opened. Copy the setup key',
          ),
          findsOneWidget,
        );

        await tester.tap(find.byTooltip('Copy setup key'));
        await tester.pump();
        expect(fake.copied.single, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
        await settleFrames(tester, 280);

        await tester.enterText(find.byType(TextField).first, '000000');
        await tester.pump();
        await tester.tap(text('Confirm code'));
        await settleFrames(tester);
        expect(text(TwoFactorFailure.wrongCode), findsOneWidget);
        expect(text('Connect your authenticator'), findsOneWidget);

        await tester.enterText(find.byType(TextField).first, '482913');
        await tester.pump();
        await tester.tap(text('Confirm code'));
        await settleFrames(tester);

        // M4: the codes, FLAG_SECURE still on across the replacement, Done gated.
        expect(text('Save your recovery codes'), findsOneWidget);
        expect(fake.secure, isTrue);
        expect(
          fake.secureCalls.where((on) => !on),
          isEmpty,
          reason: 'never dropped between the two secure screens',
        );
        for (final code in testRecoveryCodes) {
          expect(text(code), findsOneWidget);
        }
        await tester.tap(text('Done'));
        await settleFrames(tester);
        expect(text('Save your recovery codes'), findsOneWidget);

        // Back (header and system) is held until the codes are acknowledged.
        await tester.tap(find.byKey(const ValueKey('security-back')));
        await settleFrames(tester);
        expect(text('Save your recovery codes'), findsOneWidget);
        expect(
          find.textContaining('tick the box before you leave'),
          findsOneWidget,
        );
        final dynamic widgetsAppState = tester.state(find.byType(WidgetsApp));
        await widgetsAppState.didPopRoute();
        await settleFrames(tester);
        expect(text('Save your recovery codes'), findsOneWidget);

        await tester.tap(text('Share or save codes'));
        await tester.pump();
        expect(fake.shared.single, contains(testRecoveryCodes.join('\n')));
        await tester.tap(text('Copy codes'));
        await tester.pump();
        expect(fake.copied.last, contains(testRecoveryCodes.first));
        await settleFrames(tester, 280);

        await tester.tap(text('I’ve saved these codes somewhere safe.'));
        await tester.pump();
        await tester.tap(text('Done'));
        await settleFrames(tester);

        // Back on Security, status re-read from the server: On.
        expect(text('Two-factor authentication'), findsOneWidget);
        expect(text('On'), findsOneWidget);
        expect(text('10 of 10 left'), findsOneWidget);
        expect(text('Two-factor authentication is on.'), findsOneWidget);
        expect(fake.secure, isFalse);
        expect(SecureWindow.holders, 0);
        expect(posts['start'], {'currentPassword': 'right password'});
        expect(posts['confirm'], {'code': '482913'});
      },
    );

    testWidgets(
      'no-password account: no password field; STEP_UP_REQUIRED → the honest web-console message',
      (tester) async {
        tallPhone(tester);
        Map<String, dynamic>? sent;
        final client = MockClient((request) async {
          if (request.url.path.endsWith('/auth/mfa/enrolment')) {
            sent = jsonDecode(request.body) as Map<String, dynamic>;
            return jsonResponse({
              'code': 'STEP_UP_REQUIRED',
              'mfa': false,
              'message': 'Confirm it’s you to continue.',
            }, 403);
          }
          return http.Response('not found', 404);
        });
        final auth = await signedInAuth(tester, client);
        await tester.pumpWidget(
          securityHarness(
            auth,
            ConfirmIdentityScreen(
              api: TwoFactorApi(auth.api),
              hasPassword: false,
            ),
          ),
        );
        expect(find.byKey(const ValueKey('current-password')), findsNothing);
        await tester.tap(text('Continue'));
        await settleFrames(tester);
        expect(sent, isEmpty);
        expect(text(TwoFactorFailure.webOnlyProof), findsOneWidget);
      },
    );
  });

  group('turn off (M12) and new codes (M13)', () {
    testWidgets(
      'turn off: password + code, recovery-code alternative, wrong code stays, 204 → server-confirmed Off',
      (tester) async {
        tallPhone(tester);
        var enabled = true;
        final disables = <Map<String, dynamic>>[];
        final client = MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/auth/mfa') && request.method == 'GET') {
            return jsonResponse(
              mfaStatusJson(enabled: enabled, remaining: 8, total: 10),
              200,
            );
          }
          if (path.endsWith('/auth/mfa/disable')) {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            disables.add(body);
            if (body['code'] == '111111') {
              return jsonResponse({
                'code': 'STEP_UP_MFA_INVALID',
                'message': 'x',
              }, 403);
            }
            enabled = false;
            return http.Response('', 204);
          }
          return http.Response('not found', 404);
        });
        final auth = await signedInAuth(tester, client);
        await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
        await settleFrames(tester);
        await tester.tap(text('Turn off 2FA'));
        await settleFrames(tester);
        expect(text('Turn off two-factor authentication?'), findsOneWidget);
        expect(
          text('Your authenticator and recovery codes will stop working.'),
          findsOneWidget,
        );

        await tester.enterText(
          find.byKey(const ValueKey('current-password')),
          'pw',
        );
        await tester.enterText(
          find.byKey(const ValueKey('otp-input')),
          '111111',
        );
        await tester.pump();
        await tester.tap(find.widgetWithText(InkWell, 'Turn off 2FA'));
        await settleFrames(tester);
        expect(text(TwoFactorFailure.wrongCode), findsOneWidget);
        expect(text('Turn off two-factor authentication?'), findsOneWidget);

        await tester.tap(text('Use a recovery code instead'));
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('recovery-code')),
          'k7mp-2xq9-4tzr-8hwe',
        );
        await tester.pump();
        await tester.tap(find.widgetWithText(InkWell, 'Turn off 2FA'));
        await settleFrames(tester);
        expect(disables.last, {
          'currentPassword': 'pw',
          'code': 'K7MP-2XQ9-4TZR-8HWE',
        });
        expect(text('Off'), findsOneWidget);
        expect(text('Turn on 2FA'), findsOneWidget);
        expect(text('Two-factor authentication is off.'), findsOneWidget);
      },
    );

    testWidgets(
      'wrong password (plain 403) marks the password; Cancel returns without a change',
      (tester) async {
        tallPhone(tester);
        final client = MockClient((request) async {
          if (request.url.path.endsWith('/auth/mfa') &&
              request.method == 'GET') {
            return jsonResponse(
              mfaStatusJson(enabled: true, remaining: 8, total: 10),
              200,
            );
          }
          if (request.url.path.endsWith('/auth/mfa/recovery-codes')) {
            return jsonResponse({
              'statusCode': 403,
              'message': 'Re-enter your current password to continue.',
            }, 403);
          }
          return http.Response('not found', 404);
        });
        final auth = await signedInAuth(tester, client);
        await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
        await settleFrames(tester);
        await tester.tap(text('Get new recovery codes'));
        await settleFrames(tester);
        await tester.enterText(
          find.byKey(const ValueKey('current-password')),
          'nope',
        );
        await tester.enterText(
          find.byKey(const ValueKey('otp-input')),
          '482913',
        );
        await tester.pump();
        await tester.tap(text('Generate new codes'));
        await settleFrames(tester);
        expect(text(TwoFactorFailure.wrongPassword), findsOneWidget);
        await tester.tap(text('Cancel'));
        await settleFrames(tester);
        expect(text('8 of 10 left'), findsOneWidget);
      },
    );

    testWidgets(
      'new codes: shown once under FLAG_SECURE, Done gated, back to Security with the new count',
      (tester) async {
        tallPhone(tester);
        final fake = installFakeSecurityPlatform();
        var remaining = 2;
        final client = MockClient((request) async {
          if (request.url.path.endsWith('/auth/mfa') &&
              request.method == 'GET') {
            return jsonResponse(
              mfaStatusJson(enabled: true, remaining: remaining, total: 10),
              200,
            );
          }
          if (request.url.path.endsWith('/auth/mfa/recovery-codes')) {
            expect(jsonDecode(request.body), {
              'currentPassword': 'pw',
              'code': '482913',
            });
            remaining = 10;
            return jsonResponse({'recoveryCodes': testRecoveryCodes}, 200);
          }
          return http.Response('not found', 404);
        });
        final auth = await signedInAuth(tester, client);
        await tester.pumpWidget(securityHarness(auth, const SecurityScreen()));
        await settleFrames(tester);
        expect(
          text(
            'Only 2 recovery codes left. Save a new set to keep access to your account.',
          ),
          findsOneWidget,
        );
        await tester.tap(text('Get new recovery codes'));
        await settleFrames(tester);
        expect(
          fake.secureCalls,
          isEmpty,
          reason: 'the proof form shows no secret',
        );
        await tester.enterText(
          find.byKey(const ValueKey('current-password')),
          'pw',
        );
        await tester.enterText(
          find.byKey(const ValueKey('otp-input')),
          '482913',
        );
        await tester.pump();
        await tester.tap(text('Generate new codes'));
        await settleFrames(tester);
        expect(text('Save your new recovery codes'), findsOneWidget);
        expect(text('Confirm identity'), findsNothing);
        expect(fake.secure, isTrue);
        expect(
          find.byType(OtpCodeField),
          findsNothing,
          reason: 'the proof form was replaced, not stacked',
        );
        await tester.tap(text('I’ve saved these codes somewhere safe.'));
        await tester.pump();
        await tester.tap(text('Done'));
        await settleFrames(tester);
        expect(text('10 of 10 left'), findsOneWidget);
        expect(fake.secure, isFalse);
      },
    );
  });

  group('FLAG_SECURE lifecycle', () {
    testWidgets(
      'kept while backgrounded (Recents thumbnail), re-asserted on resume, cleared on leave',
      (tester) async {
        tallPhone(tester);
        final fake = installFakeSecurityPlatform();
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        const RecoveryCodesScreen(codes: testRecoveryCodes),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        );
        await tester.tap(text('open'));
        await settleFrames(tester);
        expect(fake.secureCalls, [true]);

        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await tester.pump();
        expect(fake.secureCalls, [
          true,
        ], reason: 'never cleared while backgrounded');
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        expect(fake.secureCalls, [true, true]);

        await tester.tap(text('I’ve saved these codes somewhere safe.'));
        await tester.pump();
        await tester.tap(text('Done'));
        await settleFrames(tester);
        expect(fake.secureCalls.last, isFalse);
        expect(SecureWindow.holders, 0);
      },
    );

    testWidgets('the Android channel receives setSecure true/false', (
      tester,
    ) async {
      tallPhone(tester);
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SecurityPlatform.channel,
        (call) async {
          calls.add(call);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SecurityPlatform.channel,
          null,
        ),
      );
      SecureWindow.resetForTest();
      await tester.pumpWidget(
        const MaterialApp(home: SecureWindow(child: SizedBox())),
      );
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      expect(calls.map((c) => [c.method, c.arguments]), [
        [
          'setSecure',
          {'secure': true},
        ],
        [
          'setSecure',
          {'secure': false},
        ],
      ]);
    });
  });

  group('API client and provider contract', () {
    test(
      'an expired access token on /auth/mfa refreshes and retries once',
      () async {
        stubSecureStorageChannel({
          'rab.accessToken': 'old',
          'rab.refreshToken': 'rt',
        });
        addTearDown(clearSecureStorageChannel);
        final seen = <String>[];
        final api = ApiClient(
          httpClient: MockClient((request) async {
            seen.add('${request.url.path} ${request.headers['Authorization']}');
            if (request.url.path.endsWith('/auth/refresh')) {
              return jsonResponse({
                'accessToken': 'new',
                'refreshToken': 'rt2',
              }, 200);
            }
            if (request.headers['Authorization'] == 'Bearer old') {
              return jsonResponse({
                'statusCode': 401,
                'message': 'Unauthorized',
              }, 401);
            }
            return jsonResponse(mfaStatusJson(), 200);
          }),
        );
        final status = TwoFactorStatus.fromJson(
          await api.get('/auth/mfa') as Map<String, dynamic>,
        );
        expect(status.enabled, isFalse);
        expect(seen, [
          '/rest/v1/auth/mfa Bearer old',
          '/rest/v1/auth/refresh null',
          '/rest/v1/auth/mfa Bearer new',
        ]);
      },
    );

    test(
      'a wrong enrolment code (401 MFA_CODE_INVALID) is NOT refreshed or replayed',
      () async {
        stubSecureStorageChannel({
          'rab.accessToken': 'a',
          'rab.refreshToken': 'rt',
        });
        addTearDown(clearSecureStorageChannel);
        var calls = 0;
        final api = ApiClient(
          httpClient: MockClient((request) async {
            calls++;
            return jsonResponse({
              'code': 'MFA_CODE_INVALID',
              'message': 'x',
            }, 401);
          }),
        );
        await expectLater(
          TwoFactorApi(api).confirmEnrolment('000000'),
          throwsA(
            isA<ApiException>().having(
              (e) => e.code,
              'code',
              'MFA_CODE_INVALID',
            ),
          ),
        );
        expect(calls, 1);
        expect(
          await api.getAccessToken(),
          'a',
          reason: 'the session is untouched',
        );
      },
    );

    test('the pre-session challenge verify is never refreshed', () async {
      stubSecureStorageChannel({'rab.refreshToken': 'rt'});
      addTearDown(clearSecureStorageChannel);
      final paths = <String>[];
      final api = ApiClient(
        httpClient: MockClient((request) async {
          paths.add(request.url.path);
          return jsonResponse({'code': 'MFA_CHALLENGE_EXPIRED'}, 401);
        }),
      );
      await expectLater(
        api.post(
          '/auth/mfa/challenge/verify',
          body: {'challengeToken': 't', 'code': '123456'},
        ),
        throwsA(isA<ApiException>()),
      );
      expect(paths, ['/rest/v1/auth/mfa/challenge/verify']);
    });

    test(
      'status parsing: missing fields fail safe (no invented counts, password asked)',
      () {
        final status = TwoFactorStatus.fromJson({'enabled': true});
        expect(status.recoveryCodesRemaining, 0);
        expect(status.recoveryCodesTotal, 0);
        expect(status.hasPassword, isTrue);
        expect(status.enrolmentAvailable, isFalse);
        expect(
          const EnrolmentMaterial(
            otpauthUri: testOtpauthUri,
            manualKey: testManualKey,
          ).accountName,
          'stafftest1@example.test',
        );
      },
    );
  });

  group('palette contrast (WCAG AA), light and dark', () {
    double ratio(Color a, Color b) {
      final la = a.computeLuminance(), lb = b.computeLuminance();
      return ((la > lb ? la : lb) + .05) / ((la > lb ? lb : la) + .05);
    }

    for (final palette in [SecurityColors.light, SecurityColors.dark]) {
      final c = palette;
      final mode = c.isDark ? 'dark' : 'light';
      // Text on its background: >= 4.5:1 (small text throughout the design).
      final text = <String, (Color, Color)>{
        'ink on canvas (headings, links)': (c.ink, c.canvas),
        'ink on surface (cards, inputs)': (c.ink, c.surface),
        'ink on quiet': (c.ink, c.quiet),
        'muted on surface (card body, OTP digits, key)': (c.muted, c.surface),
        'mutedOnTint on canvas (body copy, captions)': (
          c.mutedOnTint,
          c.canvas,
        ),
        'mutedOnTint on quiet (info notice, Off badge)': (
          c.mutedOnTint,
          c.quiet,
        ),
        'onPill on pill (primary button, snack)': (c.onPill, c.pill),
        'red on surface (danger button)': (c.red, c.surface),
        'red on softRed (error notice)': (c.red, c.softRed),
        'greenText on mint (On badge, success)': (c.greenText, c.mint),
        'amberText on amber (warning notice)': (c.amberText, c.amber),
        'avatarText on avatarFill': (c.avatarText, c.avatarFill),
      };
      for (final entry in text.entries) {
        test('$mode: ${entry.key} >= 4.5:1', () {
          final (fg, bg) = entry.value;
          expect(
            ratio(fg, bg),
            greaterThanOrEqualTo(4.5),
            reason: ratio(fg, bg).toStringAsFixed(2),
          );
        });
      }
      // Non-text graphics that carry meaning: >= 3:1.
      final graphics = <String, (Color, Color)>{
        'green glyph on mint (emblem)': (c.green, c.mint),
        'red OTP error border on surface': (c.red, c.surface),
        'pill on canvas (primary button shape)': (c.pill, c.canvas),
      };
      for (final entry in graphics.entries) {
        test('$mode: ${entry.key} >= 3:1', () {
          final (fg, bg) = entry.value;
          expect(
            ratio(fg, bg),
            greaterThanOrEqualTo(3),
            reason: ratio(fg, bg).toStringAsFixed(2),
          );
        });
      }
    }

    test('light keeps the owner contrast tweaks and the design fills', () {
      expect(SecurityColors.light.greenText, const Color(0xFF007256));
      expect(SecurityColors.light.mutedOnTint, const Color(0xFF5A6C84));
      expect(SecurityColors.light.canvas, const Color(0xFFF7F7F9));
      expect(SecurityColors.light.mint, const Color(0xFFE9F7F0));
      expect(SecurityColors.light.pill, const Color(0xFF161916));
    });

    testWidgets('the screens follow the theme brightness (phone dark mode)', (
      tester,
    ) async {
      Future<Color?> canvasFor(ThemeMode mode) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData.light(),
            darkTheme: ThemeData.dark(),
            themeMode: mode,
            home: const UpdateRequiredScreen(),
          ),
        );
        await tester.pumpAndSettle(); // MaterialApp animates theme changes
        return tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor;
      }

      expect(await canvasFor(ThemeMode.light), SecurityColors.light.canvas);
      expect(await canvasFor(ThemeMode.dark), SecurityColors.dark.canvas);
    });
  });
}

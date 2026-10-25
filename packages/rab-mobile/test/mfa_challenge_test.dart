import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/features/auth_flow/auth_flow_shell.dart';
import 'package:rab_staff/navigation/app_shell.dart';

import 'support/biometric_test_support.dart';

/// Lane D (owner decision M10-1): an account with two-factor authentication
/// signing in on mobile gets `409 SECOND_FACTOR_REQUIRED`; the app shows the
/// verification screen (account-security design, M7–M11), stores NOTHING until
/// the server accepts the code, and fails closed when the challenge cannot be
/// completed here (enrolment required) or has expired.
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

  http.Response json(Object body, int status) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  /// Shared app-side endpoints once a session exists.
  http.Response? appRoutes(String path) {
    if (path.endsWith('/auth/me')) return json(fakeUserJson(), 200);
    if (path.endsWith('/offers/mine')) return json([], 200);
    if (path.endsWith('/notifications/unread-count')) return json({'count': 0}, 200);
    if (path.endsWith('/notifications')) return json([], 200);
    if (path.endsWith('/attendance/me/active')) return json({'attendance': null}, 200);
    if (path.endsWith('/attendance/me/history')) return json([], 200);
    return null;
  }

  Future<void> reachPasswordForm(WidgetTester tester, AuthProvider auth) async {
    await tester.pumpWidget(ChangeNotifierProvider.value(value: auth, child: const RabApp()));
    await settle(tester);
    await tester.tap(find.text('Get Started'));
    await settle(tester);
    await tester.enterText(find.byType(TextField).at(0), 'boss@example.test');
    await tester.enterText(find.byType(TextField).at(1), 'password123');
    await settle(tester);
    await tester.tap(find.text('Sign In'));
    await settle(tester);
  }

  AuthProvider providerWith(MockClient client) => AuthProvider(
        apiClient: ApiClient(httpClient: client),
        biometricAuthenticator: FakeBiometricAuthenticator(capability: BiometricCapability.unavailable),
      );

  testWidgets('verify: no session before the code; a wrong code keeps the step; the right code (mobile transport) signs in', (tester) async {
    stubSecureStorageChannel(secureStore);
    final verifyBodies = <Map<String, dynamic>>[];
    final verifyPlatforms = <String?>[];
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/auth/login')) {
        return json({
          'code': 'SECOND_FACTOR_REQUIRED',
          'requirement': 'verify',
          'challengeToken': 'mfc_test_token',
          'challengeExpiresAt': '2026-10-24T12:05:00.000Z',
          'message': 'Enter the code from your authenticator app to finish signing in.',
        }, 409);
      }
      if (path.endsWith('/auth/mfa/challenge/verify')) {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        verifyBodies.add(body);
        verifyPlatforms.add(request.headers['X-Client-Platform'] ?? request.headers['x-client-platform']);
        if (body['code'] != '654321') {
          return json({'code': 'MFA_CODE_INVALID', 'message': 'That code didn’t work.'}, 401);
        }
        return json({'accessToken': 'access-1', 'refreshToken': 'refresh-1', 'mustResetPassword': false}, 200);
      }
      return appRoutes(path) ?? http.Response('not found', 404);
    });
    final auth = providerWith(client);
    await reachPasswordForm(tester, auth);

    expect(find.text('Verify your sign-in'), findsOneWidget);
    expect(auth.secondFactorPending, isTrue);
    expect(auth.isAuthenticated, isFalse);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);
    expect(secureStore.containsKey('rab.refreshToken'), isFalse);

    await tester.enterText(find.byType(TextField).first, '111111');
    await settle(tester);
    await tester.tap(find.text('Verify'));
    await settle(tester);
    expect(find.textContaining('That code didn’t work'), findsOneWidget);
    expect(find.text('Verify your sign-in'), findsOneWidget);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);

    await tester.enterText(find.byType(TextField).first, '654 321');
    await settle(tester);
    await tester.tap(find.text('Verify'));
    await settle(tester);

    expect(verifyBodies.last, {'challengeToken': 'mfc_test_token', 'code': '654321'});
    expect(verifyPlatforms.every((p) => p == 'mobile'), isTrue);
    expect(find.byType(AuthFlowShell), findsNothing);
    expect(find.byType(AppShell), findsOneWidget);
    expect(auth.secondFactorPending, isFalse);
  });

  testWidgets('enroll: FAIL CLOSED — no code step, the challenge is abandoned server-side, nothing stored, user sent to the web console', (tester) async {
    stubSecureStorageChannel(secureStore);
    var cancelled = <Map<String, dynamic>>[];
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/auth/login')) {
        return json({'code': 'SECOND_FACTOR_REQUIRED', 'requirement': 'enroll', 'challengeToken': 'mfc_enrol', 'challengeExpiresAt': 'x'}, 409);
      }
      if (path.endsWith('/auth/mfa/challenge/cancel')) {
        cancelled = [...cancelled, jsonDecode(request.body) as Map<String, dynamic>];
        return http.Response('', 204);
      }
      if (path.endsWith('/auth/mfa/challenge/enrolment')) fail('the app must never start enrolment');
      return appRoutes(path) ?? http.Response('not found', 404);
    });
    final auth = providerWith(client);
    await reachPasswordForm(tester, auth);

    expect(find.text('Verify your sign-in'), findsNothing);
    expect(find.textContaining('Set it up in the Crewflow web console'), findsOneWidget);
    expect(cancelled, [
      {'challengeToken': 'mfc_enrol'},
    ]);
    expect(auth.secondFactorPending, isFalse);
    expect(auth.isAuthenticated, isFalse);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);
    expect(find.byType(AppShell), findsNothing);
  });

  testWidgets('account security step 1 (P3): every request declares X-Client-Capabilities: mfa-verify; CLIENT_UPDATE_REQUIRED shows the update screen and stores nothing', (tester) async {
    stubSecureStorageChannel(secureStore);
    final capabilities = <String?>[];
    final client = MockClient((request) async {
      final path = request.url.path;
      capabilities.add(request.headers['X-Client-Capabilities'] ?? request.headers['x-client-capabilities']);
      if (path.endsWith('/auth/login')) {
        return json({
          'code': 'CLIENT_UPDATE_REQUIRED',
          'message': 'Update Crewflow to sign in. Your account uses two-factor authentication, and this version of the app can’t ask for your code.',
        }, 409);
      }
      return appRoutes(path) ?? http.Response('not found', 404);
    });
    final auth = providerWith(client);
    await reachPasswordForm(tester, auth);

    expect(capabilities, isNotEmpty);
    expect(capabilities.every((value) => value == 'mfa-verify'), isTrue);
    expect(find.text('Update to sign in securely'), findsOneWidget);
    expect(find.textContaining('Update Crewflow to enter your verification code'), findsOneWidget);
    // No allowlisted updateUrl in the body: text + Back only, no store button.
    expect(find.text('Open Google Play'), findsNothing);
    expect(find.text('Verify your sign-in'), findsNothing);
    expect(auth.secondFactorPending, isFalse);
    expect(auth.isAuthenticated, isFalse);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);
    expect(find.byType(AppShell), findsNothing);
  });

  test('the capability header is also sent on token refresh', () async {
    String? seen;
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/auth/refresh')) seen = request.headers['X-Client-Capabilities'] ?? request.headers['x-client-capabilities'];
      return http.Response('{"message":"no"}', 401, headers: {'content-type': 'application/json'});
    });
    expect(kClientCapabilitiesHeader, 'X-Client-Capabilities');
    expect(kClientCapabilities.split(',').map((t) => t.trim().toLowerCase()), contains('mfa-verify'));
    final api = ApiClient(httpClient: client);
    stubSecureStorageChannel({'rab.refreshToken': 'rt'});
    try {
      await api.get('/auth/me');
    } catch (_) {}
    expect(seen, 'mfa-verify');
  });

  testWidgets('an expired / exhausted challenge ends the step ("Let’s start again" → password form); Back abandons it', (tester) async {
    stubSecureStorageChannel(secureStore);
    var cancels = 0;
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/auth/login')) {
        return json({'code': 'SECOND_FACTOR_REQUIRED', 'requirement': 'verify', 'challengeToken': 'mfc_x', 'challengeExpiresAt': 'x'}, 409);
      }
      if (path.endsWith('/auth/mfa/challenge/verify')) {
        return json({'code': 'MFA_CHALLENGE_EXPIRED', 'message': 'Your sign-in expired. Please sign in again.'}, 401);
      }
      if (path.endsWith('/auth/mfa/challenge/cancel')) {
        cancels++;
        return http.Response('', 204);
      }
      return appRoutes(path) ?? http.Response('not found', 404);
    });
    final auth = providerWith(client);
    await reachPasswordForm(tester, auth);
    expect(find.text('Verify your sign-in'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, '123456');
    await settle(tester);
    await tester.tap(find.text('Verify'));
    await settle(tester);
    expect(find.text('Verify your sign-in'), findsNothing);
    expect(find.text('Let’s start again'), findsOneWidget);
    expect(find.textContaining('Your verification session has expired'), findsOneWidget);
    expect(auth.secondFactorPending, isFalse);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);
    await tester.tap(find.text('Back to sign in'));
    await settle(tester);
    expect(find.text('Sign In'), findsOneWidget);
    expect(cancels, 0, reason: 'the server already ended this challenge');

    // Sign in again → code step → Back abandons the new challenge.
    await tester.enterText(find.byType(TextField).at(1), 'password123');
    await settle(tester);
    await tester.tap(find.text('Sign In'));
    await settle(tester);
    expect(find.text('Verify your sign-in'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('security-back')));
    await settle(tester);
    expect(cancels, 1);
    expect(find.text('Sign In'), findsOneWidget);
    expect(auth.secondFactorPending, isFalse);
  });
}

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

/// Regression test for a real bug from the old pushed-`LoginScreen`
/// architecture: a successful login flipped `AuthProvider.phase`, but
/// nothing popped the still-pushed login form off the navigation stack, so
/// the user stayed stuck looking at it. The rewritten `AuthFlowShell` has no
/// such stack to get stuck on — it's one persistent widget that reacts to
/// `phase` directly — so this now proves the equivalent property: a
/// successful login (via Welcome -> Get Started -> the shell's own Login
/// step) reaches `AppShell`, not a lingering auth screen.
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

  testWidgets('logging in via Welcome -> Get Started reaches the app, not stuck on the auth flow', (tester) async {
    stubSecureStorageChannel(secureStore);

    final mockClient = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/auth/login')) {
        return http.Response(jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}), 200);
      }
      if (path.endsWith('/auth/me')) return http.Response(jsonEncode(fakeUserJson()), 200);
      if (path.endsWith('/offers/mine')) return http.Response(jsonEncode([]), 200);
      if (path.endsWith('/notifications/unread-count')) return http.Response(jsonEncode({'count': 0}), 200);
      if (path.endsWith('/notifications')) return http.Response(jsonEncode([]), 200);
      if (path.endsWith('/attendance/me/active')) return http.Response(jsonEncode({'attendance': null}), 200);
      if (path.endsWith('/attendance/me/history')) return http.Response(jsonEncode([]), 200);
      return http.Response('not found', 404);
    });
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: mockClient),
      biometricAuthenticator: FakeBiometricAuthenticator(capability: BiometricCapability.unavailable),
    );

    await tester.pumpWidget(ChangeNotifierProvider.value(value: auth, child: const RabApp()));
    await settle(tester);
    expect(find.byType(AuthFlowShell), findsOneWidget);
    expect(find.text('Get Started'), findsOneWidget);

    await tester.tap(find.text('Get Started'));
    await settle(tester);
    expect(find.byType(TextField), findsNWidgets(2));

    await tester.enterText(find.byType(TextField).at(0), 'alice@example.test');
    await tester.enterText(find.byType(TextField).at(1), 'password123');
    await settle(tester);

    await tester.tap(find.text('Log in'));
    await settle(tester);

    expect(find.byType(AuthFlowShell), findsNothing);
    expect(find.byType(AppShell), findsOneWidget);
  });
}

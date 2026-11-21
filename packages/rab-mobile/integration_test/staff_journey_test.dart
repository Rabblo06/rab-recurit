import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/storage/secure_storage_bootstrap.dart';
import 'package:rab_staff/core/theme/shift_colour_store.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/navigation/app_shell.dart';

import 'support/fake_crewflow_api.dart';

/// Staff app end to end on a device: sign in → Today → shift detail.
///
/// The real app (real `ApiClient`, real HTTP, real secure storage on the
/// device) runs against [FakeCrewflowApi], a CI-local API served on the
/// device's loopback interface; nothing ever reaches a real backend. The only
/// substitution is biometrics: the emulator has no enrolled fingerprint, and a
/// fake keeps the "set up biometrics?" offer out of the journey.
///
///   flutter test integration_test/staff_journey_test.dart \
///     --dart-define=API_URL=http://localhost:38917/rest/v1
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const email = 'sam.shaker@example.test';
  const password = 'integration-test-password';
  late FakeCrewflowApi api;

  setUpAll(() async {
    api = await FakeCrewflowApi.start(staffEmail: email, staffPassword: password);
  });

  tearDownAll(() => api.close());

  /// Pumps frames until [finder] matches, or fails after [timeout]. Never
  /// `pumpAndSettle`: the app polls and animates, so it never settles.
  Future<void> pumpUntilFound(
    WidgetTester tester,
    Finder finder, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final end = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 100));
      if (finder.evaluate().isNotEmpty) return;
    }
    final onScreen = find
        .byType(Text)
        .evaluate()
        .map((e) => (e.widget as Text).data)
        .whereType<String>()
        .take(40)
        .toList();
    fail(
      'Timed out after $timeout waiting for $finder. '
      'Requests so far: ${api.requests}. Unhandled: ${api.unhandled}. Text on screen: $onScreen',
    );
  }

  testWidgets('a staff member signs in, sees today\'s shift and opens its details', (tester) async {
    expect(
      ApiClient().baseUrl,
      'http://localhost:${FakeCrewflowApi.defaultPort}/rest/v1',
      reason: 'run with --dart-define=API_URL=http://localhost:${FakeCrewflowApi.defaultPort}/rest/v1 (never a real backend)',
    );
    if (!Platform.isAndroid && !Platform.isIOS) _stubSecureStorageOnHost();

    // The same start-up as main.dart.
    try {
      await SecureStorageBootstrap().run();
    } catch (error) {
      debugPrint('Secure storage bootstrap failed: $error');
    }
    await ShiftColourStore.attach(ShiftVisualStyle.registry);
    final auth = AuthProvider(biometricAuthenticator: _NoBiometrics());
    await tester.pumpWidget(ChangeNotifierProvider.value(value: auth, child: const RabApp()));

    // Welcome → Sign in.
    await pumpUntilFound(tester, find.text('Get Started'));
    await tester.tap(find.text('Get Started'));
    await pumpUntilFound(tester, find.byType(TextField));
    // Let the Welcome → Login transition finish before typing.
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(TextField), findsNWidgets(2));
    await tester.enterText(find.byType(TextField).at(0), email);
    await tester.enterText(find.byType(TextField).at(1), password);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.ensureVisible(find.text('Sign In'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Sign In'));

    // Today: the confirmed shift is "Today's Shift" on the home screen.
    await pumpUntilFound(tester, find.byType(AppShell));
    await pumpUntilFound(tester, find.text(FakeCrewflowApi.venueName));
    expect(find.text("Today's Shift"), findsWidgets);
    expect(find.text(FakeCrewflowApi.roleName), findsWidgets);
    expect(api.requests, containsAll(<String>['POST /rest/v1/auth/login', 'GET /rest/v1/auth/me', 'GET /rest/v1/offers/mine']));

    // Shift detail.
    // The "Today's Shift" panel (the first card on the home screen) opens the shift.
    await tester.tap(find.text(FakeCrewflowApi.venueName).first);
    await pumpUntilFound(tester, find.text('Job Details'));
    expect(find.text(FakeCrewflowApi.roleName), findsWidgets);
    expect(find.text(FakeCrewflowApi.venueAddress), findsOneWidget);
    await tester.scrollUntilVisible(find.text(FakeCrewflowApi.shiftNotes), 200, scrollable: find.byType(Scrollable).last);
    expect(find.text(FakeCrewflowApi.shiftNotes), findsOneWidget);

    // Every request carried the session the app signed in with (the fake answers 401 otherwise) and none hit a route
    // the fake does not serve.
    expect(api.unhandled, isEmpty, reason: 'requests with no fake answer: ${api.unhandled}');
  });
}

class _NoBiometrics implements BiometricAuthenticator {
  @override
  Future<BiometricCapability> getCapability() async => BiometricCapability.unavailable;

  @override
  Future<BiometricOutcome> authenticate({required String reason}) async => BiometricOutcome.failed;
}

/// Host runs only (`flutter test` without a device, for quick local checks): the flutter_secure_storage platform plugin
/// does not exist on the test host, so its channel is answered from memory. On a device the real plugin is used.
void _stubSecureStorageOnHost() {
  final store = <String, String>{};
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
    final args = call.arguments is Map ? call.arguments as Map : const {};
    switch (call.method) {
      case 'write':
        store[args['key'] as String] = args['value'] as String;
        return null;
      case 'read':
        return store[args['key'] as String];
      case 'readAll':
        return Map<String, String>.from(store);
      case 'delete':
        store.remove(args['key'] as String);
        return null;
      case 'deleteAll':
        store.clear();
        return null;
      case 'containsKey':
        return store.containsKey(args['key'] as String);
      default:
        return null;
    }
  });
}

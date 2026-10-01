import 'dart:async';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:rab_staff/features/welcome/onboarding_motion.dart';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/rab_auth_sheet.dart';
import 'package:rab_staff/features/auth_flow/matched_auth_layout.dart';
import 'package:rab_staff/features/login/login_sheet_content.dart';
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
  setUpAll(() async {
    final fonts =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    for (final entry in {
      'Roboto': 'roboto-regular.ttf',
      'MaterialIcons': 'materialicons-regular.otf',
    }.entries) {
      await (FontLoader(entry.key)..addFont(
            File(
              '$fonts/${entry.value}',
            ).readAsBytes().then(ByteData.sublistView),
          ))
          .load();
    }
  });

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
    'Get Started pixels stay still on press and callback has no delay',
    (tester) async {
      var calls = 0;
      final key = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: RepaintBoundary(
                key: key,
                child: OnboardingCta(onPressed: () => calls++),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<List<int>> pixels() async => (await tester.runAsync(() async {
        final image =
            await (key.currentContext!.findRenderObject()
                    as RenderRepaintBoundary)
                .toImage();
        final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
        image.dispose();
        return data!.buffer.asUint8List().toList();
      }))!;
      final before = await pixels();
      final gesture = await tester.startGesture(
        tester.getCenter(find.text('Get Started')),
      );
      await tester.pump(const Duration(milliseconds: 200));
      expect(await pixels(), before);
      expect(calls, 0);
      await gesture.up();
      expect(calls, 1);
      await tester.pump(const Duration(milliseconds: 200));
      expect(await pixels(), before);
    },
  );

  testWidgets(
    'morph starts before storage finishes and retains current page and brand',
    (tester) async {
      stubSecureStorageChannel(secureStore);
      final auth = freshAuth();
      await waitUntilPhaseNot(auth, AuthPhase.loading);
      final storageWrite = Completer<void>();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
            (call) async {
              if (call.method == 'write') {
                await storageWrite.future;
                final args = call.arguments as Map;
                secureStore[args['key'] as String] = args['value'] as String;
              }
              return null;
            },
          );
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
      await tester.tap(find.byTooltip('Opportunities'));
      await tester.pumpAndSettle();
      final pages = tester.widget<PageView>(find.byType(PageView)).controller;
      final brand = tester.element(find.text('ADOLPHUS / RECRUITMENT'));
      final page = pages!.page;
      final sceneElements = [
        find.text('ADOLPHUS / RECRUITMENT'),
        find.text('Get Started'),
        find.byKey(const ValueKey('onboarding-indicator-2')),
        find.text('Everything you need\nto move forward.'),
      ];
      final before = sceneElements.map(tester.getTopLeft).toList();
      await tester.tap(find.text('Get Started'));
      await tester.pump();
      expect(storageWrite.isCompleted, isFalse);
      expect(
        tester.widget<PageView>(find.byType(PageView)).controller,
        same(pages),
      );
      await tester.pump(const Duration(milliseconds: 16));
      final layout = tester.widget<MatchedAuthLayout>(
        find.byType(MatchedAuthLayout),
      );
      expect(layout.progress.value, greaterThan(0));
      await tester.pump(const Duration(milliseconds: 209));
      expect(layout.progress.value, closeTo(.5, .01));
      final height =
          tester.view.physicalSize.height / tester.view.devicePixelRatio;
      double offset(String key) => tester
          .widget<Transform>(find.byKey(ValueKey(key)))
          .transform
          .storage[13];
      final exit = offset('auth-onboarding-scene');
      expect(exit, lessThan(-height * .05));
      expect(exit, greaterThan(-height * .3));
      expect(offset('auth-login-scene'), closeTo(height + exit, .001));
      for (var i = 0; i < sceneElements.length; i++) {
        final position = tester.getTopLeft(sceneElements[i]);
        expect(position.dx, closeTo(before[i].dx, .001));
        expect(position.dy, closeTo(before[i].dy + exit, .001));
      }
      expect(tester.element(find.text('ADOLPHUS / RECRUITMENT')), same(brand));
      expect(pages.page, page);
      expect(tester.widget<AuthSheet>(find.byType(AuthSheet)).progress, 1);
      final canvas = tester.widget<ColoredBox>(
        find.byKey(const ValueKey('auth-morph-canvas')),
      );
      expect(canvas.color, onboardingCream);
      expect(
        find.descendant(
          of: find.byType(MatchedAuthLayout),
          matching: find.byType(ModalBarrier),
        ),
        findsNothing,
      );
      await tester.pump(const Duration(milliseconds: 225));
      expect(layout.progress.value, 1);
      expect(find.byType(PageView), findsNothing);
      expect(find.byType(TextField), findsNWidgets(2));
      expect(tester.element(find.text('ADOLPHUS / RECRUITMENT')), same(brand));
      storageWrite.complete();
      await tester.pump();
      expect(secureStore['rab.onboarding.hasSeenWelcome'], 'true');
      await tester.pumpWidget(const SizedBox.shrink());
      auth.dispose();
    },
  );

  testWidgets('swiping to the final page preserves completion and login', (
    tester,
  ) async {
    stubSecureStorageChannel(secureStore);
    final auth = freshAuth();
    addTearDown(auth.dispose);
    await waitUntilPhaseNot(auth, AuthPhase.loading);
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
    await tester.tap(find.byTooltip('Opportunities'));
    await settle(tester);
    expect(auth.hasSeenWelcome, isFalse);
    expect(find.bySemanticsLabel('Onboarding page 3 of 3'), findsOneWidget);
    await tester.tap(find.text('Get Started'));
    await settle(tester);
    expect(auth.hasSeenWelcome, isTrue);
    expect(secureStore['rab.onboarding.hasSeenWelcome'], 'true');
    expect(find.byType(TextField), findsNWidgets(2));
    expect(find.byType(PageView), findsNothing);
  });

  testWidgets(
    'Back reverses in 450ms and preserves brand, current page and Login controllers',
    (tester) async {
      stubSecureStorageChannel(secureStore);
      final auth = freshAuth();
      await waitUntilPhaseNot(auth, AuthPhase.loading);
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
      final brand = tester.element(find.text('ADOLPHUS / RECRUITMENT'));
      final pages = tester.widget<PageView>(find.byType(PageView)).controller!;
      final page = pages.page;
      await tester.tap(find.text('Get Started'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 450));
      await tester.pump(const Duration(milliseconds: 1));
      final login = tester.state(find.byType(LoginSheetContent));
      await tester.enterText(
        find.byType(TextField).first,
        'preview@example.com',
      );
      await tester.enterText(find.byType(TextField).last, 'LocalPreviewOnly');
      await tester.pump();
      await tester.tap(find.byTooltip('Show'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 5));
      expect(pages.page, page);
      await tester.tap(find.byType(RabRoundBackButton));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 225));
      final layout = tester.widget<MatchedAuthLayout>(
        find.byType(MatchedAuthLayout),
      );
      expect(layout.progress.value, closeTo(.5, .01));
      expect(tester.element(find.text('ADOLPHUS / RECRUITMENT')), same(brand));
      expect(
        find.descendant(
          of: find.byType(MatchedAuthLayout),
          matching: find.byType(ModalBarrier),
        ),
        findsNothing,
      );
      await tester.pump(const Duration(milliseconds: 225));
      expect(layout.progress.value, 0);
      await tester.pump(const Duration(milliseconds: 1));
      expect(find.byType(AuthSheet), findsNothing);
      expect(pages.page, page);
      await tester.tap(find.text('Get Started'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 450));
      await tester.pump(const Duration(milliseconds: 1));
      expect(tester.state(find.byType(LoginSheetContent)), same(login));
      expect(
        tester.widget<TextField>(find.byType(TextField).first).controller!.text,
        'preview@example.com',
      );
      expect(
        tester.widget<TextField>(find.byType(TextField).last).obscureText,
        isFalse,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      auth.dispose();
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
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 225));
      expect(
        tester
            .widget<MatchedAuthLayout>(find.byType(MatchedAuthLayout))
            .progress
            .value,
        closeTo(.5, .01),
      );
      await settle(tester);

      expect(find.byType(TextField), findsNWidgets(2));
      expect(find.text('Get Started').hitTestable(), findsNothing);
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

      expect(find.text('Get Started').hitTestable(), findsNothing);
      expect(find.byType(TextField), findsNWidgets(2));
    },
  );
  testWidgets('reduced motion completes both directions immediately', (
    tester,
  ) async {
    stubSecureStorageChannel(secureStore);
    final auth = freshAuth();
    await waitUntilPhaseNot(auth, AuthPhase.loading);
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: auth,
        child: MaterialApp(
          theme: buildLightTheme(),
          home: const MediaQuery(
            data: MediaQueryData(size: Size(800, 600), disableAnimations: true),
            child: AuthFlowShell(),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('Get Started'));
    await tester.pump();
    expect(
      tester
          .widget<MatchedAuthLayout>(find.byType(MatchedAuthLayout))
          .progress
          .value,
      1,
    );
    await tester.tap(find.byType(RabRoundBackButton));
    await tester.pump();
    expect(
      tester
          .widget<MatchedAuthLayout>(find.byType(MatchedAuthLayout))
          .progress
          .value,
      0,
    );
    expect(find.text('Get Started').hitTestable(), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    auth.dispose();
  });
  for (final size in [
    const Size(320, 568),
    const Size(393, 851),
    const Size(844, 390),
  ]) {
    testWidgets('matched composition stays within $size at 200% text', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      stubSecureStorageChannel(secureStore);
      final auth = freshAuth();
      await waitUntilPhaseNot(auth, AuthPhase.loading);
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: auth,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: MediaQuery(
              data: MediaQueryData(
                size: size,
                textScaler: const TextScaler.linear(2),
              ),
              child: const AuthFlowShell(),
            ),
          ),
        ),
      );
      await settle(tester);
      final label = find.text('ADOLPHUS / RECRUITMENT');
      final brand = tester.element(label);
      await tester.tap(find.text('Get Started'));
      await tester.pump();
      for (var i = 0; i < 9; i++) {
        await tester.pump(const Duration(milliseconds: 50));
        expect(tester.takeException(), isNull);
        expect(tester.element(label), same(brand));
        final rect = tester.getRect(label);
        expect(rect.left, greaterThanOrEqualTo(0));
        expect(rect.right, lessThanOrEqualTo(size.width));
      }
      await tester.pump(const Duration(milliseconds: 1));
      await tester.tap(find.byType(RabRoundBackButton));
      await tester.pump();
      for (var i = 0; i < 9; i++) {
        await tester.pump(const Duration(milliseconds: 50));
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox.shrink());
      auth.dispose();
    });
  }
  testWidgets(
    '75ms samples accelerate forward and decelerate Back without gaps',
    (tester) async {
      stubSecureStorageChannel(secureStore);
      final auth = freshAuth();
      await waitUntilPhaseNot(auth, AuthPhase.loading);
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
      final height =
          tester.view.physicalSize.height / tester.view.devicePixelRatio;
      double y(String key) => tester
          .widget<Transform>(find.byKey(ValueKey(key)))
          .transform
          .storage[13];
      await tester.tap(find.text('Get Started'));
      await tester.pump();
      final forward = <double>[0];
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 75));
        forward.add(-y('auth-onboarding-scene'));
        expect(y('auth-login-scene'), closeTo(height - forward.last, .001));
      }
      expect(forward[1], lessThan(height * .05));
      expect(forward.last, closeTo(height, .001));
      for (var i = 2; i < forward.length; i++) {
        expect(
          forward[i] - forward[i - 1],
          greaterThan(forward[i - 1] - forward[i - 2]),
        );
      }
      await tester.pump(const Duration(milliseconds: 1));
      await tester.tap(find.byType(RabRoundBackButton));
      await tester.pump();
      final back = <double>[0];
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 75));
        back.add(y('auth-login-scene'));
        expect(back.last, closeTo(height + y('auth-onboarding-scene'), .001));
      }
      expect(back.last, closeTo(height, .001));
      for (var i = 2; i < back.length; i++) {
        expect(back[i] - back[i - 1], lessThan(back[i - 1] - back[i - 2]));
      }
      debugPrint(
        '75ms scene samples: forward=$forward back=$back viewport=$height',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      auth.dispose();
    },
  );
}

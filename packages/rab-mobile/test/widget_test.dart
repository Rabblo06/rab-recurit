import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';

void main() {
  // flutter_secure_storage talks to a platform channel with no default
  // implementation in the widget-test environment — stub it to behave like
  // an empty store (no token persisted yet) instead of throwing
  // MissingPluginException.
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'read') return null;
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets(
    'shows the welcome screen, then the sign-in form, for an unauthenticated visitor',
    (tester) async {
      await tester.pumpWidget(
        ChangeNotifierProvider(
          create: (_) => AuthProvider(),
          child: const RabApp(),
        ),
      );
      await tester.pumpAndSettle();

      // Product branding is 'ADOLPHUS / RECRUITMENT' (see
      // welcome_header.dart) — 'RAB' is the internal/codebase name only and
      // has never been user-facing text on this screen.
      expect(find.text('ADOLPHUS / RECRUITMENT'), findsOneWidget);
      expect(find.text('Get Started'), findsOneWidget);

      await tester.tap(find.text('Get Started'));
      await tester.pumpAndSettle();

      // 'Welcome back' / 'Sign In' are the current copy (see
      // AuthWelcomeHeading's default title and LoginSheetContent's
      // AuthPrimaryButton label) — 'Welcome,' and 'Log in' are stale text
      // this screen has not shown since before the auth-sheet redesign.
      expect(find.text('Welcome back'), findsOneWidget);
      expect(find.text('Sign In'), findsOneWidget);
      expect(find.text('EMAIL'), findsOneWidget);
      expect(find.text('PASSWORD'), findsOneWidget);
    },
  );
}

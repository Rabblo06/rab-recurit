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
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'read') return null;
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  testWidgets('shows the welcome screen, then the sign-in form, for an unauthenticated visitor', (tester) async {
    await tester.pumpWidget(
      ChangeNotifierProvider(create: (_) => AuthProvider(), child: const RabApp()),
    );
    await tester.pumpAndSettle();

    expect(find.text('Create Your\nDream Now'), findsOneWidget);
    expect(find.text('Login'), findsOneWidget);
    expect(find.text('Create Account'), findsOneWidget);

    await tester.tap(find.text('Login'));
    await tester.pumpAndSettle();

    expect(find.text('rab'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('Email'), findsOneWidget);
    // "Password" appears twice: the field label and the (identical) hint
    // text rendered inside the empty TextField itself.
    expect(find.text('Password'), findsWidgets);
  });
}

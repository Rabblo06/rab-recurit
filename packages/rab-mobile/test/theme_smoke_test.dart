import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/home/home_screen.dart';
import 'package:rab_staff/features/login/login_screen.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';

/// Increment 2 (Theme + Core App Shell) — proves `HomeScreen`/`LoginScreen`
/// render without exception under both palettes, and that the resolved
/// `AppColorsX` extension actually matches the theme in use (not just "no
/// crash", but "the right tokens").
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'read') return null;
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  Widget wrap(Widget child, ThemeData theme) {
    final mockClient = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/offers/mine')) return http.Response(jsonEncode([]), 200);
      if (path.endsWith('/notifications/unread-count')) return http.Response(jsonEncode({'count': 0}), 200);
      if (path.endsWith('/notifications')) return http.Response(jsonEncode([]), 200);
      return http.Response('not found', 404);
    });
    final api = ApiClient(httpClient: mockClient);
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthProvider>(create: (_) => AuthProvider(apiClient: api)),
        ChangeNotifierProvider<OffersProvider>(create: (_) => OffersProvider(api)),
        ChangeNotifierProvider<NotificationsProvider>(create: (_) => NotificationsProvider(api)),
      ],
      child: MaterialApp(theme: theme, home: child),
    );
  }

  for (final entry in {'light': buildLightTheme(), 'dark': buildDarkTheme()}.entries) {
    final themeName = entry.key;
    final theme = entry.value;
    final expectedColors = themeName == 'light' ? AppColorsX.light : AppColorsX.dark;

    testWidgets('LoginScreen renders under $themeName theme with correct tokens', (tester) async {
      await tester.pumpWidget(wrap(const LoginScreen(), theme));
      await tester.pump();

      expect(tester.takeException(), isNull);
      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
      expect(scaffold.backgroundColor, expectedColors.bgApp);
    });

    testWidgets('HomeScreen renders under $themeName theme with correct tokens', (tester) async {
      await tester.pumpWidget(wrap(const HomeScreen(), theme));
      await tester.pump();

      expect(tester.takeException(), isNull);
      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
      expect(scaffold.backgroundColor, expectedColors.bgApp);
    });
  }
}

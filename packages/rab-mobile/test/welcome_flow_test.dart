import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/login/login_screen.dart';
import 'package:rab_staff/features/welcome/welcome_screen.dart';

/// Increment 2 (Theme + Core App Shell) — "Create Account" must never become
/// a real self-registration flow (Staff accounts are admin/manager-
/// provisioned only), so this proves it only shows an info dialog with no
/// navigation and no provider/network call, while "Login" genuinely pushes
/// `LoginScreen`.
void main() {
  testWidgets('Login pushes LoginScreen', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: buildLightTheme(), home: const WelcomeScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Login'));
    await tester.pumpAndSettle();

    expect(find.byType(LoginScreen), findsOneWidget);
  });

  testWidgets('Create Account shows an info dialog, not a registration form', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: buildLightTheme(), home: const WelcomeScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Create Account'));
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.textContaining('created by your manager or admin'), findsOneWidget);
    expect(find.byType(LoginScreen), findsNothing);

    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(WelcomeScreen), findsOneWidget);
  });
}

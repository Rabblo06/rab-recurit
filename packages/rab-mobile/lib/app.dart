import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/auth/auth_provider.dart';
import 'core/theme/tokens.dart';
import 'features/biometric_lock/biometric_lock_screen.dart';
import 'features/biometric_setup/biometric_setup_prompt.dart';
import 'features/login/login_screen.dart';
import 'features/notifications/notifications_provider.dart';
import 'features/offers/offers_provider.dart';
import 'features/set_password/set_password_screen.dart';
import 'features/welcome/welcome_screen.dart';
import 'navigation/app_shell.dart';

class RabApp extends StatelessWidget {
  const RabApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'rab',
      debugShowCheckedModeBanner: false,
      theme: buildLightTheme(),
      darkTheme: buildDarkTheme(),
      themeMode: ThemeMode.system,
      home: const _RootGate(),
    );
  }
}

/// Auth-gated root — mirrors the web console's `RequireAuth` and the
/// earlier Expo build's `Redirect` guards. Routes on `AuthProvider.phase`:
/// unauthenticated shows the welcome screen (which leads to login);
/// biometrics-enabled-and-within-window shows the biometric lock screen;
/// biometrics-enabled-but-expired shows a password login with a reauth
/// banner; a fresh password login on capable hardware offers biometric
/// setup once; must-reset-password shows the forced `SetPasswordScreen`;
/// fully authenticated shows the tab shell.
/// `OffersProvider`/`NotificationsProvider` are scoped here (not above the
/// gate) so they're rebuilt fresh on every login, keyed to the now-current
/// session's API client.
class _RootGate extends StatelessWidget {
  const _RootGate();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();

    switch (auth.phase) {
      case AuthPhase.loading:
        return Scaffold(
          backgroundColor: context.colors.bgApp,
          body: Center(child: CircularProgressIndicator(color: context.colors.accent)),
        );
      case AuthPhase.unauthenticated:
        return const WelcomeScreen();
      case AuthPhase.biometricLocked:
        return const BiometricLockScreen();
      case AuthPhase.reauthRequired:
        return const LoginScreen(reasonBanner: 'For your security, please sign in again.');
      case AuthPhase.offeringBiometricSetup:
        return const BiometricSetupPromptScreen();
      case AuthPhase.mustResetPassword:
        return const SetPasswordScreen();
      case AuthPhase.authenticated:
        return MultiProvider(
          key: ValueKey(auth.user!.id),
          providers: [
            ChangeNotifierProvider(create: (_) => OffersProvider(auth.api)),
            ChangeNotifierProvider(create: (_) => NotificationsProvider(auth.api)),
          ],
          child: const AppShell(),
        );
    }
  }
}

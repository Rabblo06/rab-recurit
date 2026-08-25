import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/auth/auth_provider.dart';
import 'core/theme/tokens.dart';
import 'features/login/login_screen.dart';
import 'features/notifications/notifications_provider.dart';
import 'features/offers/offers_provider.dart';
import 'features/set_password/set_password_screen.dart';
import 'navigation/app_shell.dart';

class RabApp extends StatelessWidget {
  const RabApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'rab',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      home: const _RootGate(),
    );
  }
}

/// Auth-gated root — mirrors the web console's `RequireAuth` and the
/// earlier Expo build's `Redirect` guards: unauthenticated shows the login
/// screen, authenticated-but-must-reset-password shows the forced
/// `SetPasswordScreen`, fully authenticated shows the tab shell.
/// `OffersProvider`/`NotificationsProvider` are scoped here (not above the
/// gate) so they're rebuilt fresh on every login, keyed to the now-current
/// session's API client.
class _RootGate extends StatelessWidget {
  const _RootGate();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();

    if (!auth.isReady) {
      return const Scaffold(
        backgroundColor: AppColors.bgApp,
        body: Center(child: CircularProgressIndicator(color: AppColors.accent)),
      );
    }

    if (!auth.isAuthenticated) {
      return const LoginScreen();
    }

    if (auth.user!.mustResetPassword) {
      return const SetPasswordScreen();
    }

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

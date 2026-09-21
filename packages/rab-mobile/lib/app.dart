import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/auth/auth_provider.dart';
import 'core/models/current_user.dart';
import 'features/venue_manager/venue_manager_provider.dart';
import 'features/venue_manager/venue_manager_screens.dart';
import 'navigation/console_entry_screen.dart';
import 'core/theme/tokens.dart';
import 'features/auth_flow/auth_flow_shell.dart';
import 'features/home/attendance_provider.dart';
import 'features/notifications/notifications_provider.dart';
import 'features/offers/offers_provider.dart';
import 'navigation/app_shell.dart';

class RabApp extends StatelessWidget {
  const RabApp({super.key});

  @override
  Widget build(BuildContext context) => const _RabMaterialApp();
}

class _RabMaterialApp extends StatelessWidget {
  const _RabMaterialApp();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'rab',
      onGenerateRoute: (settings) {
        final uri = Uri.tryParse(settings.name ?? '');
        if (uri?.host == 'login' || uri?.path == '/login') {
          return MaterialPageRoute<void>(
            settings: settings,
            builder: (_) => const _ReturnToLogin(),
          );
        }
        return MaterialPageRoute<void>(builder: (_) => const _RootGate());
      },
      debugShowCheckedModeBanner: false,
      theme: buildLightTheme(),
      darkTheme: buildDarkTheme(),
      themeMode: ThemeMode.system,
      // Wraps the app's single `Navigator`, not just its initial route, so
      // routes pushed with `Navigator.of(context).push(...)` (e.g. from
      // `HomeScreen` to `NotificationsScreen`/`OffersScreen`) still resolve
      // these providers. A `MultiProvider` placed inside `_RootGate` instead
      // sits *below* the `Navigator`; pushed routes land in its `Overlay` as
      // siblings of the calling route, not as its descendants, so they'd
      // miss providers scoped there — hence `ProviderNotFoundException` for
      // screens reached via push.
      builder: (context, child) {
        final auth = context.watch<AuthProvider>();
        if (auth.phase != AuthPhase.authenticated) return child!;
        return MultiProvider(
          key: ValueKey('${auth.user!.id}:${auth.presentation.name}'),
          providers: [
            if (auth.presentation == AppPresentation.staff)
              ChangeNotifierProvider(create: (_) => OffersProvider(auth.api)),
            ChangeNotifierProvider(
              create: (_) => NotificationsProvider(auth.api),
            ),
            if (auth.presentation == AppPresentation.staff)
              ChangeNotifierProvider(
                create: (_) => AttendanceProvider(auth.api),
              ),
            if (auth.presentation == AppPresentation.venueManager)
              ChangeNotifierProvider(
                create: (_) => VenueManagerProvider(auth.api, auth.user!.id),
              ),
          ],
          child: child,
        );
      },
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
/// fully authenticated shows the tab shell. `OffersProvider`/
/// `NotificationsProvider`/`AttendanceProvider` are provided by `RabApp`'s
/// `MaterialApp.builder` (keyed to the current session), not here, so they
/// stay visible to routes pushed on top of the shell.
class _RootGate extends StatelessWidget {
  const _RootGate();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();

    switch (auth.phase) {
      case AuthPhase.loading:
        return Scaffold(
          backgroundColor: context.colors.bgApp,
          body: Center(
            child: CircularProgressIndicator(color: context.colors.accent),
          ),
        );
      case AuthPhase.unauthenticated:
      case AuthPhase.biometricLocked:
      case AuthPhase.reauthRequired:
      case AuthPhase.offeringBiometricSetup:
      case AuthPhase.mustResetPassword:
        // One persistent shell handles all five of these — see
        // `AuthFlowShell`'s own doc comment for why they can't each be a
        // separate top-level screen anymore (the signature Welcome->Login
        // black-object morph and the shared black shell across Login/Set
        // Password/Biometric Setup both require one widget that survives
        // across phase changes, not a fresh screen per phase).
        return const AuthFlowShell();
      case AuthPhase.authenticated:
        return switch (auth.presentation) {
          AppPresentation.staff => const AppShell(),
          AppPresentation.venueManager => const VenueManagerShell(),
          AppPresentation.manager ||
          AppPresentation.admin => const ConsoleEntryScreen(),
          AppPresentation.unsupported => const ConsoleEntryScreen(
            unsupported: true,
          ),
        };
    }
  }
}

class _ReturnToLogin extends StatefulWidget {
  const _ReturnToLogin();
  @override
  State<_ReturnToLogin> createState() => _ReturnToLoginState();
}

class _ReturnToLoginState extends State<_ReturnToLogin> {
  bool ready = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final auth = context.read<AuthProvider>();
      await auth.initialized;
      if (!mounted) return;
      await auth.logout();
      await auth.completeWelcome();
      if (mounted) setState(() => ready = true);
    });
  }

  @override
  Widget build(BuildContext context) => ready
      ? const _RootGate()
      : const Scaffold(body: Center(child: CircularProgressIndicator()));
}

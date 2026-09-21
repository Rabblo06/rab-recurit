import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/rab_atmospheric_background.dart';
import '../../core/widgets/rab_auth_sheet.dart';
import '../biometric_lock/biometric_lock_sheet_content.dart';
import '../biometric_setup/biometric_setup_sheet_content.dart';
import '../login/login_sheet_content.dart';
import '../set_password/set_password_sheet_content.dart';
import '../welcome/welcome_header.dart'
    show WelcomeGetStartedButton, WelcomeTitle;

enum _AuthStep { welcome, login, setPassword, biometricSetup, biometricLock }

/// The persistent shell behind every unauthenticated `AuthPhase` (all of
/// them except `loading`/`authenticated`, which `_RootGate` still renders
/// separately). Owns exactly two animations — a "backdrop" morph (Welcome's
/// green geometry + small black object <-> Login's black upper region) and
/// a "sheet" reveal (the white content sheet rising from/exiting through
/// the bottom edge) — and derives which logical step to show from
/// `AuthProvider.phase` plus `hasSeenWelcome`, reacting to phase changes
/// with the choreographed transition instead of an instant widget swap.
///
/// `AuthProvider` itself is untouched by any of this: this widget only
/// reads `phase`/`hasSeenWelcome` and calls the same public methods
/// (`login`, `setPassword`, `completeBiometricSetup`, ...) the old
/// screens called directly.
class AuthFlowShell extends StatefulWidget {
  const AuthFlowShell({super.key});

  @override
  State<AuthFlowShell> createState() => _AuthFlowShellState();
}

class _AuthFlowShellState extends State<AuthFlowShell>
    with TickerProviderStateMixin {
  late final AnimationController _backdrop;
  late final AnimationController _sheet;
  late final AnimationController _entrance;
  late final AnimationController _reveal;

  _AuthStep? _currentStep;
  bool _showWelcomeOverride = false;
  bool _firstEverRun = false;
  bool _entered = false;

  @override
  void initState() {
    super.initState();
    _backdrop = AnimationController(
      vsync: this,
      duration: AppMotion.sharedElement,
    );
    _sheet = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 480),
    );
    _reveal = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 360),
    );
    _sheet.addListener(() {
      if (_sheet.status == AnimationStatus.forward &&
          Curves.easeOutCubic.transform(_sheet.value) >= 0.75 &&
          _reveal.status == AnimationStatus.dismissed) {
        unawaited(_reveal.forward());
      }
    });
    _entrance = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _firstEverRun = !context.read<AuthProvider>().hasSeenWelcome;
  }

  @override
  void dispose() {
    _backdrop.dispose();
    _sheet.dispose();
    _entrance.dispose();
    _reveal.dispose();
    super.dispose();
  }

  _AuthStep _stepFor(AuthProvider auth) {
    if (_showWelcomeOverride) return _AuthStep.welcome;
    switch (auth.phase) {
      case AuthPhase.unauthenticated:
        return auth.hasSeenWelcome ? _AuthStep.login : _AuthStep.welcome;
      case AuthPhase.reauthRequired:
        return _AuthStep.login;
      case AuthPhase.mustResetPassword:
        return _AuthStep.setPassword;
      case AuthPhase.offeringBiometricSetup:
        return _AuthStep.biometricSetup;
      case AuthPhase.biometricLocked:
        return _AuthStep.biometricLock;
      case AuthPhase.loading:
      case AuthPhase.authenticated:
        return _currentStep ?? _AuthStep.login;
    }
  }

  Future<void> _playEntrance(_AuthStep step) async {
    if (step != _AuthStep.welcome) {
      _sheet.value = 0;
      _reveal.value = 0;
    } else {
      _backdrop.value = 0;
    }
    if (step != _AuthStep.welcome) _backdrop.value = 1;
    unawaited(_entrance.forward());
    if (step != _AuthStep.welcome) {
      await Future.delayed(const Duration(milliseconds: 100));
      if (mounted) unawaited(_sheet.forward());
    }
  }

  Future<void> _transitionTo(_AuthStep next) async {
    final current = _currentStep;
    if (current == next) return;
    final leavingWelcome =
        current == _AuthStep.welcome && next != _AuthStep.welcome;
    final enteringWelcome =
        current != _AuthStep.welcome && next == _AuthStep.welcome;

    if (leavingWelcome) {
      _sheet.value = 0;
      _reveal.value = 0;
      setState(() => _currentStep = next);
      unawaited(_backdrop.forward(from: 0));
      await Future.delayed(const Duration(milliseconds: 100));
      if (!mounted) return;
      await _sheet.forward(from: 0);
      return;
    }

    if (enteringWelcome) {
      unawaited(_reveal.reverse());
      await _sheet.reverse(from: _sheet.value);
      if (!mounted) return;
      await _backdrop.reverse(from: _backdrop.value);
      if (!mounted) return;
      setState(() => _currentStep = _AuthStep.welcome);
      return;
    }

    // Docked step -> docked step: the black shell stays put (§21); only the
    // sheet exits fully, then the new content enters fully — never a
    // crossfade between the two contents.
    unawaited(_reveal.reverse());
    await _sheet.reverse(from: _sheet.value);
    if (!mounted) return;
    setState(() => _currentStep = next);
    _sheet.value = 0;
    _reveal.value = 0;
    await _sheet.forward(from: 0);
  }

  void _handleGetStarted() {
    _showWelcomeOverride = false;
    context.read<AuthProvider>().completeWelcome();
  }

  void _handleBack() {
    setState(() => _showWelcomeOverride = true);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final target = _stepFor(auth);

    if (!_entered) {
      _entered = true;
      _currentStep = target;
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _playEntrance(target),
      );
    } else if (target != _currentStep &&
        !_sheet.isAnimating &&
        !_backdrop.isAnimating) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _transitionTo(target),
      );
    }

    final step = _currentStep ?? target;

    return Scaffold(
      resizeToAvoidBottomInset: false,
      backgroundColor: context.colors.authBg,
      body: AnimatedBuilder(
        animation: Listenable.merge([_backdrop, _sheet, _entrance, _reveal]),
        builder: (context, _) {
          final entranceOpacity = _entrance.value;
          final entranceRise = 16 * (1 - _entrance.value);
          return AnnotatedRegion<SystemUiOverlayStyle>(
            value:
                (_backdrop.value > 0.5
                        ? SystemUiOverlayStyle.light
                        : SystemUiOverlayStyle.dark)
                    .copyWith(
                      statusBarColor: Colors.transparent,
                      systemNavigationBarColor: Colors.transparent,
                      systemNavigationBarIconBrightness: Brightness.dark,
                    ),
            child: Opacity(
              opacity: entranceOpacity,
              child: Transform.translate(
                offset: Offset(0, entranceRise),
                child: Stack(
                  children: [
                    AuthBackdrop(
                      t: _backdrop.value,
                      welcomeTitle: const WelcomeTitle(),
                      getStartedButton: WelcomeGetStartedButton(
                        onPressed: _handleGetStarted,
                      ),
                      onBack: (_firstEverRun && step == _AuthStep.login)
                          ? _handleBack
                          : null,
                    ),
                    if (step != _AuthStep.welcome)
                      AuthSheet(
                        progress: _sheet.value,
                        isLogin: step == _AuthStep.login,
                        child: _contentFor(step, auth, _reveal.value),
                      ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _contentFor(_AuthStep step, AuthProvider auth, double reveal) {
    switch (step) {
      case _AuthStep.welcome:
        return const SizedBox.shrink();
      case _AuthStep.login:
        return LoginSheetContent(
          reveal: reveal,
          reasonBanner: auth.phase == AuthPhase.reauthRequired
              ? 'For your security, please sign in again.'
              : null,
        );
      case _AuthStep.setPassword:
        return SetPasswordSheetContent(reveal: reveal);
      case _AuthStep.biometricSetup:
        return BiometricSetupSheetContent(reveal: reveal);
      case _AuthStep.biometricLock:
        return BiometricLockSheetContent(reveal: reveal);
    }
  }
}

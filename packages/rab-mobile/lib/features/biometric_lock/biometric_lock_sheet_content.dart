import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/rab_auth_sheet.dart';

/// Returning-user presentation only; native authentication and backend validation
/// remain entirely in AuthProvider.attemptBiometricRestore.
class BiometricLockSheetContent extends StatefulWidget {
  const BiometricLockSheetContent({
    super.key,
    required this.reveal,
    this.onPassword,
    this.active = true,
  });
  final double reveal;
  final VoidCallback? onPassword;
  final bool active;
  @override
  State<BiometricLockSheetContent> createState() =>
      _BiometricLockSheetContentState();
}

class _BiometricLockSheetContentState extends State<BiometricLockSheetContent> {
  bool _authenticating = false, _failed = false;
  String? _message;
  List<RabBiometricType> _types = [];
  @override
  void initState() {
    super.initState();
    _probe();
  }

  Future<void> _probe() async {
    final capability = await context
        .read<AuthProvider>()
        .checkBiometricCapability();
    if (!mounted) return;
    setState(() => _types = capability.enrolledTypes);
    if (!capability.isAvailable) {
      context.read<AuthProvider>().fallBackToPassword();
    }
  }

  @override
  void didUpdateWidget(covariant BiometricLockSheetContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) {
      _failed = false;
      _message = null;
      _probe();
    }
  }

  Future<void> _unlock() async {
    final auth = context.read<AuthProvider>();
    if (_authenticating ||
        !widget.active ||
        auth.phase != AuthPhase.biometricLocked) {
      return;
    }
    setState(() {
      _authenticating = true;
      _message = null;
    });
    final outcome = await auth.attemptBiometricRestore();
    if (!mounted) return;
    setState(() {
      _authenticating = false;
      _failed = outcome != BiometricOutcome.success;
      _message = switch (outcome) {
        BiometricOutcome.lockedOut =>
          'Too many attempts. Use your password or try again shortly.',
        BiometricOutcome.error =>
          'Unable to use biometrics. Try again or use your password.',
        _ => null,
      };
    });
    if (outcome == BiometricOutcome.notAvailable &&
        auth.phase == AuthPhase.biometricLocked) {
      auth.fallBackToPassword();
    }
  }

  @override
  Widget build(BuildContext context) {
    final icon = biometricIcon(_types);
    final email = context.watch<AuthProvider>().rememberedEmail ?? '';
    return AuthContentLayout(
      biometric: true,
      children: [
        const AuthWelcomeHeading(),
        const SizedBox(height: 24),
        Center(
          child: Container(
            key: const ValueKey('biometric-tile'),
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: const Color(0xFFEDEEEE),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(icon, size: 30, color: const Color(0xFF191D1A)),
          ),
        ),
        const SizedBox(height: 10),
        Text(
          'Sign in with a passkey',
          textAlign: TextAlign.center,
          style: context.text.bodyMobile.copyWith(
            fontSize: 14,
            fontWeight: FontWeight.w700,
            color: const Color(0xFF191D1A),
          ),
        ),
        const SizedBox(height: 5),
        Center(
          child: SizedBox(
            width: 255,
            child: Text(
              'Use your device biometrics. Nothing to remember.',
              textAlign: TextAlign.center,
              style: context.text.bodyMobile.copyWith(
                fontSize: 12,
                height: 1.4,
                color: const Color(0xFF777D78),
              ),
            ),
          ),
        ),
        const SizedBox(height: 18),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'EMAIL',
                style: context.text.microLabel.copyWith(
                  fontSize: 10,
                  letterSpacing: .8,
                  color: const Color(0xFF777D78),
                ),
              ),
              const SizedBox(height: 6),
              Semantics(
                label: 'Account email: $email',
                readOnly: true,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 13,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    border: Border.all(color: const Color(0xFFE3E5E1)),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    email,
                    style: const TextStyle(
                      fontSize: 13,
                      color: Color(0xFF777D78),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              AuthPrimaryButton(
                label: _authenticating
                    ? 'Authenticating...'
                    : _failed
                    ? 'Try again'
                    : 'Continue with passkey',
                icon: icon,
                busy: _authenticating,
                onPressed: _unlock,
              ),
              Center(
                child: TextButton.icon(
                  onPressed: _authenticating
                      ? null
                      : (widget.onPassword ??
                            context.read<AuthProvider>().fallBackToPassword),
                  icon: const Icon(Icons.key_outlined, size: 18),
                  label: const Text(
                    'Use password instead',
                    style: TextStyle(fontWeight: FontWeight.w400),
                  ),
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFF191D1A),
                    minimumSize: const Size(0, 48),
                  ),
                ),
              ),
            ],
          ),
        ),
        if (_message != null)
          Semantics(
            liveRegion: true,
            child: Text(
              _message!,
              textAlign: TextAlign.center,
              style: context.text.label.copyWith(color: context.colors.danger),
            ),
          ),
      ],
    );
  }
}

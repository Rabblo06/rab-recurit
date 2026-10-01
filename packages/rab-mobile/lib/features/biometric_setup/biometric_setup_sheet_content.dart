import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/rab_auth_sheet.dart';

/// Presentation inside the existing auth shell. The provider and native OS
/// remain the only authorities for biometric confirmation and stored trust.
class BiometricSetupSheetContent extends StatefulWidget {
  const BiometricSetupSheetContent({super.key, required this.reveal});
  final double reveal;

  @override
  State<BiometricSetupSheetContent> createState() =>
      _BiometricSetupSheetContentState();
}

class _BiometricSetupSheetContentState
    extends State<BiometricSetupSheetContent> {
  bool _busy = false;
  String? _message;
  List<RabBiometricType> _enrolledTypes = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final auth = context.read<AuthProvider>();
      final capability = await auth.checkBiometricCapability();
      if (!mounted) return;
      if (!capability.isAvailable) {
        await auth.completeBiometricSetup(enable: false);
        return;
      }
      setState(() => _enrolledTypes = capability.enrolledTypes);
    });
  }

  Future<void> _respond(bool enable) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final outcome = await context.read<AuthProvider>().completeBiometricSetup(
        enable: enable,
      );
      if (!mounted) return;
      setState(
        () => _message = switch (outcome) {
          BiometricOutcome.cancelled =>
            'Setup cancelled. Try again or skip for now.',
          BiometricOutcome.failed =>
            'Biometric confirmation failed. Try again or skip for now.',
          BiometricOutcome.lockedOut =>
            'Biometrics are temporarily locked. Try later or skip for now.',
          BiometricOutcome.notAvailable =>
            'Biometrics are unavailable. You can skip for now.',
          BiometricOutcome.error =>
            'Unable to confirm biometrics. Try again or skip for now.',
          _ => null,
        },
      );
    } catch (_) {
      if (mounted) {
        setState(
          () =>
              _message = 'Unable to complete setup. Try again or skip for now.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final icon = biometricIcon(_enrolledTypes);
    return IgnorePointer(
      ignoring: widget.reveal < 1,
      child: Opacity(
        opacity: widget.reveal.clamp(0.0, 1.0),
        child: AuthContentLayout(
          biometric: true,
          children: [
            const AuthWelcomeHeading(
              title: 'Set up Biometric Login',
              titleSize: 20,
              subtitleSize: 11,
            ),
            const SizedBox(height: 24),
            Center(
              child: Container(
                key: const ValueKey('biometric-setup-circle'),
                width: 80,
                height: 80,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Colors.white,
                  border: Border.all(color: const Color(0xFFD3D5D2)),
                ),
                alignment: Alignment.center,
                child: Container(
                  width: 46,
                  height: 46,
                  decoration: BoxDecoration(
                    color: const Color(0xFFEDEEEE),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(icon, size: 26, color: const Color(0xFF191D1A)),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Setup the passkey Login',
              textAlign: TextAlign.center,
              style: context.text.bodyMobile.copyWith(
                fontSize: 12,
                height: 1.3,
                fontWeight: FontWeight.w700,
                color: const Color(0xFF191D1A),
              ),
            ),
            const SizedBox(height: 6),
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 290),
                child: Text(
                  'Sign in with Biometric Login next time. Your biometric data stays on this device \u2014 we never see it.',
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
              child: AuthPrimaryButton(
                label: 'Enable Passkey',
                icon: icon,
                radius: 10,
                busy: _busy,
                onPressed: () => _respond(true),
              ),
            ),
            const SizedBox(height: 8),
            Center(
              child: TextButton.icon(
                onPressed: _busy ? null : () => _respond(false),
                icon: const Icon(Icons.key_outlined, size: 18),
                label: const Text(
                  'Skip for now',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w400),
                ),
                style: TextButton.styleFrom(
                  foregroundColor: const Color(0xFF191D1A),
                  minimumSize: const Size(0, 48),
                ),
              ),
            ),
            if (_message != null) ...[
              const SizedBox(height: 8),
              Semantics(
                liveRegion: true,
                child: Text(
                  _message!,
                  textAlign: TextAlign.center,
                  style: context.text.label.copyWith(
                    color: context.colors.danger,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

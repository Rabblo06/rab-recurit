import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/rab_auth_sheet.dart';
import '../../core/widgets/rab_biometric_visual.dart';

/// Returning-user unlock — same `attemptBiometricRestore()` call and
/// outcome handling as the old standalone screen; "Use password instead"
/// still calls `AuthProvider.fallBackToPassword()` unchanged, which flips
/// `phase` to `unauthenticated` and lets `AuthFlowShell` transition to the
/// Login step (never trapping the user on a failed/cancelled unlock).
class BiometricLockSheetContent extends StatefulWidget {
  const BiometricLockSheetContent({super.key, required this.reveal});

  final double reveal;

  @override
  State<BiometricLockSheetContent> createState() =>
      _BiometricLockSheetContentState();
}

class _BiometricLockSheetContentState extends State<BiometricLockSheetContent> {
  bool _authenticating = false;
  RabBiometricVisualState _visual = RabBiometricVisualState.idle;
  String? _message;
  List<RabBiometricType> _enrolledTypes = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _probeThenUnlock());
  }

  Future<void> _probeThenUnlock() async {
    final auth = context.read<AuthProvider>();
    final capability = await auth.checkBiometricCapability();
    if (!mounted) return;
    setState(() => _enrolledTypes = capability.enrolledTypes);
    await _unlock();
  }

  Future<void> _unlock() async {
    if (!mounted) return;
    setState(() {
      _authenticating = true;
      _visual = RabBiometricVisualState.scanning;
      _message = null;
    });
    final auth = context.read<AuthProvider>();
    final outcome = await auth.attemptBiometricRestore();
    if (!mounted) return;
    setState(() {
      _authenticating = false;
      _visual = outcome == BiometricOutcome.success
          ? RabBiometricVisualState.success
          : RabBiometricVisualState.failure;
      _message = switch (outcome) {
        BiometricOutcome.success => null,
        BiometricOutcome.cancelled => null,
        BiometricOutcome.lockedOut =>
          'Too many attempts. Try again shortly, or use your password.',
        BiometricOutcome.notAvailable =>
          'Biometric login is no longer available on this device.',
        BiometricOutcome.failed || BiometricOutcome.error =>
          "That didn't work. Try again, or use your password.",
      };
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final label = biometricLabel(_enrolledTypes, isIOS: isIOSPlatform);

    return StaggeredReveal(
      progress: widget.reveal,
      staggerStep: 0.1,
      children: [
        Center(
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: AppSpace.s6),
            decoration: BoxDecoration(
              color: colors.atmosphereDeep,
              borderRadius: BorderRadius.circular(AppRadius.xl),
            ),
            child: RabBiometricVisual(
              state: _visual,
              icon: biometricIcon(_enrolledTypes),
            ),
          ),
        ),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Unlock with $label',
              style: text.pageTitle.copyWith(fontSize: 24),
            ),
            const SizedBox(height: AppSpace.s2),
            Text(
              _authenticating
                  ? 'Scanning…'
                  : 'Biometrics detected on this device. Confirm to sign in.',
              style: text.bodyMobile.copyWith(color: colors.textSecondary),
            ),
            if (_message != null) ...[
              const SizedBox(height: AppSpace.s3),
              Text(
                _message!,
                style: text.bodyMobile.copyWith(color: colors.danger),
              ),
            ],
          ],
        ),
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: 56,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accentStrong,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppRadius.full),
                  ),
                ),
                onPressed: _authenticating ? null : _unlock,
                child: _authenticating
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : Text(
                        'Try again',
                        style: text.bodyMobile.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
              ),
            ),
            const SizedBox(height: AppSpace.s3),
            Center(
              child: TextButton(
                onPressed: () =>
                    context.read<AuthProvider>().fallBackToPassword(),
                child: Text(
                  'Use password instead',
                  style: text.bodyMobile.copyWith(
                    color: colors.textSecondary,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

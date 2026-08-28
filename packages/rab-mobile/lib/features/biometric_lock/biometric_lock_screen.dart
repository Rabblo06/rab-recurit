import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/concentric_ring_icon.dart';

/// Returning-user unlock screen, shown by `_RootGate` for
/// `AuthPhase.biometricLocked`. Matches the Figma "Biometric unlock" frame:
/// a dimmed `authBg` header behind a scrim, with a white bottom sheet
/// holding the unlock action. A generic concentric-ring icon is used
/// deliberately (not platform-specific iconography) to avoid showing the
/// wrong glyph on the wrong OS.
class BiometricLockScreen extends StatefulWidget {
  const BiometricLockScreen({super.key});

  @override
  State<BiometricLockScreen> createState() => _BiometricLockScreenState();
}

class _BiometricLockScreenState extends State<BiometricLockScreen> {
  bool _authenticating = false;
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
      _message = null;
    });
    final auth = context.read<AuthProvider>();
    final outcome = await auth.attemptBiometricRestore();
    if (!mounted) return;
    setState(() {
      _authenticating = false;
      _message = switch (outcome) {
        BiometricOutcome.success => null,
        BiometricOutcome.cancelled => null,
        BiometricOutcome.lockedOut => 'Too many attempts. Try again shortly, or use your password.',
        BiometricOutcome.notAvailable => 'Biometric login is no longer available on this device.',
        BiometricOutcome.failed || BiometricOutcome.error => "That didn't work. Try again, or use your password.",
      };
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final label = biometricLabel(_enrolledTypes, isIOS: isIOSPlatform);

    return Scaffold(
      backgroundColor: colors.authBg,
      body: Stack(
        children: [
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.s7),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SizedBox(height: AppSpace.s9),
                  Text('Welcome back', style: text.screenTitle),
                  const SizedBox(height: AppSpace.s2),
                  Text('Log in to see your shifts', style: text.bodyMobile.copyWith(color: colors.textSecondary)),
                ],
              ),
            ),
          ),
          // Scrim — same near-black used for `textPrimary`, at the opacity
          // the Figma frame specifies, dimming the header behind the sheet.
          Positioned.fill(child: IgnorePointer(child: Container(color: colors.textPrimary.withValues(alpha: 0.45)))),
          Align(
            alignment: Alignment.bottomCenter,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(AppSpace.s7, AppSpace.s5, AppSpace.s7, AppSpace.s8),
              decoration: BoxDecoration(
                color: colors.bgSurface,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(AppRadius.xl)),
              ),
              child: SafeArea(
                top: false,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(width: 44, height: 4, decoration: BoxDecoration(color: colors.border, borderRadius: BorderRadius.circular(2))),
                    const SizedBox(height: AppSpace.s7),
                    ConcentricRingIcon(color: colors.gold, icon: biometricIcon(_enrolledTypes)),
                    const SizedBox(height: AppSpace.s6),
                    Text('Unlock with $label', style: text.pageTitle.copyWith(fontSize: 24), textAlign: TextAlign.center),
                    const SizedBox(height: AppSpace.s2),
                    Text(
                      'Biometrics detected on this device. Confirm to sign in.',
                      style: text.bodyMobile.copyWith(color: colors.textSecondary),
                      textAlign: TextAlign.center,
                    ),
                    if (_message != null) ...[
                      const SizedBox(height: AppSpace.s4),
                      Text(_message!, style: text.bodyMobile.copyWith(color: colors.danger), textAlign: TextAlign.center),
                    ],
                    const SizedBox(height: AppSpace.s7),
                    SizedBox(
                      width: double.infinity,
                      height: 56,
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: colors.gold,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                        ),
                        onPressed: _authenticating ? null : _unlock,
                        child: _authenticating
                            ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: colors.textPrimary))
                            : Text('Confirm', style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w600)),
                      ),
                    ),
                    const SizedBox(height: AppSpace.s4),
                    TextButton(
                      onPressed: () => context.read<AuthProvider>().fallBackToPassword(),
                      child: Text('Use password instead', style: text.bodyMobile.copyWith(color: colors.textSecondary, fontWeight: FontWeight.w500)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

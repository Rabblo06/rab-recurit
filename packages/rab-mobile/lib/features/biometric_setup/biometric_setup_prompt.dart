import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/concentric_ring_icon.dart';
import 'biometric_unavailable_dialog.dart';

/// Shown by `_RootGate` for `AuthPhase.offeringBiometricSetup` — immediately
/// after a fresh password login, on hardware that supports biometrics and
/// isn't already enabled for this account. "Not Now" is always available
/// and never blocks reaching the app; biometrics can be turned on later
/// from Profile > Security.
class BiometricSetupPromptScreen extends StatefulWidget {
  const BiometricSetupPromptScreen({super.key});

  @override
  State<BiometricSetupPromptScreen> createState() => _BiometricSetupPromptScreenState();
}

class _BiometricSetupPromptScreenState extends State<BiometricSetupPromptScreen> {
  bool _busy = false;
  List<RabBiometricType> _enrolledTypes = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final capability = await context.read<AuthProvider>().checkBiometricCapability();
      if (mounted) setState(() => _enrolledTypes = capability.enrolledTypes);
    });
  }

  Future<void> _respond(bool enable) async {
    setState(() => _busy = true);
    final outcome = await context.read<AuthProvider>().completeBiometricSetup(enable: enable);
    if (mounted && outcome == BiometricOutcome.notAvailable) {
      final label = biometricLabel(_enrolledTypes, isIOS: isIOSPlatform);
      await showBiometricUnavailableDialog(context, label: label);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final label = biometricLabel(_enrolledTypes, isIOS: isIOSPlatform);

    return Scaffold(
      backgroundColor: colors.authBg,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpace.s7),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ConcentricRingIcon(color: colors.gold, size: 104, icon: biometricIcon(_enrolledTypes)),
                const SizedBox(height: AppSpace.s8),
                Text('Set up $label', style: text.screenTitle, textAlign: TextAlign.center),
                const SizedBox(height: AppSpace.s4),
                Text(
                  'Sign in with $label next time. Your biometric data stays on this device — we never see it.',
                  style: text.bodyMobile.copyWith(color: colors.textSecondary),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpace.s7),
                SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: colors.gold,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                    ),
                    onPressed: _busy ? null : () => _respond(true),
                    child: _busy
                        ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: colors.textPrimary))
                        : Text('Enable $label', style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(height: AppSpace.s3),
                SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      side: BorderSide(color: colors.border, width: 1.5),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                    ),
                    onPressed: _busy ? null : () => _respond(false),
                    child: Text('Skip for now', style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(height: AppSpace.s5),
                Text(
                  'You can turn this on any time in Profile',
                  style: text.label.copyWith(color: colors.textSecondary),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

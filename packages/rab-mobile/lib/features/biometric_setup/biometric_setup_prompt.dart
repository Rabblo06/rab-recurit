import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';

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
    await context.read<AuthProvider>().completeBiometricSetup(enable: enable);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final label = biometricLabel(_enrolledTypes, isIOS: isIOSPlatform);

    return Scaffold(
      backgroundColor: colors.bgApp,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpace.s7),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 88,
                  height: 88,
                  decoration: BoxDecoration(color: colors.accentSoft, shape: BoxShape.circle),
                  alignment: Alignment.center,
                  child: Icon(Icons.fingerprint, size: 44, color: colors.accentStrong),
                ),
                const SizedBox(height: AppSpace.s6),
                Text('Enable $label?', style: text.pageTitle, textAlign: TextAlign.center),
                const SizedBox(height: AppSpace.s3),
                Text(
                  'Use $label to sign in faster next time. Your password will still be required periodically for security.',
                  style: text.bodyMobile.copyWith(color: colors.textSecondary),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpace.s7),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: colors.accent,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
                    ),
                    onPressed: _busy ? null : () => _respond(true),
                    child: _busy
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : Text('Enable $label', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(height: AppSpace.s3),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: TextButton(
                    onPressed: _busy ? null : () => _respond(false),
                    child: const Text('Not Now'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';

/// Returning-user unlock screen, shown by `_RootGate` for
/// `AuthPhase.biometricLocked`. A generic fingerprint icon is used
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
                Text('Unlock rab', style: text.pageTitle),
                const SizedBox(height: AppSpace.s2),
                Text('Use $label to continue', style: text.bodyMobile.copyWith(color: colors.textSecondary)),
                if (_message != null) ...[
                  const SizedBox(height: AppSpace.s4),
                  Text(_message!, style: text.bodyMobile.copyWith(color: colors.danger), textAlign: TextAlign.center),
                ],
                const SizedBox(height: AppSpace.s7),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: colors.accent,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
                    ),
                    onPressed: _authenticating ? null : _unlock,
                    child: _authenticating
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(height: AppSpace.s3),
                TextButton(
                  onPressed: () => context.read<AuthProvider>().fallBackToPassword(),
                  child: const Text('Use password instead'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

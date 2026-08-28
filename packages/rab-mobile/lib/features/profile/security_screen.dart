import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';

/// Minimal Profile > Security screen — just the biometric toggle. The full
/// Account/Support Profile redesign is Increment 8's job; this only exists
/// so biometrics has a reachable "enable later" entry point, per the spec's
/// own requirement.
class SecurityScreen extends StatefulWidget {
  const SecurityScreen({super.key});

  @override
  State<SecurityScreen> createState() => _SecurityScreenState();
}

class _SecurityScreenState extends State<SecurityScreen> {
  late Future<BiometricCapability> _capabilityFuture;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _capabilityFuture = context.read<AuthProvider>().checkBiometricCapability();
  }

  Future<void> _toggle(bool value) async {
    setState(() => _busy = true);
    final auth = context.read<AuthProvider>();
    if (value) {
      await auth.enableBiometric();
    } else {
      await auth.disableBiometric();
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final auth = context.watch<AuthProvider>();

    return Scaffold(
      backgroundColor: colors.bgApp,
      appBar: AppBar(title: const Text('Security')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpace.s5),
          child: FutureBuilder<BiometricCapability>(
            future: _capabilityFuture,
            builder: (context, snapshot) {
              final capability = snapshot.data;
              if (capability == null) {
                return Center(child: CircularProgressIndicator(color: colors.accent));
              }
              final label = biometricLabel(capability.enrolledTypes, isIOS: isIOSPlatform);

              if (!capability.isAvailable) {
                return Container(
                  padding: const EdgeInsets.all(AppSpace.s5),
                  decoration: BoxDecoration(
                    color: colors.bgSurface,
                    borderRadius: BorderRadius.circular(AppRadius.md),
                    border: Border.all(color: colors.border),
                  ),
                  child: Text(
                    'Biometric authentication is not available on this device.',
                    style: text.bodyMobile.copyWith(color: colors.textSecondary),
                  ),
                );
              }

              return Container(
                decoration: BoxDecoration(
                  color: colors.bgSurface,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  border: Border.all(color: colors.border),
                ),
                child: SwitchListTile(
                  secondary: Icon(biometricIcon(capability.enrolledTypes), color: colors.accent),
                  title: Text(label, style: text.bodyMobile),
                  subtitle: Text(
                    auth.biometricEnabledForCurrentUser ? 'Enabled' : 'Off',
                    style: text.label,
                  ),
                  value: auth.biometricEnabledForCurrentUser,
                  onChanged: _busy ? null : _toggle,
                  activeTrackColor: colors.accent,
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/rab_auth_sheet.dart';
import '../../core/widgets/rab_biometric_visual.dart';
import 'biometric_unavailable_dialog.dart';

/// Shown for `AuthPhase.offeringBiometricSetup` — same capability-gated
/// logic as before (`checkBiometricCapability()` on mount,
/// `completeBiometricSetup()` on response); "Skip for now" always reaches
/// the app, biometrics can always be turned on later from Profile >
/// Security. Visual scanning state only ever *represents* the live
/// `LocalAuthentication` call in `AuthProvider` — it never gates access on
/// its own.
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
  RabBiometricVisualState _visual = RabBiometricVisualState.idle;
  List<RabBiometricType> _enrolledTypes = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final capability = await context
          .read<AuthProvider>()
          .checkBiometricCapability();
      if (mounted) setState(() => _enrolledTypes = capability.enrolledTypes);
    });
  }

  Future<void> _respond(bool enable) async {
    setState(() {
      _busy = true;
      _visual = enable
          ? RabBiometricVisualState.scanning
          : RabBiometricVisualState.idle;
    });
    final outcome = await context.read<AuthProvider>().completeBiometricSetup(
      enable: enable,
    );
    if (!mounted) return;
    if (enable) {
      setState(
        () => _visual = outcome == BiometricOutcome.success
            ? RabBiometricVisualState.success
            : RabBiometricVisualState.failure,
      );
    }
    if (outcome == BiometricOutcome.notAvailable) {
      final label = biometricLabel(_enrolledTypes, isIOS: isIOSPlatform);
      await showBiometricUnavailableDialog(context, label: label);
    }
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
            Text('Set up $label', style: text.pageTitle.copyWith(fontSize: 24)),
            const SizedBox(height: AppSpace.s2),
            Text(
              'Sign in with $label next time. Your biometric data stays on this device — we never see it.',
              style: text.bodyMobile.copyWith(color: colors.textSecondary),
            ),
          ],
        ),
        SizedBox(
          width: double.infinity,
          height: 56,
          child: FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: colors.accentStrong,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AppRadius.full),
              ),
            ),
            onPressed: _busy ? null : () => _respond(true),
            child: _busy && _visual == RabBiometricVisualState.scanning
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : Text(
                    'Enable $label',
                    style: text.bodyMobile.copyWith(
                      color: Colors.white,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
          ),
        ),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: double.infinity,
              height: 56,
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  side: BorderSide(color: colors.border, width: 1.5),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppRadius.full),
                  ),
                ),
                onPressed: _busy ? null : () => _respond(false),
                child: Text(
                  'Skip for now',
                  style: text.bodyMobile.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
            ),
            const SizedBox(height: AppSpace.s4),
            Center(
              child: Text(
                'You can turn this on any time in Profile',
                style: text.label,
                textAlign: TextAlign.center,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

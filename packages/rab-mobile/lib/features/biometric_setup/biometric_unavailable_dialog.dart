import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';

/// Shown from `BiometricSetupPromptScreen` when the live biometric check
/// (run when the user taps "Enable...") comes back `BiometricOutcome.
/// notAvailable` — e.g. the sensor became unavailable between the earlier
/// capability probe and this actual attempt. Previously this outcome was
/// silently swallowed and the user just landed in the app with no
/// explanation of why nothing happened; this closes that gap, matching the
/// Figma "Prompt · Face ID unavailable" frame (name kept for the Figma
/// reference; the dialog itself never hardcodes a specific biometric type —
/// [label] is always the caller's live-detected value). A generic warning
/// glyph is used regardless of type, since the whole point of this dialog
/// is "that type isn't available" — showing the type's own icon here would
/// send the wrong signal. Purely informational — this device will fall
/// back to email/password every time, same as before.
Future<void> showBiometricUnavailableDialog(BuildContext context, {required String label}) {
  final colors = context.colors;
  final text = context.text;

  return showDialog<void>(
    context: context,
    barrierColor: colors.textPrimary.withValues(alpha: 0.45),
    builder: (dialogContext) => Dialog(
      backgroundColor: colors.bgSurface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.xl)),
      insetPadding: const EdgeInsets.symmetric(horizontal: AppSpace.s7),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpace.s7, AppSpace.s8, AppSpace.s7, AppSpace.s7),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(shape: BoxShape.circle, color: colors.gold.withValues(alpha: 0.18)),
              alignment: Alignment.center,
              child: Text('!', style: text.pageTitle.copyWith(color: colors.gold, fontSize: 24)),
            ),
            const SizedBox(height: AppSpace.s5),
            Text('$label not available', style: text.pageTitle.copyWith(fontSize: 20), textAlign: TextAlign.center),
            const SizedBox(height: AppSpace.s3),
            Text(
              'This device does not support biometric sign-in. You will use your email and password each time.',
              style: text.bodyMobile.copyWith(color: colors.textSecondary, fontSize: 14),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpace.s6),
            SizedBox(
              width: double.infinity,
              height: 56,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: colors.gold,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                ),
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: Text('Confirm', style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w600)),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

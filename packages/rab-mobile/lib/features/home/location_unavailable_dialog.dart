import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../../core/theme/schedule_tokens.dart';

/// Shown when location is denied/unavailable and we can't get a fix — calm,
/// actionable, links out to OS settings rather than leaving the user stuck
/// on a dead-end error. Matches the existing biometric-unavailable dialog's
/// tone (`biometric_unavailable_dialog.dart`).
Future<void> showLocationUnavailableDialog(BuildContext context) {
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black45,
    builder: (dialogContext) => Dialog(
      backgroundColor: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      insetPadding: const EdgeInsets.symmetric(horizontal: 28),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(28, 32, 28, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: ScheduleTokens.dangerSoft,
              ),
              alignment: Alignment.center,
              child: const Icon(
                Icons.location_off_outlined,
                color: ScheduleTokens.danger,
              ),
            ),
            const SizedBox(height: 18),
            const Text(
              'Location unavailable',
              style: ScheduleTokens.heading,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 10),
            const Text(
              'We couldn\'t confirm your location. Please enable location '
              'access for this app in Settings, then try again.',
              style: ScheduleTokens.body,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 50,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: ScheduleTokens.accent,
                  foregroundColor: Colors.white,
                  shape: const StadiumBorder(),
                ),
                onPressed: () async {
                  Navigator.of(dialogContext).pop();
                  await Geolocator.openAppSettings();
                },
                child: const Text('Open Settings'),
              ),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
          ],
        ),
      ),
    ),
  );
}

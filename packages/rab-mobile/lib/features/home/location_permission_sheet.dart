import 'package:flutter/material.dart';

import '../../core/theme/schedule_tokens.dart';

/// Explain-before-ask, shown once before the OS location permission prompt
/// fires (the OS's own dialog carries no context) — matching the same
/// explain-first discipline the existing biometric-setup flow uses before
/// its own OS prompt. Returns `true` if the user taps "Continue" (the caller
/// then requests the OS permission and takes the actual location fix);
/// `false`/`null` if they dismiss without proceeding.
Future<bool?> showLocationPermissionSheet(BuildContext context) {
  return showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: ScheduleTokens.mint,
              ),
              alignment: Alignment.center,
              child: const Icon(Icons.location_on_outlined, color: ScheduleTokens.ink),
            ),
            const SizedBox(height: 16),
            const Text('Confirm you\'re on site', style: ScheduleTokens.heading),
            const SizedBox(height: 10),
            const Text(
              'We use your location only at the moment you clock in or out, '
              'to confirm you\'re at the venue. Your location isn\'t tracked '
              'in the background.',
              style: ScheduleTokens.body,
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 50,
              child: FilledButton(
                onPressed: () => Navigator.pop(context, true),
                style: FilledButton.styleFrom(
                  backgroundColor: ScheduleTokens.accent,
                  foregroundColor: Colors.white,
                  shape: const StadiumBorder(),
                ),
                child: const Text('Continue'),
              ),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Not now'),
            ),
          ],
        ),
      ),
    ),
  );
}

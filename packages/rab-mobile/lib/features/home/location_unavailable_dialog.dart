import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../../core/widgets/schedule_feedback.dart';

/// Location recovery uses the same modal surface as attendance confirmations.
Future<void> showLocationUnavailableDialog(
  BuildContext context,
) => showScheduleSheet<void>(
  context: context,
  builder: (sheet) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      ScheduleMessageCard(
        title: 'Location unavailable',
        message:
            "We couldn't confirm your location. Please enable location access for this app in Settings, then try again.",
        kind: ScheduleMessageKind.warning,
        actionLabel: 'Open Settings',
        onAction: () async {
          Navigator.pop(sheet);
          await Geolocator.openAppSettings();
        },
      ),
      TextButton(
        onPressed: () => Navigator.pop(sheet),
        child: const Text('Cancel'),
      ),
    ],
  ),
);

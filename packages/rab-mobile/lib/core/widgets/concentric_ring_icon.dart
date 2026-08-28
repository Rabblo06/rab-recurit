import 'package:flutter/material.dart';

/// Two concentric rings — the shared icon for the biometric lock/setup/
/// unavailable screens (Figma "Rab Workforce — Auth flow"). A plain shape,
/// not exported artwork, so it stays theme-adaptive (see the Welcome
/// screen's `_GradientCircles` for the same reasoning). Pass [icon] (from
/// `biometricIcon()`) to show the actual detected biometric type's glyph
/// inside the ring — face vs. fingerprint — instead of an empty ring;
/// omitting it keeps the plain ring for contexts with no type to show yet.
class ConcentricRingIcon extends StatelessWidget {
  const ConcentricRingIcon({super.key, required this.color, this.size = 92, this.icon});

  final Color color;
  final double size;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(shape: BoxShape.circle, color: color.withValues(alpha: 0.18)),
      alignment: Alignment.center,
      child: icon != null
          ? Icon(icon, color: color, size: size * 0.42)
          : Container(
              width: size * 0.48,
              height: size * 0.48,
              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: color, width: 2)),
            ),
    );
  }
}

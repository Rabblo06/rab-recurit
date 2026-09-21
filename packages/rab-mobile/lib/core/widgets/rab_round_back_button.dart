import 'package:flutter/material.dart';

/// The translucent circular back control used on every dark atmospheric
/// surface (auth flow's black shell, Clock In/Out hero) — one shared shape
/// so it never has to be redrawn per screen.
class RabRoundBackButton extends StatelessWidget {
  const RabRoundBackButton({
    super.key,
    required this.onPressed,
    this.color = Colors.white,
    this.backgroundColor,
  });

  final VoidCallback onPressed;
  final Color color;
  final Color? backgroundColor;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: backgroundColor ?? color.withValues(alpha: 0.16),
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onPressed,
        child: SizedBox(
          width: 40,
          height: 40,
          child: Icon(Icons.arrow_back_ios_new_rounded, size: 16, color: color),
        ),
      ),
    );
  }
}

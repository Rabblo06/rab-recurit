import 'package:flutter/material.dart';

abstract final class ShiftMotion {
  static const settle = SpringDescription(mass: 1, stiffness: 420, damping: 41);
  static const navigation = Duration(milliseconds: 360);
  static const expansion = Duration(milliseconds: 480);
  static bool reduced(BuildContext context) =>
      MediaQuery.disableAnimationsOf(context) ||
      MediaQuery.accessibleNavigationOf(context);
}

/// A real button retains keyboard activation and semantics while its visual
/// content gives immediate touch feedback. Never delays the callback.
class MotionPress extends StatefulWidget {
  const MotionPress({
    super.key,
    required this.child,
    required this.onPressed,
    required this.label,
  });
  final Widget child;
  final VoidCallback? onPressed;
  final String label;
  @override
  State<MotionPress> createState() => _MotionPressState();
}

class _MotionPressState extends State<MotionPress> {
  bool _down = false;
  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (_) {
      if (widget.onPressed != null) setState(() => _down = true);
    },
    onPointerUp: (_) => setState(() => _down = false),
    onPointerCancel: (_) => setState(() => _down = false),
    child: AnimatedScale(
      scale: _down && !ShiftMotion.reduced(context) ? .92 : 1,
      duration: const Duration(milliseconds: 90),
      child: TextButton(
        onPressed: widget.onPressed,
        style: TextButton.styleFrom(
          padding: EdgeInsets.zero,
          minimumSize: const Size(48, 48),
        ),
        child: Semantics(
          label: widget.label,
          excludeSemantics: true,
          child: widget.child,
        ),
      ),
    ),
  );
}

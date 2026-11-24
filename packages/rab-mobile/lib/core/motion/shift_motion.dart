import 'package:flutter/material.dart';

abstract final class ShiftMotion {
  static const settle = SpringDescription(mass: 1, stiffness: 420, damping: 41);
  static const navigation = Duration(milliseconds: 360);
  static const expansion = Duration(milliseconds: 480);
  static bool reduced(BuildContext context) =>
      MediaQuery.disableAnimationsOf(context) ||
      MediaQuery.accessibleNavigationOf(context);
}

/// Changes presentation without keeping outgoing controls interactive or
/// exposing two copies to assistive technology. Values remain server supplied.
class MotionContent extends StatelessWidget {
  const MotionContent({
    super.key,
    required this.identity,
    required this.child,
    this.reverse = false,
  });
  final Object identity;
  final Widget child;
  final bool reverse;

  @override
  Widget build(BuildContext context) {
    if (ShiftMotion.reduced(context)) return child;
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 260),
      reverseDuration: const Duration(milliseconds: 180),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      layoutBuilder: (current, previous) => Stack(
        alignment: Alignment.topLeft,
        children: [
          for (final outgoing in previous)
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: IgnorePointer(
                child: ExcludeSemantics(child: ExcludeFocus(child: outgoing)),
              ),
            ),
          ?current,
        ],
      ),
      transitionBuilder: (content, animation) => FadeTransition(
        opacity: animation,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: Offset(reverse ? -.035 : .035, 0),
            end: Offset.zero,
          ).animate(animation),
          child: content,
        ),
      ),
      child: KeyedSubtree(key: ValueKey(identity), child: child),
    );
  }
}

class MotionCount extends StatelessWidget {
  const MotionCount({super.key, required this.value, this.style});
  final int? value;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => MotionContent(
    identity: value ?? 'unknown',
    child: Text(value?.toString() ?? '—', style: style),
  );
}

/// Presentation-only press feedback around an existing button/card. The child
/// keeps its own semantics, keyboard activation, focus and business callback.
class PressFeedback extends StatefulWidget {
  const PressFeedback({super.key, required this.child, this.enabled = true});
  final Widget child;
  final bool enabled;
  @override
  State<PressFeedback> createState() => _PressFeedbackState();
}

class _PressFeedbackState extends State<PressFeedback> {
  bool _pressed = false;
  void _set(bool value) {
    if (_pressed != value) setState(() => _pressed = value);
  }

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (_) {
      if (widget.enabled) _set(true);
    },
    onPointerUp: (_) => _set(false),
    onPointerCancel: (_) => _set(false),
    child: AnimatedScale(
      scale: widget.enabled && _pressed && !ShiftMotion.reduced(context)
          ? .985
          : 1,
      duration: ShiftMotion.reduced(context)
          ? Duration.zero
          : const Duration(milliseconds: 120),
      curve: Curves.easeOutCubic,
      child: widget.child,
    ),
  );
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

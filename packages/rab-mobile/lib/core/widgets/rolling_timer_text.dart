import 'package:flutter/material.dart';
import '../motion/shift_motion.dart';

/// Arc-style per-digit motion. The caller remains the source of time.
class RollingTimerText extends StatelessWidget {
  const RollingTimerText({super.key, required this.text, required this.style});
  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final reduced = ShiftMotion.reduced(context);
    return Semantics(
      label: text,
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < text.length; i++)
              ClipRect(
                child: AnimatedSwitcher(
                  duration: reduced
                      ? Duration.zero
                      : const Duration(milliseconds: 220),
                  switchInCurve: Curves.easeOutCubic,
                  switchOutCurve: Curves.easeInCubic,
                  transitionBuilder: (child, animation) => FadeTransition(
                    opacity: animation,
                    child: SlideTransition(
                      position: Tween<Offset>(
                        begin: const Offset(0, .35),
                        end: Offset.zero,
                      ).animate(animation),
                      child: child,
                    ),
                  ),
                  child: Text(
                    text[i],
                    key: ValueKey('$i:${text[i]}'),
                    style: style,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

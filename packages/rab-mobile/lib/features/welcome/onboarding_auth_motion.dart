import 'package:flutter/material.dart';

abstract final class OnboardingAuthMotion {
  static const duration = Duration(milliseconds: 450);
  static double shared(Animation<double> animation) {
    final t = animation.value;
    // Reverse runs the controller from 1 to 0. Complement easeOut's
    // elapsed-time distance so returning travel starts fast and settles slowly.
    return animation.status == AnimationStatus.reverse
        ? 1 - Curves.easeOutCubic.transform(1 - t)
        : Curves.easeInCubic.transform(t);
  }
}

/// The parent scene moves every element. Only images/cards add a slight
/// local transform; copy, indicators and CTA never disappear independently.
class OnboardingAuthPart extends StatelessWidget {
  const OnboardingAuthPart({
    super.key,
    required this.progress,
    required this.child,
    this.visual = false,
  });
  final Animation<double> progress;
  final Widget child;
  final bool visual;

  @override
  Widget build(BuildContext context) {
    if (!visual) return child;
    return AnimatedBuilder(
      animation: progress,
      child: RepaintBoundary(child: child),
      builder: (context, child) {
        final t = OnboardingAuthMotion.shared(progress);
        final lift = (MediaQuery.sizeOf(context).height * .025).clamp(
          0.0,
          24.0,
        );
        return Transform.translate(
          offset: Offset(0, -lift * t),
          child: Transform.scale(scale: 1 - .03 * t, child: child),
        );
      },
    );
  }
}

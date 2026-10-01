import 'package:flutter/material.dart';

const onboardingCream = Color(0xFFF6F5F1);
const onboardingInk = Color(0xFF171713);
const onboardingMuted = Color(0xFF786E66);

/// Local motion tokens; no additional animation dependency.
abstract final class OnboardingMotion {
  static const autoPageInterval = Duration(seconds: 4);
  static Duration get hold => autoPageInterval - pageTransition;
  static const pageTransition = Duration(milliseconds: 650);
  static const pageCurve = Curves.easeInOutCubic;
  static const entrance = Duration(milliseconds: 700);
  static const indicator = Duration(milliseconds: 200);
  static const content = Duration(milliseconds: 400);
  static const contentSequence = Duration(milliseconds: 700);
  static const curve = Curves.easeOutCubic;
}

class OnboardingCta extends StatelessWidget {
  const OnboardingCta({super.key, required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Material(
    color: onboardingInk,
    borderRadius: BorderRadius.circular(22),
    child: InkWell(
      onTap: onPressed,
      borderRadius: BorderRadius.circular(22),
      splashFactory: NoSplash.splashFactory,
      splashColor: Colors.transparent,
      highlightColor: Colors.transparent,
      hoverColor: Colors.transparent,
      child: const Padding(
        padding: EdgeInsets.fromLTRB(22, 9, 9, 9),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Get Started',
              style: TextStyle(
                color: Colors.white,
                fontSize: 15,
                fontWeight: FontWeight.w400,
              ),
            ),
            SizedBox(width: 24),
            ExcludeSemantics(
              child: CircleAvatar(
                radius: 19,
                backgroundColor: Colors.white,
                child: Icon(Icons.north_east, size: 18, color: onboardingInk),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Three deliberate entrance beats, with settled image layers retained as children.
class OnboardingReveal extends StatelessWidget {
  const OnboardingReveal({
    super.key,
    required this.animation,
    required this.start,
    required this.end,
    this.image = false,
    required this.child,
  });
  final Animation<double> animation;
  final double start;
  final double end;
  final bool image;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return AnimatedBuilder(
      animation: animation,
      child: child,
      builder: (context, child) {
        final t = Interval(
          start,
          end,
          curve: OnboardingMotion.curve,
        ).transform(animation.value);
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, (1 - t) * 14),
            child: Transform.scale(
              scale: image ? .97 + .03 * t : 1,
              child: child,
            ),
          ),
        );
      },
    );
  }
}

/// Short, staggered content entrance; zero offset in the settled layout.
class OnboardingSlideIn extends StatelessWidget {
  const OnboardingSlideIn({
    super.key,
    required this.animation,
    required this.child,
    this.delay = 0,
    this.offset = const Offset(-24, 0),
  });
  final Animation<double> animation;
  final Widget child;
  final int delay;
  final Offset offset;

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return AnimatedBuilder(
      animation: animation,
      child: child,
      builder: (context, child) {
        final total = OnboardingMotion.contentSequence.inMilliseconds;
        final t = Interval(
          delay / total,
          (delay + OnboardingMotion.content.inMilliseconds) / total,
          curve: OnboardingMotion.curve,
        ).transform(animation.value);
        return Opacity(
          opacity: t,
          child: Transform.translate(offset: offset * (1 - t), child: child),
        );
      },
    );
  }
}

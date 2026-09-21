import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// The white bottom sheet shared by every "docked" auth-flow step (Login,
/// Set Password, Biometric Setup, Biometric Unlock). [progress] is driven
/// externally by `AuthFlowShell`'s controller: 0 = fully below the physical
/// screen, 1 = docked at rest. Anchored into the bottom edge (extends
/// through the bottom safe area) rather than floating, per spec — no
/// rounded bottom corners, no margin around it.
/// Shared destination geometry for the morph and the docked sheet.
class AuthSheetGeometry {
  static double top(MediaQueryData media) {
    final available = media.size.height - media.viewInsets.bottom;
    final usable = available - media.viewPadding.top - media.viewPadding.bottom;
    return media.viewPadding.top + usable * 0.25;
  }
}

class AuthSheet extends StatelessWidget {
  const AuthSheet({
    super.key,
    required this.progress,
    required this.child,
    this.isLogin = false,
  });
  final double progress;
  final Widget child;
  final bool isLogin;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final top = AuthSheetGeometry.top(media);
    return Positioned(
      top: top,
      left: 0,
      right: 0,
      bottom: media.viewInsets.bottom,
      child: Transform.translate(
        offset: Offset(
          0,
          media.size.height *
              (1 - Curves.easeOutCubic.transform(progress.clamp(0.0, 1.0))),
        ),
        child: DecoratedBox(
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
          ),
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              24,
              isLogin && media.size.height >= 640 ? 56 : 16,
              24,
              20 + (media.viewInsets.bottom > 0 ? 0 : media.viewPadding.bottom),
            ),
            child: isLogin ? child : SingleChildScrollView(child: child),
          ),
        ),
      ),
    );
  }
}

/// Applies the §19 content-stagger to a fixed list of children: each item
/// fades in + rises 10px, `staggerStep` later than the previous one, driven
/// by one overall [progress] value (already remapped by the caller so 0..1
/// spans just the reveal window, e.g. the sheet's own 0.7→1.0 travel).
class StaggeredReveal extends StatelessWidget {
  const StaggeredReveal({
    super.key,
    required this.progress,
    required this.children,
    this.staggerStep = 0.12,
    this.spacing = AppSpace.s5,
  });

  final double progress;
  final List<Widget> children;
  final double staggerStep;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    final n = children.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < n; i++) ...[
          if (i > 0) SizedBox(height: spacing),
          Builder(
            builder: (context) {
              final delay = i * staggerStep;
              final span = 1 - (n - 1) * staggerStep;
              final local = span <= 0
                  ? progress
                  : ((progress - delay) / span).clamp(0.0, 1.0);
              return Opacity(
                opacity: local,
                child: Transform.translate(
                  offset: Offset(0, 10 * (1 - local)),
                  child: children[i],
                ),
              );
            },
          ),
        ],
      ],
    );
  }
}

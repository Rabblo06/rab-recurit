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
  static double top(MediaQueryData media, {bool signIn = true}) {
    final available = media.size.height - media.viewInsets.bottom;
    final usable = available - media.viewPadding.top - media.viewPadding.bottom;
    return media.viewPadding.top + usable * (signIn ? 0.31 : 0.25);
  }
}

class AuthSheet extends StatelessWidget {
  const AuthSheet({
    super.key,
    required this.progress,
    required this.child,
    this.isLogin = false,
    this.isSetup = false,
    this.surfaceColor = Colors.white,
  });
  final double progress;
  final Widget child;
  final bool isLogin;
  final bool isSetup;
  final Color surfaceColor;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final top = AuthSheetGeometry.top(media, signIn: isLogin || isSetup);
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
          decoration: BoxDecoration(
            color: surfaceColor,
            borderRadius: BorderRadius.vertical(
              top: Radius.circular(isSetup ? 28 : 32),
            ),
          ),
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              24,
              isSetup
                  ? (media.size.height >= 640 ? 40 : 24)
                  : isLogin && media.size.height >= 640
                  ? 56
                  : 16,
              24,
              20 + (media.viewInsets.bottom > 0 ? 0 : media.viewPadding.bottom),
            ),
            child: isLogin || isSetup
                ? child
                : SingleChildScrollView(child: child),
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

/// Shared sign-in primitives. These contain no authentication or storage logic.
class AuthWelcomeHeading extends StatelessWidget {
  const AuthWelcomeHeading({
    super.key,
    this.title = 'Welcome back',
    this.titleSize = 25,
    this.subtitleSize = 12,
  });
  final String title;
  final double titleSize;
  final double subtitleSize;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        title,
        style: context.text.pageTitle.copyWith(
          fontSize: titleSize,
          height: 1.15,
          fontWeight: FontWeight.w700,
          color: const Color(0xFF191D1A),
        ),
      ),
      const SizedBox(height: 4),
      Text(
        'Log in to see your shifts.',
        style: context.text.bodyMobile.copyWith(
          fontSize: subtitleSize,
          height: 1.3,
          color: const Color(0xFF0F5C3F),
        ),
      ),
    ],
  );
}

class AuthPrimaryButton extends StatelessWidget {
  const AuthPrimaryButton({
    super.key,
    required this.label,
    required this.icon,
    required this.onPressed,
    this.busy = false,
    this.radius = 12,
  });
  final String label;
  final IconData icon;
  final VoidCallback? onPressed;
  final bool busy;
  final double radius;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: double.infinity,
    child: FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: Colors.black,
        disabledBackgroundColor: Colors.black,
        foregroundColor: Colors.white,
        disabledForegroundColor: Colors.white70,
        minimumSize: const Size(0, 50),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radius),
        ),
      ),
      onPressed: busy ? null : onPressed,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (busy)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Colors.white,
              ),
            )
          else
            Icon(icon, size: 18),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              label,
              textAlign: TextAlign.center,
              style: context.text.bodyMobile.copyWith(
                fontSize: 14,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class AuthFooterLine extends StatelessWidget {
  const AuthFooterLine({super.key, this.biometric = false});
  final bool biometric;
  @override
  Widget build(BuildContext context) => Row(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      const Icon(
        Icons.verified_user_outlined,
        size: 13,
        color: Color(0xFF777D78),
      ),
      const SizedBox(width: 6),
      Flexible(
        child: Text(
          biometric
              ? 'Protected by your device biometrics.'
              : 'Get offers. Complete shifts. Get paid.',
          style: context.text.label.copyWith(
            fontSize: 10,
            color: const Color(0xFF777D78),
          ),
        ),
      ),
    ],
  );
}

/// Natural-height content with a low footer; scrolls when text/keyboard needs it.
/// Avoids IntrinsicHeight, whose estimates can clip width-constrained copy.
class AuthContentLayout extends StatelessWidget {
  const AuthContentLayout({
    super.key,
    required this.children,
    required this.biometric,
  });
  final List<Widget> children;
  final bool biometric;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => SingleChildScrollView(
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: constraints.maxHeight),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: children,
            ),
            Padding(
              padding: const EdgeInsets.only(top: 24, bottom: 24),
              child: AuthFooterLine(biometric: biometric),
            ),
          ],
        ),
      ),
    ),
  );
}

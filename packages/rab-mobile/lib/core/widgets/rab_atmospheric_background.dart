import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../theme/tokens.dart';
import 'rab_round_back_button.dart';
import 'rab_auth_sheet.dart';

/// The persistent backdrop behind the whole auth flow (Welcome → Login →
/// Set Password → Biometric Setup/Unlock). Two visual states, and every
/// value in between them driven by a single [t] in [0, 1]:
///
/// t = 0 ("Welcome mode"): warm off-white base, a large soft forest/sage
/// geometric composition, and a small black rounded object overlapping its
/// bottom-right corner — a separate object from the "Get Started" button,
/// which sits below the geometry in the cream area (see `AuthFlowShell`).
///
/// t = 1 ("Login mode"): the small black object has expanded into the full-
/// width black upper region every other auth screen sits under, with a
/// circular back button inside it. The green composition and "Get Started"
/// have faded and risen out of view.
///
/// `AuthFlowShell` is the only caller — it drives [t] frame-by-frame from
/// its own `AnimationController` rather than this widget animating itself,
/// so it stays perfectly in step with the white sheet's own motion.
class AuthBackdrop extends StatelessWidget {
  const AuthBackdrop({
    super.key,
    required this.t,
    required this.welcomeTitle,
    required this.getStartedButton,
    this.onBack,
  });

  /// 0 = Welcome composition, 1 = Login/black-top composition.
  final double t;

  /// Wordmark shown above the green geometry — fades and rises out
  /// as [t] increases.
  final Widget welcomeTitle;

  /// The "Get Started" action, shown in the cream area below the geometry.
  final Widget getStartedButton;

  /// Non-null once a back action is meaningful (i.e. Welcome was shown this
  /// session) — the circular back button fades in as the black region forms.
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final size = MediaQuery.sizeOf(context);
    final topSafe = MediaQuery.paddingOf(context).top;

    final padding = MediaQuery.paddingOf(context);
    final usableHeight = size.height - padding.top - padding.bottom;
    final inset = size.width * 0.07;
    final panel = Rect.fromLTWH(
      inset,
      padding.top + usableHeight * 0.20,
      size.width - inset * 2,
      usableHeight * 0.45,
    );
    final smallWidth = size.width * 0.25;
    final smallHeight = size.height * 0.13;
    final smallLeft = panel.right - smallWidth * 0.80;
    final smallTop = panel.bottom - smallHeight * 0.85;
    final bandHeight = AuthSheetGeometry.top(MediaQuery.of(context)) + 32;

    final left = ui.lerpDouble(smallLeft, 0, t)!;
    final top = ui.lerpDouble(smallTop, 0, t)!;
    final width = ui.lerpDouble(smallWidth, size.width, t)!;
    final height = ui.lerpDouble(smallHeight, bandHeight, t)!;
    final radius = ui.lerpDouble(22, 0, t)!;
    final bottomRadius = ui.lerpDouble(22, AppRadius.xl, t)!;

    // Dropped from the tree once fully morphed away — an `Opacity` of 0
    // still paints nothing but leaves the widget (and its text) present
    // and hit-testable, which is wrong once Login is showing.
    final showWelcomeForeground = t < 0.98;
    final welcomeOpacity = (1 - t * 1.4).clamp(0.0, 1.0);
    final welcomeRise = Offset(0, -60 * t);

    return ColoredBox(
      color: Color.lerp(colors.authBg, Colors.black, t)!,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          // Large green geometric composition — fades and rises away.
          Positioned(
            left: panel.left,
            top: panel.top,
            child: Opacity(
              opacity: welcomeOpacity,
              child: Transform.translate(
                offset: welcomeRise,
                child: _GreenGeometry(size: panel.size),
              ),
            ),
          ),
          if (showWelcomeForeground)
            Positioned(
              left: inset,
              right: inset,
              top: padding.top + usableHeight * 0.055,
              child: IgnorePointer(
                ignoring: t > 0.4,
                child: Opacity(
                  opacity: welcomeOpacity,
                  child: Transform.translate(
                    offset: welcomeRise,
                    child: welcomeTitle,
                  ),
                ),
              ),
            ),
          if (showWelcomeForeground)
            Positioned(
              left: inset,
              right: inset,
              bottom: padding.bottom + 24,
              child: IgnorePointer(
                ignoring: t > 0.4,
                child: Opacity(
                  opacity: welcomeOpacity,
                  child: Transform.translate(
                    offset: welcomeRise,
                    child: getStartedButton,
                  ),
                ),
              ),
            ),
          // The morphing object — small rounded square -> full black band.
          Positioned(
            left: left,
            top: top,
            width: width,
            height: height,
            child: Container(
              decoration: BoxDecoration(
                color: Colors.black,
                border: Border.all(
                  color: colors.authBg.withValues(alpha: 1 - t),
                  width: 5 * (1 - t),
                ),
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(radius),
                  topRight: Radius.circular(radius),
                  bottomLeft: Radius.circular(bottomRadius),
                  bottomRight: Radius.circular(bottomRadius),
                ),
              ),
            ),
          ),
          if (onBack != null)
            Positioned(
              left: AppSpace.s6,
              top: topSafe + 24,
              child: Opacity(
                opacity: ((t - 0.6) / 0.4).clamp(0.0, 1.0),
                child: RabRoundBackButton(
                  onPressed: onBack!,
                  color: Colors.black,
                  backgroundColor: Colors.white,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _GreenGeometry extends StatelessWidget {
  const _GreenGeometry({required this.size});
  final Size size;

  @override
  Widget build(BuildContext context) {
    return ClipPath(
      clipper: _WelcomePanelClipper(),
      child: Container(
        width: size.width,
        height: size.height,
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFF0F5C3F), Color(0xFF287C58)],
          ),
        ),
        alignment: Alignment.topRight,
        padding: EdgeInsets.all(size.width * 0.045),
        child: ExcludeSemantics(
          child: Container(
            width: size.width * 0.19,
            height: 16,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
            decoration: BoxDecoration(
              color: const Color(0xFF164C35),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFFF7F5F0),
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
                const SizedBox(width: 5),
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFF0B3927),
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _WelcomePanelClipper extends CustomClipper<Path> {
  @override
  Path getClip(Size size) {
    final r = size.width * 0.095;
    return Path()
      ..moveTo(r, 0)
      ..lineTo(size.width - r * 1.15, 0)
      ..quadraticBezierTo(size.width, 0, size.width, r * 1.15)
      ..lineTo(size.width, size.height)
      ..lineTo(r * 1.15, size.height)
      ..quadraticBezierTo(0, size.height, 0, size.height - r * 1.15)
      ..lineTo(0, r)
      ..quadraticBezierTo(0, 0, r, 0)
      ..close();
  }

  @override
  bool shouldReclip(_WelcomePanelClipper oldClipper) => false;
}

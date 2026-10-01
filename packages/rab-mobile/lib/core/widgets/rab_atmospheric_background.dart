import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import 'rab_round_back_button.dart';
import 'rab_auth_sheet.dart';

/// Keeps the existing login/auth band geometry at t=1. The editorial welcome
/// fades into that band without the retired green panel or floating square.
class AuthBackdrop extends StatelessWidget {
  const AuthBackdrop({
    super.key,
    required this.t,
    required this.welcomeContent,
    this.onBack,
  });
  final double t;
  final Widget welcomeContent;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final reduced = MediaQuery.disableAnimationsOf(context);
    final progress = reduced ? (t > 0 ? 1.0 : 0.0) : t;
    return ColoredBox(
      color: Color.lerp(const Color(0xFFF6F5F1), Colors.black, progress)!,
      child: Stack(
        children: [
          if (progress < .98)
            Positioned.fill(
              child: IgnorePointer(
                ignoring: progress > 0,
                child: ExcludeSemantics(
                  excluding: progress > 0,
                  child: Opacity(opacity: 1 - progress, child: welcomeContent),
                ),
              ),
            ),
          if (progress > 0)
            Positioned(
              left: 0,
              right: 0,
              top: 0,
              height: AuthSheetGeometry.top(MediaQuery.of(context)) + 32,
              child: IgnorePointer(
                child: Opacity(
                  opacity: progress,
                  child: Container(
                    decoration: const BoxDecoration(
                      color: Colors.black,
                      borderRadius: BorderRadius.vertical(
                        bottom: Radius.circular(AppRadius.xl),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (onBack != null && progress > .6)
            Positioned(
              left: AppSpace.s6,
              top: MediaQuery.paddingOf(context).top + 24,
              child: Opacity(
                opacity: ((progress - .6) / .4).clamp(0.0, 1.0),
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

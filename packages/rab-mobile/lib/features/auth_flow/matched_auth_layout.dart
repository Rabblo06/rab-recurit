import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/widgets/rab_atmospheric_background.dart';
import '../../core/widgets/rab_auth_sheet.dart';
import '../welcome/onboarding_auth_motion.dart';
import '../welcome/onboarding_motion.dart';

/// Complete page scenes share one edge and one reversible timeline.
/// Local image transforms are secondary to the parent page movement.
class MatchedAuthLayout extends StatelessWidget {
  const MatchedAuthLayout({
    super.key,
    required this.progress,
    required this.welcome,
    required this.login,
    required this.onBack,
    required this.transitioning,
  });
  final Animation<double> progress;
  final Widget welcome;
  final Widget login;
  final VoidCallback onBack;
  final bool transitioning;

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.sizeOf(context).height;
    final loginPage = RepaintBoundary(
      child: Stack(
        fit: StackFit.expand,
        children: [
          AuthBackdrop(
            t: 1,
            welcomeContent: const SizedBox.shrink(),
            onBack: onBack,
          ),
          AuthSheet(progress: 1, isLogin: true, child: login),
        ],
      ),
    );
    final welcomePage = RepaintBoundary(child: welcome);
    return AnimatedBuilder(
      animation: progress,
      builder: (context, _) {
        final t = progress.value;
        final travel = height * OnboardingAuthMotion.shared(progress);
        // Login top == Welcome bottom at every frame, including reversal.
        // Different delayed curves here would expose a gap or a page overlap.
        return AnnotatedRegion<SystemUiOverlayStyle>(
          value:
              (t == 1 ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark)
                  .copyWith(
                    statusBarColor: Colors.transparent,
                    systemNavigationBarColor: Colors.transparent,
                    systemNavigationBarIconBrightness: Brightness.dark,
                  ),
          child: ClipRect(
            child: ColoredBox(
              key: const ValueKey('auth-morph-canvas'),
              color: onboardingCream,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Transform.translate(
                    key: const ValueKey('auth-login-scene'),
                    offset: Offset(0, height - travel),
                    child: Offstage(
                      offstage: t == 0,
                      child: IgnorePointer(
                        ignoring: t < 1 || transitioning,
                        child: ExcludeFocus(
                          excluding: t < 1,
                          child: ExcludeSemantics(
                            excluding: t < 1,
                            child: loginPage,
                          ),
                        ),
                      ),
                    ),
                  ),
                  Transform.translate(
                    key: const ValueKey('auth-onboarding-scene'),
                    offset: Offset(0, -travel),
                    child: IgnorePointer(
                      ignoring: t > 0 || transitioning,
                      child: ExcludeFocus(
                        excluding: t > 0,
                        child: ExcludeSemantics(
                          excluding: t > 0,
                          child: welcomePage,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

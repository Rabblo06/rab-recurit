import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';

/// Welcome's editorial wordmark — sits above the green geometry. Staff
/// accounts are provisioned by a Manager/Admin only (no public
/// self-registration route exists), so there is deliberately no "Create
/// account" control anywhere in this flow.
class WelcomeTitle extends StatelessWidget {
  const WelcomeTitle({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;

    return Padding(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'RAB',
            style: text.screenTitle.copyWith(
              fontSize: 44,
              height: 1,
              letterSpacing: -2,
              fontWeight: FontWeight.w600,
              color: colors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpace.s2),
          Text(
            'Recruitment',
            style: text.bodyMobile.copyWith(
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: colors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

/// The "Get Started" action — sits in the cream area *below* the green
/// geometry (not inside it), a separate visual object from the small black
/// square that morphs into Login's black top region (see `AuthBackdrop`).
/// Only this button's own press-scale animates here; the Welcome -> Login
/// choreography itself lives in `AuthFlowShell`.
class WelcomeGetStartedButton extends StatefulWidget {
  const WelcomeGetStartedButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  State<WelcomeGetStartedButton> createState() =>
      _WelcomeGetStartedButtonState();
}

class _WelcomeGetStartedButtonState extends State<WelcomeGetStartedButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    return GestureDetector(
      onTapDown: (_) => setState(() => _pressed = true),
      onTapCancel: () => setState(() => _pressed = false),
      onTapUp: (_) => setState(() => _pressed = false),
      onTap: widget.onPressed,
      child: AnimatedScale(
        scale: _pressed ? 0.97 : 1.0,
        duration: AppMotion.buttonPress,
        child: Container(
          height: 56,
          padding: const EdgeInsets.only(left: AppSpace.s6, right: 6),
          decoration: BoxDecoration(
            color: const Color(0xFFEAECE7),
            borderRadius: BorderRadius.circular(22),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.max,
            children: [
              Text(
                'Get Started',
                style: text.bodyMobile.copyWith(
                  color: colors.textPrimary,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const Spacer(),
              Container(
                width: 56,
                height: 32,
                decoration: BoxDecoration(
                  color: const Color(0xFF000000),
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Icon(
                  Icons.arrow_downward_rounded,
                  color: colors.onDarkPrimary,
                  size: 16,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}


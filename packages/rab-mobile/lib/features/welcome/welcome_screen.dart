import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';
import '../login/login_screen.dart';

/// Shown by `_RootGate` (see app.dart) for every unauthenticated visitor,
/// before `LoginScreen`. "Create Account" is deliberately not a real
/// registration form — Staff accounts are provisioned by a Manager/Admin
/// only, confirmed against the backend elsewhere this session, so a public
/// self-registration flow would be insecure and would not match how any
/// account here actually gets created.
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final width = MediaQuery.of(context).size.width;

    return Scaffold(
      backgroundColor: colors.authBg,
      body: SafeArea(
        child: Stack(
          children: [
            _GradientCircles(colors: colors, width: width),
            Column(
              children: [
                const Spacer(flex: 5),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.s7),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Create your dream now', style: text.screenTitle.copyWith(fontWeight: FontWeight.w800)),
                      const SizedBox(height: AppSpace.s3),
                      Text(
                        'Your dream is one step away from becoming a reality',
                        style: text.bodyMobile.copyWith(color: colors.textSecondary),
                      ),
                      const SizedBox(height: AppSpace.s6),
                      Divider(color: colors.border, height: 1),
                      const SizedBox(height: AppSpace.s6),
                      SizedBox(
                        width: double.infinity,
                        height: 52,
                        child: FilledButton(
                          style: FilledButton.styleFrom(
                            backgroundColor: colors.gold,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                          ),
                          onPressed: () => _showCreateAccountInfo(context),
                          child: Text(
                            'Create Account',
                            style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w700),
                          ),
                        ),
                      ),
                      const SizedBox(height: AppSpace.s3),
                      SizedBox(
                        width: double.infinity,
                        height: 52,
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            side: BorderSide(color: colors.textPrimary),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                          ),
                          onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const LoginScreen())),
                          child: Text('Login', style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w700)),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpace.s6),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _showCreateAccountInfo(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Staff accounts are provisioned'),
        content: const Text('Staff accounts are created by your manager or admin. Contact them to request access.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }
}

/// Three overlapping flat-gold circles bleeding off the top-left, matching
/// the Figma "Welcome" frame (390×844 reference, node `4:2`) exactly:
/// a large circle top-left partly off-screen, a lighter mid-right circle,
/// and a second large circle lower-left overlapping the first. Positioned
/// as a fraction of the reference frame's 390px width so it scales sanely
/// across device sizes rather than assuming one fixed phone width.
class _GradientCircles extends StatelessWidget {
  const _GradientCircles({required this.colors, required this.width});

  final AppColorsX colors;
  final double width;

  static const _frameWidth = 390.0;

  @override
  Widget build(BuildContext context) {
    final scale = width / _frameWidth;

    Widget circle(double size, double opacity) {
      return Container(
        width: size * scale,
        height: size * scale,
        decoration: BoxDecoration(shape: BoxShape.circle, color: colors.gold.withValues(alpha: opacity)),
      );
    }

    return SizedBox(
      height: 510 * scale,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(left: -50 * scale, top: 10 * scale, child: circle(250, 0.9)),
          Positioned(left: 200 * scale, top: 150 * scale, child: circle(220, 0.45)),
          Positioned(left: 10 * scale, top: 260 * scale, child: circle(250, 0.85)),
        ],
      ),
    );
  }
}

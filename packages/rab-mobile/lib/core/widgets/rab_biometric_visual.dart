import 'package:flutter/material.dart';

import '../theme/tokens.dart';

enum RabBiometricVisualState { idle, scanning, success, failure }

/// Original RAB biometric visual — not a copy of Apple's Face ID animation.
/// A static ring + glyph at rest; while [state] is `scanning`, a light
/// sweeps vertically inside the ring on a repeating loop; `success` stops
/// the sweep and plays a single check-mark + expanding ring pulse;
/// `failure` plays one short, restrained horizontal shake — never a full-
/// screen shake, per spec. Purely visual: the real platform biometric API
/// (`BiometricAuthenticator`) remains the sole source of truth for whether
/// authentication actually succeeded — this widget never decides that.
class RabBiometricVisual extends StatefulWidget {
  const RabBiometricVisual({
    super.key,
    required this.state,
    required this.icon,
    this.size = 140,
  });

  final RabBiometricVisualState state;
  final IconData icon;
  final double size;

  @override
  State<RabBiometricVisual> createState() => _RabBiometricVisualState();
}

class _RabBiometricVisualState extends State<RabBiometricVisual>
    with TickerProviderStateMixin {
  late final AnimationController _sweep = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat(reverse: true);
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 450),
  );
  late final AnimationController _shake = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 380),
  );

  @override
  void didUpdateWidget(covariant RabBiometricVisual oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state != widget.state) {
      if (widget.state == RabBiometricVisualState.success) {
        _pulse.forward(from: 0);
      } else if (widget.state == RabBiometricVisualState.failure) {
        _shake.forward(from: 0);
      } else {
        _pulse.value = 0;
        _shake.value = 0;
      }
    }
  }

  @override
  void dispose() {
    _sweep.dispose();
    _pulse.dispose();
    _shake.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return AnimatedBuilder(
      animation: Listenable.merge([_sweep, _pulse, _shake]),
      builder: (context, _) {
        final shakeOffset = widget.state == RabBiometricVisualState.failure
            ? (8 * (1 - _shake.value) * (1 - _shake.value)) *
                  ((_shake.value * 6).floor().isEven ? 1 : -1)
            : 0.0;
        return Transform.translate(
          offset: Offset(shakeOffset, 0),
          child: SizedBox(
            width: widget.size,
            height: widget.size,
            child: Stack(
              alignment: Alignment.center,
              children: [
                // Success ring pulse — expands once, fades out.
                if (widget.state == RabBiometricVisualState.success)
                  Container(
                    width: widget.size * (1 + _pulse.value * 0.5),
                    height: widget.size * (1 + _pulse.value * 0.5),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: colors.accent.withValues(
                          alpha: (1 - _pulse.value).clamp(0.0, 1.0),
                        ),
                        width: 2,
                      ),
                    ),
                  ),
                Container(
                  width: widget.size,
                  height: widget.size,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: colors.onDarkPrimary.withValues(alpha: 0.08),
                  ),
                ),
                Container(
                  width: widget.size * 0.78,
                  height: widget.size * 0.78,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: colors.onDarkPrimary.withValues(alpha: 0.35),
                      width: 1.5,
                    ),
                  ),
                ),
                ClipOval(
                  child: SizedBox(
                    width: widget.size * 0.78,
                    height: widget.size * 0.78,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        if (widget.state == RabBiometricVisualState.scanning)
                          Align(
                            alignment: Alignment(0, -1 + _sweep.value * 2),
                            child: Container(
                              height: 2,
                              width: widget.size * 0.78,
                              decoration: BoxDecoration(
                                gradient: LinearGradient(
                                  colors: [
                                    colors.ringProgress.withValues(alpha: 0),
                                    colors.ringProgress,
                                    colors.ringProgress.withValues(alpha: 0),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        Icon(
                          widget.state == RabBiometricVisualState.success
                              ? Icons.check_rounded
                              : widget.icon,
                          size: widget.size * 0.32,
                          color: widget.state == RabBiometricVisualState.success
                              ? colors.accent
                              : colors.onDarkPrimary,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

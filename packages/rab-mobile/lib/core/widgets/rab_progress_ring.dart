import 'package:flutter/material.dart';

/// The Clock In/Out circular progress hero — a thin dark translucent track
/// with a light desaturated-sage progress arc and a small luminous end-cap,
/// per spec §41. [progress] is worked/scheduled duration, clamped 0..1
/// (never invented — the caller derives it from real `clockInAt` and the
/// shift's real `startsAt`/`endsAt`, or passes 0 pre-clock-in).
class RabProgressRing extends StatelessWidget {
  const RabProgressRing({
    super.key,
    required this.progress,
    required this.trackColor,
    required this.progressColor,
    this.size = 240,
    this.strokeWidth = 6,
    required this.child,
  });

  final double progress;
  final Color trackColor;
  final Color progressColor;
  final double size;
  final double strokeWidth;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          CustomPaint(
            size: Size(size, size),
            painter: _RingPainter(
              progress: progress.clamp(0.0, 1.0),
              trackColor: trackColor,
              progressColor: progressColor,
              strokeWidth: strokeWidth,
            ),
          ),
          child,
        ],
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({
    required this.progress,
    required this.trackColor,
    required this.progressColor,
    required this.strokeWidth,
  });

  final double progress;
  final Color trackColor;
  final Color progressColor;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = (size.shortestSide - strokeWidth) / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);

    final track = Paint()
      ..color = trackColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(rect, 0, 6.2832, false, track);

    if (progress > 0) {
      final arc = Paint()
        ..color = progressColor
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round;
      const start = -1.5708; // 12 o'clock
      canvas.drawArc(rect, start, 6.2832 * progress, false, arc);

      final endAngle = start + 6.2832 * progress;
      final dot = Offset(
        center.dx + radius * _cos(endAngle),
        center.dy + radius * _sin(endAngle),
      );
      canvas.drawCircle(dot, strokeWidth * 0.9, Paint()..color = progressColor);
    }
  }

  double _cos(double radians) => Offset.fromDirection(radians).dx;
  double _sin(double radians) => Offset.fromDirection(radians).dy;

  @override
  bool shouldRepaint(covariant _RingPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.trackColor != trackColor ||
      oldDelegate.progressColor != progressColor;
}

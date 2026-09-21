import 'package:flutter/material.dart';

/// Stand-in for real venue photography — the data model carries no venue
/// image anywhere yet (`OfferSummary`/`AttendanceSummary` have no image
/// field), so per the "no random stock photos at runtime" rule this paints
/// a tasteful, theme-adaptive abstraction (warm pendant-light glow over a
/// soft horizon, evoking a bar/restaurant interior) rather than faking a
/// photo pipeline. Swap this widget's body for a real `Image.network` once
/// the backend actually returns a venue image URL — every call site already
/// takes a plain `Widget`-shaped slot, so no call site would need to change.
class RabVenueMotif extends StatelessWidget {
  const RabVenueMotif({super.key, required this.baseColor, this.borderRadius = const BorderRadius.all(Radius.circular(28))});

  final Color baseColor;
  final BorderRadius borderRadius;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: borderRadius,
      child: CustomPaint(
        painter: _VenueMotifPainter(baseColor: baseColor),
        child: const SizedBox.expand(),
      ),
    );
  }
}

class _VenueMotifPainter extends CustomPainter {
  _VenueMotifPainter({required this.baseColor});

  final Color baseColor;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final base = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [baseColor.withValues(alpha: 0.9), baseColor.withValues(alpha: 0.55)],
      ).createShader(rect);
    canvas.drawRect(rect, base);

    // A soft "pendant light" glow, off-center — the one warm focal point.
    final glowCenter = Offset(size.width * 0.62, size.height * 0.28);
    final glow = Paint()
      ..shader = RadialGradient(
        colors: [const Color(0xFFF3D9A0).withValues(alpha: 0.55), const Color(0xFFF3D9A0).withValues(alpha: 0.0)],
      ).createShader(Rect.fromCircle(center: glowCenter, radius: size.shortestSide * 0.55));
    canvas.drawRect(rect, glow);

    // Two restrained horizontal "shelf" lines toward the base, suggesting a
    // bar counter without drawing anything literal.
    final line = Paint()
      ..color = Colors.black.withValues(alpha: 0.18)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    canvas.drawLine(Offset(0, size.height * 0.74), Offset(size.width, size.height * 0.74), line);
    canvas.drawLine(Offset(0, size.height * 0.82), Offset(size.width, size.height * 0.82), line);
  }

  @override
  bool shouldRepaint(covariant _VenueMotifPainter oldDelegate) => oldDelegate.baseColor != baseColor;
}

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'clock_presentation.dart';

/// Thin `mobile_scanner` wrapper — pops the raw scanned string (the signed
/// QR token) back to the caller, or `null` if the user backs out. Reused
/// identically for Clock In and Clock Out (Part 54: same QR, same scanner —
/// the endpoint called plus current Attendance state decide the action, not
/// this screen). The Shift QR is printed once and never rotates, so there is
/// no need to keep scanning after the first successful read.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key, this.title = 'Scan venue QR'});
  final String title;

  static Route<String?> route({String? title}) => MaterialPageRoute<String?>(
    builder: (_) => QrScanScreen(title: title ?? 'Scan venue QR'),
  );

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen>
    with WidgetsBindingObserver {
  final MobileScannerController _controller = MobileScannerController();
  bool _popped = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // mobile_scanner delegates lifecycle ownership to callers supplying a controller.
    if (_popped || !_controller.value.hasCameraPermission) return;
    unawaited(_reconcileCamera(state));
  }

  Future<void> _reconcileCamera(AppLifecycleState state) async {
    try {
      if (state == AppLifecycleState.resumed && mounted && !_popped) {
        await _controller.start();
      } else {
        await _controller.stop();
      }
    } catch (_) {
      // Controller publishes camera errors to the existing retry surface.
    }
  }

  Future<void> _stopAndDispose() async {
    try {
      await _controller.stop();
    } finally {
      await _controller.dispose();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_stopAndDispose());
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) async {
    if (_popped) return;
    final value = capture.barcodes
        .map((b) => b.rawValue)
        .firstWhere((v) => v != null && v.isNotEmpty, orElse: () => null);
    if (value == null) return;
    _popped = true;
    try {
      await _controller.stop();
    } catch (_) {
      /* disposal still releases the camera */
    }
    if (!mounted) return;
    Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: ScheduleTokens.homeBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const ClockHeader(title: 'Your workspace', scanner: true),
              const SizedBox(height: 12),
              Expanded(
                child: ListView(
                  children: [
                    Text(
                      widget.title,
                      style: ScheduleTokens.heading.copyWith(fontSize: 22),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      "Align the venue’s code inside the frame.",
                      style: ScheduleTokens.label.copyWith(fontSize: 10),
                    ),
                    const SizedBox(height: 18),
                    AspectRatio(
                      aspectRatio: 1.186,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(18),
                        child: ColoredBox(
                          color: ClockPalette.navy,
                          child: Stack(
                            fit: StackFit.expand,
                            children: [
                              MobileScanner(
                                controller: _controller,
                                onDetect: _onDetect,
                                errorBuilder: (context, error) => Center(
                                  child: Padding(
                                    padding: const EdgeInsets.all(24),
                                    child: ScheduleMessageCard(
                                      title: 'Camera unavailable',
                                      message:
                                          'Check camera access in Settings, then try again.',
                                      kind: ScheduleMessageKind.error,
                                      actionLabel: 'Retry',
                                      onAction: () async {
                                        try {
                                          await _controller.start();
                                        } catch (_) {
                                          // The scanner's errorBuilder retains its recovery message.
                                        }
                                      },
                                    ),
                                  ),
                                ),
                              ),
                              const IgnorePointer(
                                child: CustomPaint(painter: _ScanCorners()),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  'Camera preview · scan the QR displayed at your venue.',
                  style: ScheduleTokens.label.copyWith(fontSize: 10),
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: TextButton(
                  style: TextButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: ScheduleTokens.ink,
                    minimumSize: const Size(0, 48),
                  ),
                  onPressed: () => Navigator.maybePop(context),
                  child: const Text('Cancel scan'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ScanCorners extends CustomPainter {
  const _ScanCorners();
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromCenter(
      center: size.center(Offset.zero),
      width: size.width * .39,
      height: size.height * .62,
    );
    final paint = Paint()
      ..color = Colors.white
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    for (final corner in [
      rect.topLeft,
      rect.topRight,
      rect.bottomLeft,
      rect.bottomRight,
    ]) {
      final dx = corner.dx == rect.left ? 1.0 : -1.0;
      final dy = corner.dy == rect.top ? 1.0 : -1.0;
      canvas.drawPath(
        Path()
          ..moveTo(corner.dx + dx * 8, corner.dy)
          ..lineTo(corner.dx, corner.dy)
          ..lineTo(corner.dx, corner.dy + dy * 8),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_ScanCorners oldDelegate) => false;
}

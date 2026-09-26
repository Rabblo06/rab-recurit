import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';

/// Thin `mobile_scanner` wrapper — pops the raw scanned string (the signed
/// QR token) back to the caller, or `null` if the user backs out. Reused
/// identically for Clock In and Clock Out (Part 54: same QR, same scanner —
/// the endpoint called plus current Attendance state decide the action, not
/// this screen). The Shift QR is printed once and never rotates, so there is
/// no need to keep scanning after the first successful read.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key, this.title = 'Scan the shift QR code'});
  final String title;

  static Route<String?> route({String? title}) => MaterialPageRoute<String?>(
    builder: (_) => QrScanScreen(title: title ?? 'Scan the shift QR code'),
  );

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final MobileScannerController _controller = MobileScannerController();
  bool _popped = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_popped) return;
    final value = capture.barcodes
        .map((b) => b.rawValue)
        .firstWhere((v) => v != null && v.isNotEmpty, orElse: () => null);
    if (value == null) return;
    _popped = true;
    Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(widget.title),
      ),
      body: Stack(
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
                  message: 'Check camera access in Settings, then try again.',
                  kind: ScheduleMessageKind.warning,
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
          IgnorePointer(
            child: Center(
              child: Container(
                width: 240,
                height: 240,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.white, width: 2),
                  borderRadius: BorderRadius.circular(20),
                ),
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 48,
            child: Text(
              'Point your camera at the shift QR code',
              textAlign: TextAlign.center,
              style: ScheduleTokens.label.copyWith(
                color: Colors.white,
                fontSize: 13,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

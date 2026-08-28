import 'dart:async';

import 'package:flutter/material.dart';

/// Display-only — ticks once a second purely to repaint the on-screen
/// elapsed time between [clockInAt] (a server timestamp) and the device's
/// own clock. This is never the source of truth for worked time: the
/// backend recomputes the real, billed `workedMinutes` from its own
/// `clockInAt`/`clockOutAt` at the moment of clock-out, regardless of what
/// this widget displayed along the way.
class LiveTimerText extends StatefulWidget {
  const LiveTimerText({super.key, required this.clockInAt, this.style});

  final DateTime clockInAt;
  final TextStyle? style;

  @override
  State<LiveTimerText> createState() => _LiveTimerTextState();
}

class _LiveTimerTextState extends State<LiveTimerText> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final elapsed = DateTime.now().toUtc().difference(widget.clockInAt.toUtc());
    final clamped = elapsed.isNegative ? Duration.zero : elapsed;
    final h = clamped.inHours.toString().padLeft(2, '0');
    final m = (clamped.inMinutes % 60).toString().padLeft(2, '0');
    final s = (clamped.inSeconds % 60).toString().padLeft(2, '0');
    return Text('$h:$m:$s', style: widget.style);
  }
}

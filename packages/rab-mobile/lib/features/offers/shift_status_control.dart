import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import 'offers_provider.dart';

/// Only this subtree ticks; elapsed time is anchored to the server plus a
/// monotonic stopwatch. Lifecycle labels come from the server projection.
class ShiftStatusControl extends StatefulWidget {
  const ShiftStatusControl({
    super.key,
    required this.offer,
    required this.style,
    required this.fallback,
    this.reconciling = false,
  });
  final OfferSummary offer;
  final ShiftVisualStyle style;
  final String fallback;
  final bool reconciling;
  @override
  State<ShiftStatusControl> createState() => _ShiftStatusControlState();
}

class _ShiftStatusControlState extends State<ShiftStatusControl>
    with WidgetsBindingObserver {
  Timer? _tick;
  DateTime? _requestedBoundary;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Phase C1: no periodic `/offers/mine` poll here any more — AppShell's
    // reconcile already polls it every 30 s. This tick only re-renders the
    // live elapsed time and reloads once when the server's own next
    // transition time is reached.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || !TickerMode.of(context)) return;
      final provider = context.read<OffersProvider>();
      final boundary = widget.offer.presentation?.nextTransitionAt;
      final now = provider.trustedNow;
      if (boundary != null &&
          now != null &&
          !now.isBefore(boundary) &&
          _requestedBoundary != boundary) {
        _requestedBoundary = boundary;
        // Timer-driven: background traffic (never slides the idle window).
        provider.load(silent: true, background: true);
      }
      if (widget.offer.presentation?.state == 'live') setState(() {});
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Shares AppShell's resume reload when both fire for the same resume.
    if (state == AppLifecycleState.resumed) {
      context.read<OffersProvider>().load(silent: true, joinInFlight: true);
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<OffersProvider>();
    final p = widget.offer.presentation;
    var label = p?.label ?? widget.fallback;
    if (!widget.reconciling && p?.state == 'live' && p?.clockInAt != null) {
      final now = provider.trustedNow ?? p!.serverNow;
      final seconds = now
          .difference(p!.clockInAt!)
          .inSeconds
          .clamp(0, 999999999);
      label =
          '${(seconds ~/ 3600).toString().padLeft(2, '0')}:${(seconds ~/ 60 % 60).toString().padLeft(2, '0')}:${(seconds % 60).toString().padLeft(2, '0')}';
    }
    if (widget.reconciling) label = 'Updating status';
    final icon = switch (p?.state) {
      'live' || 'pending' => Icons.schedule,
      'clockedOut' => Icons.logout,
      'complete' => Icons.check_circle_outline,
      'expired' || 'ended' => Icons.history,
      _ => Icons.work_outline,
    };
    return Semantics(
      label:
          '${p?.state == 'live' ? 'Live elapsed time' : 'Shift status'}: $label',
      child: Container(
        key: const ValueKey('shift-status-control'),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: widget.style.chipSurface,
          border: Border.all(color: widget.style.surfaceBorder),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16),
            const SizedBox(width: 6),
            Text(
              label,
              style: ScheduleTokens.body.copyWith(
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (provider.loadError != null)
              const Tooltip(
                message: 'Last known status. Reconnect to refresh.',
                child: Icon(Icons.cloud_off, size: 16),
              ),
          ],
        ),
      ),
    );
  }
}

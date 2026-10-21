import 'dart:async';
import 'dart:collection';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../motion/shift_motion.dart';
import '../theme/schedule_tokens.dart';
import 'schedule_feedback.dart';

/// Temporary feedback for an action's result ("Review saved.", "The PDF could
/// not be saved."). Persistent states — a screen that cannot load, inline
/// field validation, confirmations — stay in [ScheduleMessageCard] / sheets.
///
/// Shown on the ROOT overlay, top-aligned inside the safe area, so it sits
/// above the current route (and any sheet) and never covers bottom primary
/// actions such as Clock In/Out. At most [maxVisible] are on screen; the rest
/// queue. An identical message + kind that is already showing or queued is
/// ignored. Every timer and animation belongs to a widget State and is
/// disposed with it, so nothing outlives the overlay.
abstract final class ScheduleToast {
  static const maxVisible = 3;
  static const shortDuration = Duration(milliseconds: 4500);
  static const longDuration = Duration(seconds: 7);
  static const appearDuration = Duration(milliseconds: 200);
  static const exitDuration = Duration(milliseconds: 160);

  static Duration durationFor(ScheduleMessageKind kind) => switch (kind) {
    ScheduleMessageKind.warning || ScheduleMessageKind.error => longDuration,
    _ => shortDuration,
  };

  static final Expando<_ToastController> _controllers = Expando();

  /// Returns false when nothing was shown (unmounted context, no overlay,
  /// empty text, or a duplicate of a toast already on screen / queued).
  static bool show(
    BuildContext context,
    String message, {
    ScheduleMessageKind kind = ScheduleMessageKind.info,
    Duration? duration,
    String? title,
  }) {
    if (!context.mounted) return false;
    final overlay = overlayOf(context);
    if (overlay == null) return false;
    return showOn(
      overlay,
      message,
      kind: kind,
      duration: duration,
      title: title,
    );
  }

  /// The root overlay toasts are drawn on. Capture it before an `await` when
  /// the calling widget may be gone by the time the result arrives (a card
  /// removed by its own action, a screen closed during a share sheet).
  static OverlayState? overlayOf(BuildContext context) =>
      Navigator.maybeOf(context, rootNavigator: true)?.overlay ??
      Overlay.maybeOf(context, rootOverlay: true);

  /// [show] on an overlay captured with [overlayOf].
  static bool showOn(
    OverlayState overlay,
    String message, {
    ScheduleMessageKind kind = ScheduleMessageKind.info,
    Duration? duration,
    String? title,
  }) {
    final text = message.trim();
    if (!overlay.mounted || text.isEmpty) return false;
    final controller = _controllers[overlay] ??= _ToastController(overlay, () {
      _controllers[overlay] = null;
    });
    return controller.add(
      _ToastData(
        text,
        kind,
        duration ?? durationFor(kind),
        title: title?.trim().isEmpty == true ? null : title?.trim(),
      ),
    );
  }

  /// Error toast for a caught failure, through the single API normaliser.
  static bool showError(
    BuildContext context,
    Object error, {
    String? fallback,
  }) => show(
    context,
    userMessageFor(error, fallback: fallback),
    kind: ScheduleMessageKind.error,
  );

  /// Removes every toast (visible and queued) from [context]'s root overlay.
  static void dismissAll(BuildContext context) {
    final overlay = overlayOf(context);
    if (overlay != null) _controllers[overlay]?.clear();
  }
}

class _ToastData {
  _ToastData(this.message, this.kind, this.duration, {this.title});
  final String message;
  final String? title;
  final ScheduleMessageKind kind;
  final Duration duration;
  bool leaving = false;
  bool sameAs(_ToastData other) =>
      !leaving &&
      message == other.message &&
      title == other.title &&
      kind == other.kind;
}

class _ToastController extends ChangeNotifier {
  _ToastController(this.overlay, this._onDetached);
  final OverlayState overlay;
  final VoidCallback _onDetached;
  final visible = <_ToastData>[];
  final _queue = Queue<_ToastData>();
  OverlayEntry? _entry;

  bool add(_ToastData data) {
    if (visible.any((t) => t.sameAs(data)) ||
        _queue.any((t) => t.sameAs(data))) {
      return false;
    }
    if (visible.length < ScheduleToast.maxVisible) {
      visible.add(data);
    } else {
      _queue.add(data);
    }
    if (_entry == null) {
      final entry = OverlayEntry(builder: (_) => _ToastHost(controller: this));
      _entry = entry;
      overlay.insert(entry);
    }
    notifyListeners();
    return true;
  }

  void remove(_ToastData data) {
    if (!visible.remove(data)) return;
    if (_queue.isNotEmpty) visible.add(_queue.removeFirst());
    if (visible.isEmpty) _removeEntry();
    notifyListeners();
  }

  void clear() {
    visible.clear();
    _queue.clear();
    _removeEntry();
    notifyListeners();
  }

  void _removeEntry() {
    final entry = _entry;
    if (entry == null) return;
    // Cleared first, so the host's dispose (triggered by this removal) is not
    // mistaken for the overlay being torn down.
    _entry = null;
    entry
      ..remove()
      ..dispose();
  }

  /// The host left the tree without [_removeEntry]: the overlay itself was
  /// disposed (route stack torn down). Forget everything; the next show on a
  /// new overlay starts a fresh controller.
  void hostDisposed() {
    if (_entry == null) return;
    _entry = null;
    visible.clear();
    _queue.clear();
    _onDetached();
  }
}

class _ToastHost extends StatefulWidget {
  const _ToastHost({required this.controller});
  final _ToastController controller;
  @override
  State<_ToastHost> createState() => _ToastHostState();
}

class _ToastHostState extends State<_ToastHost> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.controller
      ..removeListener(_changed)
      ..hostDisposed();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Positioned(
    top: 0,
    left: 0,
    right: 0,
    child: SafeArea(
      bottom: false,
      minimum: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Center(
          heightFactor: 1,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final toast in widget.controller.visible)
                  _ToastLifecycle(
                    key: ObjectKey(toast),
                    data: toast,
                    onRemoved: () => widget.controller.remove(toast),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// Owns one toast's entrance, remaining-time fill and auto-dismiss. Pressing
/// and holding the card pauses the countdown.
class _ToastLifecycle extends StatefulWidget {
  const _ToastLifecycle({
    super.key,
    required this.data,
    required this.onRemoved,
  });
  final _ToastData data;
  final VoidCallback onRemoved;
  @override
  State<_ToastLifecycle> createState() => _ToastLifecycleState();
}

class _ToastLifecycleState extends State<_ToastLifecycle>
    with TickerProviderStateMixin {
  late final AnimationController _appear = AnimationController(
    vsync: this,
    duration: ScheduleToast.appearDuration,
    reverseDuration: ScheduleToast.exitDuration,
  );
  late final CurvedAnimation _curve = CurvedAnimation(
    parent: _appear,
    curve: Curves.easeOutCubic,
    reverseCurve: Curves.easeInCubic,
  );

  /// Remaining-time driver when animations are allowed.
  AnimationController? _life;

  /// Reduced motion: a plain timer, the fill held still.
  Timer? _timer;
  final Stopwatch _elapsed = Stopwatch();
  bool _started = false;
  bool _reduced = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _reduced = ShiftMotion.reduced(context);
    if (_reduced) {
      _appear.value = 1;
      _resume();
    } else {
      _appear.forward();
      _life = AnimationController(vsync: this, duration: widget.data.duration)
        ..addStatusListener((status) {
          if (status == AnimationStatus.completed) _dismiss();
        })
        ..forward();
    }
  }

  void _pause() {
    if (widget.data.leaving) return;
    if (_reduced) {
      _timer?.cancel();
      _elapsed.stop();
    } else {
      _life?.stop();
    }
  }

  void _resume() {
    if (widget.data.leaving || !mounted) return;
    if (_reduced) {
      _timer?.cancel();
      final left = widget.data.duration - _elapsed.elapsed;
      _elapsed.start();
      _timer = Timer(left.isNegative ? Duration.zero : left, _dismiss);
    } else if (_life != null && !_life!.isAnimating) {
      _life!.forward();
    }
  }

  void _dismiss() {
    if (widget.data.leaving || !mounted) return;
    widget.data.leaving = true;
    _timer?.cancel();
    _life?.stop();
    if (_reduced) {
      widget.onRemoved();
      return;
    }
    _appear.reverse().whenCompleteOrCancel(() {
      if (mounted) widget.onRemoved();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _life?.dispose();
    _curve.dispose();
    _appear.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final life = _life;
    Widget card(double remaining) => ScheduleToastCard(
      message: widget.data.message,
      title: widget.data.title,
      kind: widget.data.kind,
      remaining: remaining,
      onDismiss: _dismiss,
    );
    Widget child = Listener(
      onPointerDown: (_) => _pause(),
      onPointerUp: (_) => _resume(),
      onPointerCancel: (_) => _resume(),
      child: life == null
          ? card(1)
          : AnimatedBuilder(
              animation: life,
              builder: (_, _) => card(1 - life.value),
            ),
    );
    child = Padding(padding: const EdgeInsets.only(bottom: 8), child: child);
    if (_reduced) return child;
    return SizeTransition(
      sizeFactor: _curve,
      axisAlignment: -1,
      child: FadeTransition(
        opacity: _curve,
        child: SlideTransition(
          position: Tween(
            begin: const Offset(0, -.25),
            end: Offset.zero,
          ).animate(_curve),
          child: child,
        ),
      ),
    );
  }
}

/// The toast surface itself (also used directly by the visual test).
/// [remaining] (0–1) is the share of display time left, drawn as a light
/// semantic fill from the start edge.
class ScheduleToastCard extends StatelessWidget {
  const ScheduleToastCard({
    super.key,
    required this.message,
    required this.kind,
    this.title,
    this.remaining = 1,
    this.onDismiss,
  });
  final String message;

  /// Optional bold first line ("Attendance reviewed").
  final String? title;
  final ScheduleMessageKind kind;
  final double remaining;
  final VoidCallback? onDismiss;

  static (Color fill, IconData icon, Color iconColor, Color text, String label)
  styleFor(ScheduleMessageKind kind) => switch (kind) {
    ScheduleMessageKind.error => (
      ScheduleTokens.toastErrorFill,
      Icons.error_outline_rounded,
      ScheduleTokens.errorText,
      ScheduleTokens.errorText,
      'Error',
    ),
    ScheduleMessageKind.success => (
      ScheduleTokens.toastSuccessFill,
      Icons.check_circle_outline_rounded,
      ScheduleTokens.successIcon,
      ScheduleTokens.successText,
      'Success',
    ),
    ScheduleMessageKind.warning => (
      ScheduleTokens.toastWarningFill,
      Icons.warning_amber_rounded,
      ScheduleTokens.warningIcon,
      ScheduleTokens.warningText,
      'Warning',
    ),
    ScheduleMessageKind.info => (
      ScheduleTokens.toastInfoFill,
      Icons.info_outline_rounded,
      ScheduleTokens.infoIcon,
      ScheduleTokens.ink,
      'Information',
    ),
  };

  @override
  Widget build(BuildContext context) {
    final (fill, icon, iconColor, textColor, label) = styleFor(kind);
    final radius = BorderRadius.circular(ScheduleTokens.toastRadius);
    return Semantics(
      key: ValueKey('schedule-toast-${kind.name}'),
      container: true,
      liveRegion: true,
      child: Material(
        type: MaterialType.transparency,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: ScheduleTokens.surface,
            borderRadius: radius,
            border: Border.all(color: ScheduleTokens.toastBorder),
            boxShadow: ScheduleTokens.toastShadows,
          ),
          child: ClipRRect(
            borderRadius: radius,
            child: Stack(
              children: [
                Positioned.fill(
                  child: FractionallySizedBox(
                    alignment: AlignmentDirectional.centerStart,
                    widthFactor: remaining.clamp(0.0, 1.0),
                    child: ColoredBox(color: fill),
                  ),
                ),
                Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(14, 0, 0, 0),
                  child: Row(
                    children: [
                      Icon(
                        icon,
                        size: 22,
                        color: iconColor,
                        semanticLabel: label,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 13),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (title != null)
                                Text(
                                  title!,
                                  style: ScheduleType.bodyStrong.copyWith(
                                    fontSize: 14.5,
                                  ),
                                ),
                              Text(
                                message,
                                style: ScheduleType.body.copyWith(
                                  fontSize: title == null ? 14.5 : 14,
                                  fontWeight: title == null
                                      ? FontWeight.w500
                                      : FontWeight.w400,
                                  // Owner reference: neutral dark text; the
                                  // icon and fill carry the semantic colour.
                                  color: title == null
                                      ? ScheduleTokens.ink
                                      : ScheduleTokens.muted,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      IconButton(
                        key: const ValueKey('schedule-toast-dismiss'),
                        onPressed: onDismiss,
                        tooltip: 'Dismiss',
                        constraints: const BoxConstraints.tightFor(
                          width: ScheduleTokens.touchTarget,
                          height: ScheduleTokens.touchTarget,
                        ),
                        padding: EdgeInsets.zero,
                        icon: const Icon(
                          Icons.close_rounded,
                          size: 18,
                          color: ScheduleTokens.muted,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

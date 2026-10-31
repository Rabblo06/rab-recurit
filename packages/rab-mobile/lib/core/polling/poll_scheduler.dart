import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../api/api_client.dart';
import 'single_flight.dart';

/// Why a poll task is running. Only [timer] is background traffic: it is the one trigger that must send
/// `X-Crewflow-Background: 1` (see [PollTriggerX.isBackground]). Coming back to the app or to a screen is the user's
/// own activity, exactly like iOS (`reconcile(background: false)` on resume).
enum PollTrigger { timer, resume, visible, manual }

/// While the realtime stream is live (Phase C1b), the polls it covers (Sent
/// Shifts first page, notifications, staff reconcile) fall back to this
/// slower safety-net interval; they revert to their own when it drops.
const realtimeFallbackPollInterval = Duration(seconds: 120);

extension PollTriggerX on PollTrigger {
  bool get isBackground => this == PollTrigger.timer;
}

/// The Phase C1 client polling policy, once, for every Flutter timer:
///
/// - the interval gets ±[jitter] (default 20 %) so phones sharing one venue Wi-Fi do not poll in lockstep;
/// - at most one run in flight ([SingleFlight]); the next delay starts after a run ends, so runs never overlap;
/// - runs only while the app is in the foreground (`AppLifecycleState`) AND the owner says the screen is visible
///   ([visible]); a hidden screen or a backgrounded app has no timer at all;
/// - one immediate run on returning to the foreground ([refreshOnResume]) or on becoming visible again;
/// - HTTP 429: waits the server's `Retry-After` (default [defaultRetryAfter]) plus up to +[jitter], never less;
/// - any other failure: exponential backoff (×2 per consecutive failure, capped at [maxBackoff]), jittered, reset
///   by the first success;
/// - [identity] (e.g. `ApiClient.sessionGeneration`): when it changes (logout / account switch) the scheduler stops
///   for good and never runs the task again under the new identity.
///
/// The task throws on failure; it is responsible for keeping its last good data on screen.
class PollScheduler with WidgetsBindingObserver {
  PollScheduler({
    required Duration interval,
    required Future<void> Function(PollTrigger trigger) task,
    this.jitter = 0.2,
    this.maxBackoff = const Duration(minutes: 5),
    this.defaultRetryAfter = const Duration(seconds: 30),
    this.refreshOnResume = true,
    this.identity,
    this.onError,
    this.onSuccess,
    Random? random,
    bool visible = true,
  }) : _interval = interval,
       _task = task,
       _random = random ?? Random(),
       _visible = visible;

  Duration _interval;
  Duration get interval => _interval;
  final double jitter;
  final Duration maxBackoff;
  final Duration defaultRetryAfter;

  /// False when the owner already does its own (larger) refresh on resume, so this scheduler only re-arms its timer.
  final bool refreshOnResume;
  final Object? Function()? identity;
  final void Function(Object error)? onError;
  final VoidCallback? onSuccess;

  final Future<void> Function(PollTrigger trigger) _task;
  final Random _random;
  final SingleFlight _flight = SingleFlight();
  Timer? _timer;
  bool _started = false;
  bool _stopped = false;
  bool _visible;
  bool _foreground = true;
  Object? _identity;
  int _failures = 0;
  Duration? _retryAfter;

  /// Consecutive failures since the last success (0 = healthy).
  int get failures => _failures;
  bool get isScheduled => _timer?.isActive ?? false;
  bool get isRunning => _flight.isRunning;

  /// The delay the next timer will use (exposed for tests and diagnostics).
  Duration? lastDelay;

  /// Arms the timer. Does not run the task: owners load their first data themselves.
  void start() {
    if (_started || _stopped) return;
    _started = true;
    _identity = identity?.call();
    final state = WidgetsBinding.instance.lifecycleState;
    _foreground = state == null || _isForeground(state);
    WidgetsBinding.instance.addObserver(this);
    _schedule();
  }

  /// The owner's own visibility (route current, tab selected, TickerMode). Becoming visible runs once immediately.
  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
    if (!_started || _stopped) return;
    if (!visible) {
      _cancel();
    } else if (_foreground) {
      unawaited(_run(PollTrigger.visible));
    }
  }

  /// Runs the task now (queued behind an in-flight run, never dropped) and restarts the interval from its end.
  Future<void> refreshNow() => _run(PollTrigger.manual, queue: true);

  /// Changes the interval (e.g. realtime live → [realtimeFallbackPollInterval],
  /// dropped → back). An armed timer restarts from now with the new interval.
  void setInterval(Duration interval) {
    if (_interval == interval) return;
    _interval = interval;
    if (isScheduled) _schedule();
  }

  /// Restarts the interval from now without running anything (after the owner refreshed by other means).
  void restartInterval() {
    if (_started && !_stopped && !_flight.isRunning) _schedule();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_stopped) return;
    final foreground = _isForeground(state);
    if (foreground == _foreground) return;
    _foreground = foreground;
    if (!foreground) {
      _cancel();
    } else if (_visible) {
      if (refreshOnResume) {
        unawaited(_run(PollTrigger.resume));
      } else {
        _schedule();
      }
    }
  }

  /// `inactive` (notification shade, permission dialog) is still the foreground; only hidden/paused/detached stop.
  static bool _isForeground(AppLifecycleState state) =>
      state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;

  bool get _active => _started && !_stopped && _foreground && _visible;

  bool _identityChanged() {
    if (identity == null) return false;
    if (identity!() == _identity) return false;
    dispose();
    return true;
  }

  Future<void> _run(PollTrigger trigger, {bool queue = false}) {
    _cancel();
    if (_stopped || _identityChanged()) return Future.value();
    Future<void> body() async {
      if (_stopped || _identityChanged()) return;
      try {
        await _task(trigger);
        if (_stopped || _identityChanged()) return;
        _failures = 0;
        _retryAfter = null;
        onSuccess?.call();
      } catch (error) {
        if (_stopped || _identityChanged()) return;
        if (error is ApiException && error.statusCode == 429) {
          final wait = error.retryAfter ?? defaultRetryAfter;
          // Never an immediate retry, whatever the header said.
          _retryAfter = wait < minRetryAfter ? minRetryAfter : wait;
        } else {
          // An ordinary failure: back off from here; an older Retry-After no longer applies.
          _retryAfter = null;
          _failures++;
        }
        onError?.call(error);
      }
    }

    final future = queue ? _flight.run(body) : _flight.join(body);
    return future.whenComplete(() {
      if (!_flight.isRunning) _schedule();
    });
  }

  void _onTimer() {
    _timer = null;
    if (!_active) return;
    unawaited(_run(PollTrigger.timer));
  }

  void _schedule() {
    _cancel();
    if (!_active) return;
    final delay = _nextDelay();
    lastDelay = delay;
    _timer = Timer(delay, _onTimer);
  }

  Duration _nextDelay() {
    final retryAfter = _retryAfter;
    if (retryAfter != null) {
      // Never earlier than the server asked; the extra jitter spreads the recovery so phones do not return together.
      return retryAfter + _scale(retryAfter, _random.nextDouble() * jitter);
    }
    var base = interval;
    if (_failures > 0) {
      final factor = 1 << min(_failures, 20);
      final backedOff = interval * factor;
      base = backedOff > maxBackoff ? maxBackoff : backedOff;
      if (base < interval) base = interval;
    }
    return base + _scale(base, (_random.nextDouble() * 2 - 1) * jitter);
  }

  static Duration _scale(Duration d, double factor) =>
      Duration(microseconds: (d.inMicroseconds * factor).round());

  void _cancel() {
    _timer?.cancel();
    _timer = null;
  }

  /// Stops for good (owner disposed, or identity changed). In-flight results are ignored by the owner's own fencing.
  void dispose() {
    if (_stopped) return;
    _stopped = true;
    _cancel();
    if (_started) WidgetsBinding.instance.removeObserver(this);
  }
}

import 'dart:async';

/// At most one run of an async task at a time (Phase C1 polling policy).
///
/// - [run]: a call while a run is in flight is **queued**, never dropped: exactly one follow-up starts after the
///   current run, and every caller queued meanwhile shares it. Use it for user actions (a reload after the user's own
///   check-in must fetch AFTER the check-in, not reuse a read that started before it).
/// - [join]: a call while a run is in flight (or queued) shares that run instead of starting another. Use it for
///   automatic refreshes (timer, app resume) where any fresh-enough answer will do.
///
/// A queued follow-up runs the task passed by the LAST queued caller, so callers that merge flags (silent/background)
/// should read them from their own fields when the task starts.
class SingleFlight {
  Future<void>? _inFlight;
  Future<void>? _queued;
  Future<void> Function()? _next;

  bool get isRunning => _inFlight != null || _queued != null;

  Future<void> run(Future<void> Function() task) {
    if (_inFlight == null && _queued == null) return _start(task);
    _next = task;
    return _queued ??= _inFlight!
        .then<void>((_) {}, onError: (Object _) {})
        .then((_) {
          final next = _next!;
          _next = null;
          _queued = null;
          return _start(next);
        });
  }

  Future<void> join(Future<void> Function() task) =>
      _queued ?? _inFlight ?? _start(task);

  Future<void> _start(Future<void> Function() task) {
    late final Future<void> current;
    current = Future<void>.sync(task).whenComplete(() {
      if (identical(_inFlight, current)) _inFlight = null;
    });
    _inFlight = current;
    return current;
  }
}

import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/polling/poll_scheduler.dart';
import 'package:rab_staff/core/polling/single_flight.dart';

/// Phase C1 shared polling policy (Flutter): fake time via `tester.pump`.
class _FixedRandom implements Random {
  _FixedRandom(this.value);
  double value;
  @override
  double nextDouble() => value;
  @override
  int nextInt(int max) => 0;
  @override
  bool nextBool() => false;
}

void main() {
  const interval = Duration(seconds: 30);
  final runs = <PollTrigger>[];
  Completer<void>? gate;
  Object? failWith;

  Future<void> task(PollTrigger trigger) async {
    runs.add(trigger);
    if (gate != null) await gate!.future;
    final error = failWith;
    if (error != null) throw error;
  }

  PollScheduler scheduler({
    double random = .5,
    bool refreshOnResume = true,
    Object? Function()? identity,
  }) => PollScheduler(
    interval: interval,
    task: task,
    random: _FixedRandom(random),
    refreshOnResume: refreshOnResume,
    identity: identity,
  );

  setUp(() {
    runs.clear();
    gate = null;
    failWith = null;
  });

  void lifecycle(WidgetTester tester, AppLifecycleState state) =>
      tester.binding.handleAppLifecycleStateChanged(state);

  testWidgets('interval stays within ±20 % jitter', (tester) async {
    for (final (random, expected) in [
      (0.0, const Duration(seconds: 24)),
      (.5, const Duration(seconds: 30)),
      (.999999, const Duration(seconds: 36)),
    ]) {
      runs.clear();
      final poll = scheduler(random: random)..start();
      expect(
        poll.lastDelay!.inMilliseconds,
        closeTo(expected.inMilliseconds, 1),
      );
      await tester.pump(poll.lastDelay! - const Duration(milliseconds: 1));
      expect(runs, isEmpty);
      await tester.pump(const Duration(milliseconds: 2));
      expect(runs, [PollTrigger.timer]);
      poll.dispose();
    }
  });

  testWidgets('real Random never leaves the jitter window', (tester) async {
    for (var i = 0; i < 200; i++) {
      final poll = PollScheduler(
        interval: interval,
        task: task,
        random: Random(i),
      )..start();
      expect(poll.lastDelay!, greaterThanOrEqualTo(interval * .8));
      expect(poll.lastDelay!, lessThanOrEqualTo(interval * 1.2));
      poll.dispose();
    }
  });

  testWidgets('timer runs are background; resume/visible/manual are not', (
    tester,
  ) async {
    expect(PollTrigger.timer.isBackground, isTrue);
    expect(PollTrigger.resume.isBackground, isFalse);
    expect(PollTrigger.visible.isBackground, isFalse);
    expect(PollTrigger.manual.isBackground, isFalse);
  });

  testWidgets('no overlap: the next delay starts after a slow run ends', (
    tester,
  ) async {
    final poll = scheduler()..start();
    gate = Completer<void>();
    await tester.pump(interval);
    expect(runs, [PollTrigger.timer]);
    // The run hangs for five intervals: nothing else starts meanwhile.
    await tester.pump(interval * 5);
    expect(runs, hasLength(1));
    expect(poll.isScheduled, isFalse);
    gate!.complete();
    gate = null;
    await tester.pump();
    expect(poll.isScheduled, isTrue);
    await tester.pump(interval);
    expect(runs, hasLength(2));
    poll.dispose();
  });

  testWidgets('a manual refresh during a run is queued, never dropped', (
    tester,
  ) async {
    final poll = scheduler()..start();
    gate = Completer<void>();
    await tester.pump(interval);
    var manualDone = false;
    unawaited(poll.refreshNow().then((_) => manualDone = true));
    await tester.pump();
    expect(runs, [PollTrigger.timer]);
    gate!.complete();
    gate = null;
    await tester.pump();
    expect(runs, [PollTrigger.timer, PollTrigger.manual]);
    expect(manualDone, isTrue);
    poll.dispose();
  });

  testWidgets('backgrounded: no timer at all; resume refreshes once', (
    tester,
  ) async {
    final poll = scheduler()..start();
    lifecycle(tester, AppLifecycleState.inactive);
    lifecycle(tester, AppLifecycleState.hidden);
    lifecycle(tester, AppLifecycleState.paused);
    expect(poll.isScheduled, isFalse);
    await tester.pump(const Duration(minutes: 10));
    expect(runs, isEmpty);
    lifecycle(tester, AppLifecycleState.hidden);
    lifecycle(tester, AppLifecycleState.inactive);
    lifecycle(tester, AppLifecycleState.resumed);
    await tester.pump();
    expect(runs, [PollTrigger.resume]);
    expect(poll.isScheduled, isTrue);
    await tester.pump(interval);
    expect(runs, [PollTrigger.resume, PollTrigger.timer]);
    poll.dispose();
  });

  testWidgets('inactive alone (notification shade) does not stop polling', (
    tester,
  ) async {
    final poll = scheduler()..start();
    lifecycle(tester, AppLifecycleState.inactive);
    await tester.pump(interval);
    expect(runs, [PollTrigger.timer]);
    lifecycle(tester, AppLifecycleState.resumed);
    await tester.pump();
    expect(runs, [PollTrigger.timer], reason: 'no extra resume refresh');
    poll.dispose();
  });

  testWidgets('refreshOnResume false only re-arms the timer', (tester) async {
    final poll = scheduler(refreshOnResume: false)..start();
    lifecycle(tester, AppLifecycleState.paused);
    lifecycle(tester, AppLifecycleState.resumed);
    await tester.pump();
    expect(runs, isEmpty);
    expect(poll.isScheduled, isTrue);
    poll.dispose();
  });

  testWidgets('hidden screen: no timer; visible again refreshes once', (
    tester,
  ) async {
    final poll = scheduler()..start();
    poll.setVisible(false);
    await tester.pump(const Duration(minutes: 10));
    expect(runs, isEmpty);
    poll.setVisible(true);
    await tester.pump();
    expect(runs, [PollTrigger.visible]);
    // Resuming the app while hidden does not poll either.
    poll.setVisible(false);
    lifecycle(tester, AppLifecycleState.paused);
    lifecycle(tester, AppLifecycleState.resumed);
    await tester.pump(const Duration(minutes: 2));
    expect(runs, [PollTrigger.visible]);
    poll.dispose();
  });

  testWidgets('429 waits Retry-After (never less), then recovers', (
    tester,
  ) async {
    final poll = scheduler(random: 0)..start();
    failWith = ApiException(
      429,
      'Too many requests.',
      retryAfterSeconds: 90,
      retryAfter: const Duration(seconds: 90),
    );
    await tester.pump(interval * .8);
    expect(runs, hasLength(1));
    failWith = null;
    await tester.pump(const Duration(seconds: 89));
    expect(runs, hasLength(1), reason: 'still inside Retry-After');
    await tester.pump(const Duration(seconds: 2));
    expect(runs, hasLength(2));
    // Healthy again: back to the normal interval.
    expect(poll.lastDelay, interval * .8);
    poll.dispose();
  });

  testWidgets(
    'a later non-429 failure backs off; the old Retry-After is gone',
    (tester) async {
      final poll = scheduler(random: 0)..start();
      failWith = ApiException(
        429,
        'Too many requests.',
        retryAfterSeconds: 90,
        retryAfter: const Duration(seconds: 90),
      );
      await tester.pump(interval * .8);
      expect(runs, hasLength(1));
      failWith = ApiException(503, 'Unavailable.');
      await tester.pump(const Duration(seconds: 91));
      expect(runs, hasLength(2));
      // One ordinary failure: interval ×2 (jitter factor .8), not 90 s again.
      expect(poll.lastDelay, interval * 2 * .8);
      poll.dispose();
    },
  );

  testWidgets('429 without Retry-After waits the 30 s default plus jitter', (
    tester,
  ) async {
    final poll = scheduler(random: .999999)..start();
    failWith = ApiException(429, 'Too many requests.', retryAfterSeconds: 60);
    await tester.pump(interval * 1.2);
    expect(runs, hasLength(1));
    expect(poll.lastDelay!, greaterThanOrEqualTo(const Duration(seconds: 30)));
    expect(poll.lastDelay!, lessThanOrEqualTo(const Duration(seconds: 36)));
    poll.dispose();
  });

  testWidgets('failures back off ×2 up to 5 min, reset by a success', (
    tester,
  ) async {
    final poll = scheduler()..start();
    failWith = ApiException(503, 'Unavailable');
    final delays = <Duration>[];
    for (var i = 0; i < 6; i++) {
      await tester.pump(poll.lastDelay!);
      delays.add(poll.lastDelay!);
    }
    expect(delays, [
      const Duration(seconds: 60),
      const Duration(seconds: 120),
      const Duration(seconds: 240),
      const Duration(minutes: 5),
      const Duration(minutes: 5),
      const Duration(minutes: 5),
    ]);
    expect(poll.failures, 6);
    failWith = null;
    await tester.pump(poll.lastDelay!);
    expect(poll.failures, 0);
    expect(poll.lastDelay, interval);
    poll.dispose();
  });

  testWidgets('identity change stops the scheduler for good', (tester) async {
    var identity = 1;
    final poll = scheduler(identity: () => identity)..start();
    await tester.pump(interval);
    expect(runs, hasLength(1));
    identity = 2;
    await tester.pump(interval);
    expect(runs, hasLength(1), reason: 'never runs under the new identity');
    expect(poll.isScheduled, isFalse);
    lifecycle(tester, AppLifecycleState.paused);
    lifecycle(tester, AppLifecycleState.resumed);
    poll.setVisible(false);
    poll.setVisible(true);
    await poll.refreshNow();
    await tester.pump(interval * 3);
    expect(runs, hasLength(1));
  });

  testWidgets('setInterval re-arms from now (realtime live → 120 s, back)', (
    tester,
  ) async {
    final poll = scheduler()..start();
    await tester.pump(const Duration(seconds: 20));
    poll.setInterval(realtimeFallbackPollInterval);
    await tester.pump(const Duration(seconds: 119));
    expect(runs, isEmpty);
    await tester.pump(const Duration(seconds: 2));
    expect(runs, [PollTrigger.timer]);
    poll.setInterval(interval);
    await tester.pump(interval);
    expect(runs, hasLength(2));
    poll.dispose();
  });

  testWidgets('dispose cancels the timer', (tester) async {
    final poll = scheduler()..start();
    poll.dispose();
    await tester.pump(interval * 3);
    expect(runs, isEmpty);
  });

  test('SingleFlight: run queues one shared follow-up; join shares', () async {
    final flight = SingleFlight();
    var calls = 0;
    final first = Completer<void>();
    Future<void> slow() async {
      calls++;
      await first.future;
    }

    Future<void> fast() async => calls++;

    final a = flight.run(slow);
    final b = flight.run(fast);
    final c = flight.run(fast);
    final d = flight.join(fast);
    expect(identical(b, c), isTrue);
    expect(identical(c, d), isTrue);
    expect(calls, 1);
    first.complete();
    await Future.wait([a, b, c, d]);
    expect(calls, 2, reason: 'one queued follow-up, shared');
    expect(flight.isRunning, isFalse);
    await flight.join(fast);
    expect(calls, 3);
  });

  testWidgets('F4: a 429 with Retry-After 0 still waits at least 1 s', (
    tester,
  ) async {
    final poll = scheduler(random: 0)..start();
    failWith = ApiException(
      429,
      'Too many requests.',
      retryAfter: Duration.zero,
    );
    await tester.pump(interval * .8);
    expect(runs, hasLength(1));
    failWith = null;
    await tester.pump(const Duration(milliseconds: 999));
    expect(runs, hasLength(1), reason: 'floored at 1 s');
    await tester.pump(const Duration(milliseconds: 2));
    expect(runs, hasLength(2));
    poll.dispose();
  });

  test('F4: Retry-After 0, negative or a past date parses to 1 s', () {
    expect(parseRetryAfter('0'), const Duration(seconds: 1));
    expect(parseRetryAfter('-5'), const Duration(seconds: 1));
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'),
      const Duration(seconds: 1),
    );
    expect(parseRetryAfter('7'), const Duration(seconds: 7));
    expect(parseRetryAfter(null), isNull);
  });
}

import XCTest
@testable import Crewflow

/// The Phase C1 polling policy (`PollScheduler`, `SingleFlight`) against a
/// virtual clock. Mirrors the Flutter `poll_scheduler_test.dart` cases.
///
/// Written, not run (no macOS here): never compiled or executed.
@MainActor
final class PollSchedulerTests: XCTestCase {
    private func makeScheduler(
        clock: VirtualClock,
        interval: TimeInterval = 30,
        random: Double = 0.5,
        refreshOnResume: Bool = true
    ) -> PollScheduler {
        PollScheduler(interval: interval, refreshOnResume: refreshOnResume, random: { random }, sleeper: clock.sleeper)
    }

    // MARK: Interval and jitter

    func testIntervalIsExactWithoutJitterAndRunsOnTheTimer() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        let poll = makeScheduler(clock: clock)
        await poll.start(foreground: true) { try await probe.run($0) }
        XCTAssertEqual(poll.lastDelay, 30)
        await waitUntil { clock.pending == 1 }

        clock.advance(29.9)
        await settle()
        XCTAssertTrue(probe.triggers.isEmpty, "not before the interval")

        clock.advance(0.2)
        await waitUntil { probe.triggers.count == 1 }
        XCTAssertEqual(probe.triggers, [.timer])
        XCTAssertTrue(PollTrigger.timer.isBackground, "only timer runs are background traffic")
        await waitUntil { clock.pending == 1 }
        XCTAssertEqual(clock.requested.count, 2, "re-armed after the run, never overlapping it")
    }

    func testJitterStaysWithinPlusMinusTwentyPercent() async {
        let clock = VirtualClock()
        let low = makeScheduler(clock: clock, random: 0)
        let high = makeScheduler(clock: clock, random: 0.999_999)
        XCTAssertEqual(low.nextDelay(), 24, accuracy: 0.001)
        XCTAssertEqual(high.nextDelay(), 36, accuracy: 0.001)
        for value in stride(from: 0.0, to: 1.0, by: 0.05) {
            let poll = makeScheduler(clock: clock, random: value)
            let delay = poll.nextDelay()
            XCTAssertGreaterThanOrEqual(delay, 24 - 0.001)
            XCTAssertLessThanOrEqual(delay, 36 + 0.001)
        }
    }

    // MARK: Foreground / visibility

    func testHiddenScreenHasNoTimerAndBecomingVisibleRefreshesOnce() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        let poll = makeScheduler(clock: clock)
        await poll.start(foreground: true, visible: true) { try await probe.run($0) }
        await waitUntil { clock.pending == 1 }

        poll.setVisible(false)
        await waitUntil { clock.pending == 0 }
        XCTAssertFalse(poll.isScheduled)
        clock.advance(600)
        await settle()
        XCTAssertTrue(probe.triggers.isEmpty, "a hidden tab never polls")

        poll.setVisible(true)
        await waitUntil { probe.triggers.count == 1 }
        XCTAssertEqual(probe.triggers, [.visible])
        XCTAssertFalse(PollTrigger.visible.isBackground, "becoming visible is the person's own activity")
        await waitUntil { poll.isScheduled }
    }

    func testBackgroundStopsAndResumeRefreshesImmediately() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        let poll = makeScheduler(clock: clock)
        await poll.start(foreground: true) { try await probe.run($0) }
        await waitUntil { clock.pending == 1 }

        poll.setForeground(false)
        await waitUntil { clock.pending == 0 }
        clock.advance(600)
        await settle()
        XCTAssertTrue(probe.triggers.isEmpty, "a backgrounded app never polls")

        poll.setForeground(true)
        await waitUntil { probe.triggers == [.resume] }
        XCTAssertFalse(PollTrigger.resume.isBackground)
    }

    func testResumeOnlyReArmsWhenTheOwnerRefreshesItself() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        let poll = makeScheduler(clock: clock, refreshOnResume: false)
        await poll.start(foreground: true) { try await probe.run($0) }
        poll.setForeground(false)
        await waitUntil { clock.pending == 0 }
        poll.setForeground(true)
        await waitUntil { clock.pending == 1 }
        await settle()
        XCTAssertTrue(probe.triggers.isEmpty)
    }

    // MARK: Single flight

    func testRunsNeverOverlapAndAManualRefreshIsQueuedNotDropped() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        let gate = Latch()
        probe.gate = gate
        let poll = makeScheduler(clock: clock)
        await poll.start(foreground: true) { try await probe.run($0) }
        await waitUntil { clock.pending == 1 }

        clock.advance(30)
        await waitUntil { probe.running == 1 }
        // While the timer run is held open: a visibility flip joins it, a
        // manual refresh queues ONE follow-up.
        poll.setVisible(false)
        poll.setVisible(true)
        let manual = Task { await poll.refreshNow() }
        await settle()
        XCTAssertEqual(probe.triggers, [.timer], "nothing starts while a run is in flight")

        await gate.open()
        await manual.value
        XCTAssertEqual(probe.triggers, [.timer, .manual], "the queued manual run happened after, exactly once")
        XCTAssertEqual(probe.maxConcurrent, 1)
    }

    func testSingleFlightJoinSharesAndRunQueuesAfter() async {
        let flight = SingleFlight()
        let gate = Latch()
        let runs = Recorder()
        let first = Task { await flight.run { runs.add("first"); await gate.wait() } }
        await waitUntil { runs.items.count == 1 }
        let joined = Task { await flight.join { runs.add("joined") } }
        await settle()
        let queuedA = Task { await flight.run { runs.add("queuedA") } }
        await settle()
        let queuedB = Task { await flight.run { runs.add("queuedB") } }
        await settle()
        XCTAssertEqual(runs.items, ["first"])
        await gate.open()
        await first.value
        await joined.value
        await queuedA.value
        await queuedB.value
        XCTAssertEqual(runs.items, ["first", "queuedB"], "join shares; queued callers share ONE follow-up (the last)")
        XCTAssertFalse(flight.isRunning)
    }

    // MARK: 429 and backoff

    func testRateLimitWaitsRetryAfterNeverLess() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        probe.failure = APIError.from(
            status: 429,
            payload: ServerErrorPayload(message: "Too many requests"),
            retryAfter: "45"
        )
        let poll = makeScheduler(clock: clock, random: 0.999_999)
        await poll.start(foreground: true) { try await probe.run($0) }
        await waitUntil { clock.pending == 1 }
        clock.advance(36)
        await waitUntil { probe.triggers.count == 1 }
        await waitUntil { clock.pending == 1 }

        let wait = poll.lastDelay ?? 0
        XCTAssertGreaterThanOrEqual(wait, 45, "never earlier than the server asked")
        XCTAssertLessThanOrEqual(wait, 45 * 1.2 + 0.001, "at most +20 % recovery jitter")
        XCTAssertEqual(poll.failures, 0, "a 429 is not counted as a backoff failure")
        XCTAssertEqual(poll.retryAfter, 45)
    }

    func testFailuresBackOffExponentiallyCappedAndResetOnSuccess() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        probe.failure = APIError.server(status: 503)
        let poll = makeScheduler(clock: clock)
        await poll.start(foreground: true) { try await probe.run($0) }
        await waitUntil { clock.pending == 1 }
        var delays: [TimeInterval] = []
        for step in 1...5 {
            let wait = poll.lastDelay ?? 0
            clock.advance(wait)
            await waitUntil { probe.triggers.count == step }
            await waitUntil { poll.failures == step && clock.pending == 1 }
            delays.append(poll.lastDelay ?? 0)
        }
        XCTAssertEqual(delays, [60, 120, 240, 300, 300], "×2 per failure, capped at 5 min")

        probe.failure = nil
        clock.advance(poll.lastDelay ?? 0)
        await waitUntil { probe.triggers.count == 6 }
        await waitUntil { poll.failures == 0 && clock.pending == 1 }
        XCTAssertEqual(poll.lastDelay, 30, "the first success resets the backoff")
    }

    // MARK: Session change

    func testIdentityChangeStopsForGood() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        let generation = GenerationBox(7)
        let poll = makeScheduler(clock: clock)
        await poll.start(foreground: true, identity: { generation.value }) { try await probe.run($0) }
        await waitUntil { clock.pending == 1 }

        generation.value = 8 // signed out / another account
        clock.advance(30)
        await waitUntil { poll.isStopped }
        XCTAssertTrue(probe.triggers.isEmpty, "never runs under the new identity")
        poll.setVisible(false)
        poll.setVisible(true)
        await poll.refreshNow()
        await settle()
        XCTAssertTrue(probe.triggers.isEmpty)
        XCTAssertFalse(poll.isScheduled)
    }

    func testSessionChangedErrorStops() async {
        let clock = VirtualClock()
        let probe = PollProbe()
        probe.failure = APIError.sessionChanged
        let poll = makeScheduler(clock: clock)
        await poll.start(foreground: true) { try await probe.run($0) }
        await poll.refreshNow()
        XCTAssertTrue(poll.isStopped)
        XCTAssertFalse(poll.isScheduled)
    }

    func testManualTriggerIsNotBackground() {
        XCTAssertFalse(PollTrigger.manual.isBackground)
        XCTAssertTrue(PollTrigger.timer.isBackground)
    }
}

import Foundation
import SwiftUI

/// Why a poll run is happening. Only `.timer` is background traffic: it is
/// the one trigger that sends `X-Crewflow-Background: 1`. Coming back to the
/// app or to a screen, pull-to-refresh and the user's own actions are the
/// person's activity and never carry the header (Phase C1 polling policy,
/// same rule as the Flutter `PollTrigger`).
enum PollTrigger: Equatable, Sendable {
    case timer
    case resume
    case visible
    case manual

    var isBackground: Bool { self == .timer }
}

/// Suspends for `seconds`; throws `CancellationError` when the waiting task
/// is cancelled. Tests inject a virtual clock.
typealias PollSleeper = @Sendable (TimeInterval) async throws -> Void

enum PollClock {
    static let live: PollSleeper = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

/// How the polling policy reads an error thrown by a poll task.
enum PollFailure {
    /// 429: the server's `Retry-After` (seconds or HTTP date; parsed by
    /// `APIError.from`), never shorter than one second.
    static func retryAfter(_ error: Error) -> TimeInterval? {
        if case .rateLimited(let seconds, _) = error as? APIError {
            return TimeInterval(max(seconds, 1))
        }
        return nil
    }

    /// The identity the poll was started under is gone: stop for good.
    static func endsPolling(_ error: Error) -> Bool {
        (error as? APIError) == .sessionChanged
    }

    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? APIError) == .cancelled
    }
}

/// At most one run of an async task at a time (Phase C1 polling policy).
///
/// - `run`: a call while a run is in flight is QUEUED, never dropped:
///   exactly one follow-up starts after the current run, and every caller
///   queued meanwhile shares it (and returns only when it finished). Use it
///   for user actions: a reload after the person's own accept/check-in must
///   read state from AFTER that action, not reuse a read that started before.
/// - `join`: a call while a run is in flight (or queued) shares that run.
///   Use it for automatic refreshes (timer, resume) where any fresh answer
///   will do.
///
/// A queued follow-up runs the work passed by the LAST queued caller, so
/// callers that merge flags read them from their own fields when it starts.
@MainActor
final class SingleFlight {
    private var inFlight: Task<Void, Never>?
    private var inFlightToken = 0
    private var issued = 0
    private var queued: Task<Void, Never>?
    private var next: (@MainActor () async -> Void)?

    init() {}

    var isRunning: Bool { inFlight != nil || queued != nil }

    func run(_ work: @escaping @MainActor () async -> Void) async {
        if inFlight == nil, queued == nil {
            await start(work).value
            return
        }
        next = work
        if let queued {
            await queued.value
            return
        }
        let previous = inFlight
        let follower = Task { @MainActor [weak self] in
            await previous?.value
            guard let self else { return }
            self.queued = nil
            guard let work = self.next else { return }
            self.next = nil
            await self.start(work).value
        }
        queued = follower
        await follower.value
    }

    func join(_ work: @escaping @MainActor () async -> Void) async {
        if let queued {
            await queued.value
            return
        }
        if let inFlight {
            await inFlight.value
            return
        }
        await start(work).value
    }

    private func start(_ work: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        issued += 1
        let token = issued
        let task = Task { @MainActor [weak self] in
            await work()
            guard let self, self.inFlightToken == token else { return }
            self.inFlight = nil
        }
        // Nothing can run in between: this is the main actor and there is no
        // suspension point before the assignment.
        inFlight = task
        inFlightToken = token
        return task
    }
}

/// The armed timer task, reachable from a nonisolated `deinit`.
final class PollTimerHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    func set(_ next: Task<Void, Never>?) {
        lock.lock()
        let previous = task
        task = next
        lock.unlock()
        previous?.cancel()
    }

    /// Forgets the task without cancelling it (the timer task that is
    /// firing right now must not cancel itself).
    func detach() {
        lock.lock()
        task = nil
        lock.unlock()
    }

    var isArmed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return task != nil
    }

    deinit {
        task?.cancel()
    }
}

/// The Phase C1 client polling policy, once, for every iOS timer (Swift
/// counterpart of Flutter `core/polling/poll_scheduler.dart` and the web
/// `shared/lib/polling.ts`):
///
/// - the interval gets ±`jitter` (default 20 %) so phones on one venue Wi-Fi
///   do not poll in lockstep;
/// - at most one run in flight (`SingleFlight`); the next delay starts after
///   a run ends, so runs never overlap;
/// - runs only while the app is in the foreground (`setForeground`, from
///   `scenePhase`) AND the owner says the screen is visible (`setVisible`,
///   from the shell's selected tab + the screen's own appearance; hidden
///   shell tabs stay mounted at opacity 0, so `onDisappear` alone is not
///   visibility);
/// - one immediate run on returning to the foreground (`refreshOnResume`)
///   or on becoming visible again;
/// - HTTP 429: waits the server's `Retry-After` plus up to +`jitter`, never
///   less;
/// - any other failure: exponential backoff (×2 per consecutive failure,
///   capped at `maxBackoff`), jittered, reset by the first success;
/// - `identity` (the `APIClient` session generation): when it changes
///   (logout / account switch / forced expiry) the scheduler stops for good
///   and never runs the task under the new identity. An
///   `APIError.sessionChanged` from the task stops it too.
///
/// The task throws on failure; it is responsible for keeping its last good
/// data on screen. Only `.timer` runs are background traffic.
@MainActor
final class PollScheduler: ObservableObject {
    let interval: TimeInterval
    let jitter: Double
    let maxBackoff: TimeInterval
    /// False when the owner already does its own (larger) refresh on resume,
    /// so this scheduler only re-arms its timer.
    let refreshOnResume: Bool

    /// Consecutive failures since the last success (0 = healthy).
    private(set) var failures = 0
    /// The server's last 429 wait, until the next success.
    private(set) var retryAfter: TimeInterval?
    /// The delay the last armed timer used (tests and diagnostics).
    private(set) var lastDelay: TimeInterval?
    private(set) var isStarted = false
    private(set) var isStopped = false

    var onError: ((Error) -> Void)?
    var onSuccess: (() -> Void)?

    private var visible = true
    private var foreground = true
    private var identity: (@MainActor () async -> UInt64)?
    private var startIdentity: UInt64?
    private var task: (@MainActor (PollTrigger) async throws -> Void)?
    private let random: () -> Double
    private let sleeper: PollSleeper
    private let flight = SingleFlight()
    private let timer = PollTimerHandle()

    init(
        interval: TimeInterval,
        jitter: Double = 0.2,
        maxBackoff: TimeInterval = 300,
        refreshOnResume: Bool = true,
        random: @escaping () -> Double = { Double.random(in: 0..<1) },
        sleeper: @escaping PollSleeper = PollClock.live
    ) {
        self.interval = interval
        self.jitter = jitter
        self.maxBackoff = maxBackoff
        self.refreshOnResume = refreshOnResume
        self.random = random
        self.sleeper = sleeper
    }

    var isScheduled: Bool { timer.isArmed }
    var isRunning: Bool { flight.isRunning }

    /// Arms the timer. Does not run the task: owners load their first data
    /// themselves. Safe to call again (later calls are ignored).
    func start(
        foreground: Bool,
        visible: Bool? = nil,
        identity: (@MainActor () async -> UInt64)? = nil,
        task: @escaping @MainActor (PollTrigger) async throws -> Void
    ) async {
        guard !isStarted, !isStopped else { return }
        isStarted = true
        self.task = task
        self.identity = identity
        self.foreground = foreground
        if let visible { self.visible = visible }
        if let identity { startIdentity = await identity() }
        guard !isStopped else { return }
        schedule()
    }

    /// The owner's visibility (selected shell tab + on screen). Becoming
    /// visible runs once immediately (not background traffic).
    func setVisible(_ value: Bool) {
        guard visible != value else { return }
        visible = value
        guard isStarted, !isStopped else { return }
        if !value {
            timer.set(nil)
        } else if foreground {
            Task { await self.run(.visible, queue: false) }
        }
    }

    /// From `scenePhase`: only `.active` is the foreground.
    func setForeground(_ value: Bool) {
        guard foreground != value else { return }
        foreground = value
        guard isStarted, !isStopped else { return }
        if !value {
            timer.set(nil)
        } else if visible {
            if refreshOnResume {
                Task { await self.run(.resume, queue: false) }
            } else {
                schedule()
            }
        }
    }

    /// Runs the task now (queued behind an in-flight run, never dropped) and
    /// restarts the interval from its end. Pull-to-refresh / user actions.
    func refreshNow() async {
        await run(.manual, queue: true)
    }

    /// Restarts the interval from now without running anything (after the
    /// owner refreshed by other means).
    func restartInterval() {
        if isStarted, !isStopped, !flight.isRunning { schedule() }
    }

    /// Stops for good (owner went away, or the identity changed).
    func stop() {
        isStopped = true
        task = nil
        timer.set(nil)
    }

    // MARK: - Internals

    private var isActive: Bool { isStarted && !isStopped && foreground && visible }

    private func identityChanged() async -> Bool {
        guard let identity, let startIdentity else { return false }
        let current = await identity()
        guard current != startIdentity else { return false }
        stop()
        return true
    }

    private func run(_ trigger: PollTrigger, queue: Bool) async {
        timer.set(nil)
        guard isStarted, !isStopped, let task else { return }
        if await identityChanged() { return }
        let body: @MainActor () async -> Void = { [weak self] in
            guard let self, !self.isStopped else { return }
            if await self.identityChanged() { return }
            do {
                try await task(trigger)
                guard !self.isStopped else { return }
                self.failures = 0
                self.retryAfter = nil
                self.onSuccess?()
            } catch {
                guard !self.isStopped else { return }
                self.record(error)
            }
        }
        if queue {
            await flight.run(body)
        } else {
            await flight.join(body)
        }
        if !flight.isRunning { schedule() }
    }

    private func record(_ error: Error) {
        if PollFailure.endsPolling(error) {
            stop()
            return
        }
        if PollFailure.isCancellation(error) { return }
        if let wait = PollFailure.retryAfter(error) {
            retryAfter = wait
        } else {
            retryAfter = nil
            failures += 1
        }
        onError?(error)
    }

    /// The next timer delay: `Retry-After` (+0…jitter), else the interval or
    /// the backed-off interval, ±jitter.
    func nextDelay() -> TimeInterval {
        if let retryAfter {
            // Never earlier than the server asked; the extra jitter spreads
            // the recovery so phones do not come back together.
            return retryAfter + retryAfter * random() * jitter
        }
        var base = interval
        if failures > 0 {
            let factor = pow(2.0, Double(min(failures, 20)))
            base = max(min(interval * factor, maxBackoff), interval)
        }
        return base + base * (random() * 2 - 1) * jitter
    }

    private func schedule() {
        timer.set(nil)
        guard isActive else { return }
        let delay = nextDelay()
        lastDelay = delay
        let sleeper = self.sleeper
        timer.set(Task { [weak self] in
            do {
                try await sleeper(delay)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await self?.fire()
        })
    }

    private func fire() async {
        timer.detach()
        guard isActive else { return }
        await run(.timer, queue: false)
    }
}

// MARK: - Shell visibility

private struct ShellTabActiveKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// False while the shell tab this view lives in is not the selected one.
    /// The shells keep every tab mounted (opacity 0, to keep each tab's
    /// navigation and scroll state), so `onDisappear` never fires for a
    /// hidden tab: pollers read this instead.
    var shellTabActive: Bool {
        get { self[ShellTabActiveKey.self] }
        set { self[ShellTabActiveKey.self] = newValue }
    }
}

import Foundation
import XCTest
@testable import Crewflow

// Written, not run (no macOS here): every test that uses these helpers has
// only been reviewed, never compiled or executed.

/// A virtual clock for `PollSleeper`: sleepers wait until `advance` moves
/// time past their deadline; cancelling the sleeping task throws
/// `CancellationError` (exactly like `Task.sleep`).
final class VirtualClock: @unchecked Sendable {
    private struct Waiter {
        let id: Int
        let deadline: TimeInterval
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current: TimeInterval = 0
    private var waiters: [Waiter] = []
    private var counter = 0
    private var log: [TimeInterval] = []

    var now: TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    /// Sleepers currently waiting (not yet woken or cancelled).
    var pending: Int {
        lock.lock()
        defer { lock.unlock() }
        return waiters.count
    }

    /// Every delay ever asked for, in order.
    var requested: [TimeInterval] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    var sleeper: PollSleeper {
        { [self] seconds in try await self.sleep(seconds) }
    }

    /// Sync, so the lock is never taken directly in an async context.
    private func register(_ seconds: TimeInterval) -> Int {
        lock.lock()
        defer { lock.unlock() }
        counter += 1
        log.append(seconds)
        return counter
    }

    func sleep(_ seconds: TimeInterval) async throws {
        let id = register(seconds)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                waiters.append(Waiter(id: id, deadline: current + seconds, continuation: continuation))
                lock.unlock()
            }
        } onCancel: { [self] in
            lock.lock()
            let index = waiters.firstIndex { $0.id == id }
            let waiter = index.map { waiters.remove(at: $0) }
            lock.unlock()
            waiter?.continuation.resume(throwing: CancellationError())
        }
    }

    /// Moves time forward and wakes every sleeper whose deadline passed.
    func advance(_ seconds: TimeInterval) {
        lock.lock()
        current += seconds
        let now = current
        let due = waiters.filter { $0.deadline <= now + 1e-9 }
        waiters.removeAll { $0.deadline <= now + 1e-9 }
        lock.unlock()
        due.forEach { $0.continuation.resume() }
    }
}

/// Polls `condition` (letting main-actor tasks and stub responses run) until
/// it holds or `timeout` real seconds pass.
@MainActor
func waitUntil(
    _ timeout: TimeInterval = 3,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @MainActor () -> Bool
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline {
            XCTFail("Condition not met within \(timeout) s", file: file, line: line)
            return
        }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
}

/// Lets queued main-actor work run for a short real time (used to show that
/// something did NOT happen).
@MainActor
func settle(_ milliseconds: UInt64 = 60) async {
    for _ in 0..<5 { await Task.yield() }
    try? await Task.sleep(nanoseconds: milliseconds * 1_000_000)
    for _ in 0..<5 { await Task.yield() }
}

/// Records the triggers a poll task ran with; can hold a run open and fail
/// on demand.
@MainActor
final class PollProbe {
    private(set) var triggers: [PollTrigger] = []
    private(set) var running = 0
    private(set) var maxConcurrent = 0
    var failure: Error?
    var gate: Latch?

    func run(_ trigger: PollTrigger) async throws {
        triggers.append(trigger)
        running += 1
        maxConcurrent = max(maxConcurrent, running)
        if let gate { await gate.wait() }
        running -= 1
        if let failure { throw failure }
    }
}

/// A counter the stub server's handler (a background queue) can bump.
final class AtomicCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

/// A main-actor list a test's closures append to (a captured `var` cannot
/// be mutated from a `Task`).
@MainActor
final class Recorder {
    private(set) var items: [String] = []
    func add(_ item: String) { items.append(item) }
}

/// A main-actor identity generation a test can change.
@MainActor
final class GenerationBox {
    var value: UInt64
    init(_ value: UInt64) { self.value = value }
}

/// Scripted realtime server: each `open()` takes the next step.
final class FakeRealtimeTransport: RealtimeTransport, @unchecked Sendable {
    enum Step {
        case status(Int, retryAfter: String? = nil)
        case stream(FakeEventStream)
        case failure(APIError)
    }

    private let lock = NSLock()
    private var steps: [Step]
    private var count = 0

    init(_ steps: [Step]) {
        self.steps = steps
    }

    var opens: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func enqueue(_ step: Step) {
        lock.lock()
        steps.append(step)
        lock.unlock()
    }

    private func nextStep() -> Step {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return steps.isEmpty ? .status(204) : steps.removeFirst()
    }

    func open() async throws -> EventStreamResponse {
        let step = nextStep()
        switch step {
        case .status(let status, let retryAfter):
            return EventStreamResponse(status: status, retryAfter: retryAfter, lines: AsyncThrowingStream { $0.finish() }, close: {})
        case .stream(let stream):
            return EventStreamResponse(status: 200, retryAfter: nil, lines: stream.lines, close: { stream.finish() })
        case .failure(let error):
            throw error
        }
    }
}

/// One open SSE stream the test writes lines into.
final class FakeEventStream: @unchecked Sendable {
    let lines: AsyncThrowingStream<String, Error>
    private let continuation: AsyncThrowingStream<String, Error>.Continuation
    private let lock = NSLock()
    private var terminated = false

    init() {
        var captured: AsyncThrowingStream<String, Error>.Continuation!
        lines = AsyncThrowingStream { captured = $0 }
        continuation = captured
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.terminated = true
            self.lock.unlock()
        }
    }

    /// True once the client stopped reading (closed, cancelled or ended).
    var isTerminated: Bool {
        lock.lock()
        defer { lock.unlock() }
        return terminated
    }

    func send(_ line: String) {
        continuation.yield(line)
    }

    /// One complete event (`id`, `event`, `data`, blank line).
    func event(_ envelope: String, id: String, type: String) {
        send("id: \(id)")
        send("event: \(type)")
        send("data: \(envelope)")
        send("")
    }

    func keepalive() {
        send(": keepalive")
        send("")
    }

    func finish() {
        continuation.finish()
    }
}

enum RealtimeFixtures {
    static let userId = "6f1c1c3e-2c8e-4b4e-9d4f-0a1b2c3d4e5f"
    static let otherUserId = "0b6f7c1e-1111-4222-8333-444455556666"
    static let organisationId = "3a1d2c4b-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
    static let entityId = "8b0c3f52-1d2e-4a5b-9c6d-7e8f9a0b1c2d"

    static func envelope(eventId: String = UUID().uuidString.lowercased(), type: String, targetUserId: String = userId) -> String {
        #"{"version":1,"eventId":"\#(eventId)","type":"\#(type)","organisationId":"\#(organisationId)","workspaceId":null,"targetUserId":"\#(targetUserId)","entityId":"\#(entityId)","occurredAt":"2026-10-31T10:00:00.000Z"}"#
    }
}

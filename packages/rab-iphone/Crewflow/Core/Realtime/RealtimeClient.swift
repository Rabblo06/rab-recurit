import Foundation

/// Opens one realtime stream. Production: `APIRealtimeTransport` (the
/// existing `APIClient`: same bearer token, same refresh-on-401, same
/// identity-generation fencing — no second auth stack). Tests: a fake.
protocol RealtimeTransport: Sendable {
    func open() async throws -> EventStreamResponse
}

struct APIRealtimeTransport: RealtimeTransport {
    static let path = "/realtime/stream"
    let api: APIClient

    func open() async throws -> EventStreamResponse {
        try await api.openEventStream(Self.path)
    }
}

/// The Phase C1b foreground realtime client (`GET /rest/v1/realtime/stream`,
/// Server-Sent Events), the iOS counterpart of the web `realtime-client.ts`
/// and Flutter `RealtimeConnectionService`:
///
/// - Foreground and visible only: closed in the background, reconnected on
///   resume (the shells run their own resume reconcile).
/// - 204 (`REALTIME_ENABLED=false`, the default everywhere) or 404 (a server
///   without the route) = disabled: no reconnect for the life of this
///   client, i.e. until the next session/identity (each shell owns one).
/// - 401: the `APIClient` already tried ONE shared refresh; a rejected
///   refresh ended the session through the existing expiry path. 401/403
///   here = stop.
/// - 429: waits the server's `Retry-After` (default 30 s) plus jitter.
/// - Any other failure or a dropped stream: jittered exponential backoff
///   (`baseBackoff` ×2 up to `maxBackoff`), reset only after a connection
///   that stayed up for `sustainedConnection`.
/// - Watchdog: no byte (event or `: keepalive` comment, every 25 s) for
///   2 × keepalive → the stream is dropped and reconnected.
/// - Events are deduplicated by `eventId` (last 200), checked against the
///   signed-in user, coalesced briefly, and only ever trigger the stores'
///   EXISTING refresh methods (`onEvents`): an event never writes data.
/// - After a reconnect that followed a failure or a drop, `onReconnect`
///   reconciles what may have been missed while down.
/// - The identity generation is re-checked before every connect and every
///   dispatch; a changed identity stops the client for good.
@MainActor
final class RealtimeClient: ObservableObject {
    enum Status: Equatable {
        case idle
        case connecting
        case connected
        case waiting
        case disabled
        case stopped
    }

    struct Configuration {
        var keepalive: TimeInterval = 25
        var baseBackoff: TimeInterval = 1
        var maxBackoff: TimeInterval = 30
        var sustainedConnection: TimeInterval = 60
        var defaultRetryAfter: TimeInterval = 30
        var coalesce: TimeInterval = 0.5

        var watchdog: TimeInterval { keepalive * 2 }

        init() {}
    }

    static let dedupeWindow = 200

    @Published private(set) var status: Status = .idle
    /// Consecutive failed / short-lived connections (drives the backoff).
    private(set) var attempt = 0
    /// The last wait before a reconnect (tests and diagnostics).
    private(set) var lastDelay: TimeInterval?
    /// Streams opened with 200 (tests and diagnostics).
    private(set) var connections = 0

    private let transport: RealtimeTransport
    private let configuration: Configuration
    private let sleeper: PollSleeper
    private let now: () -> TimeInterval
    private let random: () -> Double
    private let connection = PollTimerHandle()
    private let dispatch = PollTimerHandle()

    private var started = false
    private var foreground = true
    private var visible = true
    private var disabled = false
    private var stopped = false
    private var identity: (@MainActor () async -> UInt64)?
    private var startIdentity: UInt64?
    private var userId: String?
    private var onEvents: (@MainActor (Set<String>) -> Void)?
    private var onReconnect: (@MainActor () -> Void)?
    /// A connect failed or a stream dropped since the last (re)connect in
    /// this foreground period: the next connect reconciles.
    private var needsReconcile = false
    private var lastActivity: TimeInterval = 0
    private var seenOrder: [String] = []
    private var seen = Set<String>()
    private var pendingTypes = Set<String>()

    init(
        transport: RealtimeTransport,
        configuration: Configuration = Configuration(),
        sleeper: @escaping PollSleeper = PollClock.live,
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        random: @escaping () -> Double = { Double.random(in: 0..<1) }
    ) {
        self.transport = transport
        self.configuration = configuration
        self.sleeper = sleeper
        self.now = now
        self.random = random
    }

    // MARK: - Lifecycle

    /// Connects (when foreground and visible). Later calls are ignored.
    func start(
        foreground: Bool,
        identity: (@MainActor () async -> UInt64)?,
        userId: String?,
        onEvents: @escaping @MainActor (Set<String>) -> Void,
        onReconnect: @escaping @MainActor () -> Void
    ) async {
        guard !started, !stopped else { return }
        started = true
        self.foreground = foreground
        self.identity = identity
        self.userId = userId
        self.onEvents = onEvents
        self.onReconnect = onReconnect
        if let identity { startIdentity = await identity() }
        connect()
    }

    /// From `scenePhase`: the stream is held only while the app is active.
    func setForeground(_ value: Bool) {
        guard foreground != value else { return }
        foreground = value
        if value {
            reopen()
        } else {
            disconnect()
        }
    }

    /// The owning shell is on screen.
    func setVisible(_ value: Bool) {
        guard visible != value else { return }
        visible = value
        if value {
            reopen()
        } else {
            disconnect()
        }
    }

    /// Stops for good (identity gone / owner gone).
    func stop() {
        stopped = true
        disconnect()
        status = .stopped
    }

    deinit {
        connection.set(nil)
        dispatch.set(nil)
    }

    // MARK: - Connection loop

    private var canConnect: Bool { started && !stopped && !disabled && foreground && visible }

    private func reopen() {
        guard canConnect else { return }
        // The shell reconciles on resume itself; the backoff starts over.
        attempt = 0
        needsReconcile = false
        connect()
    }

    private func disconnect() {
        connection.set(nil)
        dispatch.set(nil)
        pendingTypes = []
        if status != .disabled, status != .stopped { status = .idle }
    }

    private func connect() {
        connection.set(nil)
        guard canConnect else { return }
        let sleeper = self.sleeper
        connection.set(Task { @MainActor [weak self] in
            var delay: TimeInterval?
            while !Task.isCancelled {
                if let wait = delay {
                    do {
                        try await sleeper(wait)
                    } catch {
                        return
                    }
                    if Task.isCancelled { return }
                }
                // Strong only for one attempt: a sleeping loop never keeps
                // the client alive.
                guard let client = self else { return }
                guard let next = await client.cycle() else { return }
                delay = next
            }
        })
    }

    /// One connection attempt (and, on 200, the whole stream). Returns the
    /// wait before the next attempt, or nil to end the loop.
    private func cycle() async -> TimeInterval? {
        guard canConnect else { return nil }
        if await identityChanged() { return nil }
        status = .connecting
        let opened: EventStreamResponse
        do {
            opened = try await transport.open()
        } catch {
            guard !Task.isCancelled, canConnect else { return nil }
            return failed(error)
        }
        guard !Task.isCancelled, canConnect else {
            opened.close()
            return nil
        }
        if await identityChanged() {
            opened.close()
            return nil
        }
        switch opened.status {
        case 200:
            return await consume(opened)
        case 204, 404:
            opened.close()
            disabled = true
            status = .disabled
            return nil
        case 401, 403:
            opened.close()
            stopped = true
            status = .stopped
            return nil
        case 429:
            opened.close()
            let wait = retryAfter(opened.retryAfter)
            return waiting(wait + wait * random() * 0.2)
        default:
            opened.close()
            return backoff()
        }
    }

    private func failed(_ error: Error) -> TimeInterval? {
        let apiError = error as? APIError
        if apiError == .sessionChanged || apiError?.endsSession == true || apiError?.statusCode == 403 {
            stopped = true
            status = .stopped
            return nil
        }
        if case .rateLimited(let seconds, _) = apiError {
            let wait = TimeInterval(max(seconds, 1))
            return waiting(wait + wait * random() * 0.2)
        }
        return backoff()
    }

    private func consume(_ opened: EventStreamResponse) async -> TimeInterval? {
        connections += 1
        let connectedAt = now()
        lastActivity = connectedAt
        status = .connected
        if needsReconcile {
            needsReconcile = false
            onReconnect?()
        }
        let lines = opened.lines
        let reader = Task { @MainActor [weak self] in
            var parser = SSEParser()
            do {
                for try await line in lines {
                    guard let self else { return }
                    self.lastActivity = self.now()
                    if let event = parser.feed(line) { self.receive(event) }
                }
            } catch {
                // A transport error ends this stream; the loop reconnects.
            }
        }
        let watchdog = Task { @MainActor [weak self] in
            await self?.watch(reader)
        }
        await withTaskCancellationHandler {
            await reader.value
        } onCancel: {
            reader.cancel()
        }
        watchdog.cancel()
        opened.close()
        guard !Task.isCancelled, canConnect else { return nil }
        if now() - connectedAt >= configuration.sustainedConnection { attempt = 0 }
        return backoff()
    }

    /// Drops the stream when nothing (not even a keepalive) arrived for
    /// 2 × keepalive.
    private func watch(_ reader: Task<Void, Never>) async {
        let limit = configuration.watchdog
        while !Task.isCancelled {
            let remaining = limit - (now() - lastActivity)
            if remaining <= 0 {
                reader.cancel()
                return
            }
            do {
                try await sleeper(remaining)
            } catch {
                return
            }
        }
    }

    private func backoff() -> TimeInterval {
        attempt += 1
        let base = min(configuration.maxBackoff, configuration.baseBackoff * pow(2.0, Double(min(attempt - 1, 20))))
        // 50–100 % of the step: phones that lost the server together do not
        // come back together.
        return waiting(base * (0.5 + random() * 0.5))
    }

    private func waiting(_ seconds: TimeInterval) -> TimeInterval {
        needsReconcile = true
        status = .waiting
        lastDelay = seconds
        return seconds
    }

    private func retryAfter(_ header: String?) -> TimeInterval {
        guard let header, !header.trimmingCharacters(in: .whitespaces).isEmpty else {
            return configuration.defaultRetryAfter
        }
        return TimeInterval(max(RetryAfter.seconds(from: header, now: Date()), 1))
    }

    private func identityChanged() async -> Bool {
        guard let identity, let startIdentity else { return false }
        let current = await identity()
        guard current != startIdentity else { return false }
        stop()
        return true
    }

    // MARK: - Events

    private func receive(_ event: SSEEvent) {
        guard let envelope = RealtimeEnvelope.parse(event.data) else { return }
        // The server already re-checks the recipient; this is defence in depth. No known user: nothing is applied.
        guard let userId, envelope.targetUserId.lowercased() == userId.lowercased() else { return }
        guard remember(envelope.eventId) else { return }
        pendingTypes.insert(envelope.type)
        guard !dispatch.isArmed else { return }
        let sleeper = self.sleeper
        let delay = configuration.coalesce
        dispatch.set(Task { @MainActor [weak self] in
            if delay > 0 {
                do {
                    try await sleeper(delay)
                } catch {
                    return
                }
            }
            guard let self else { return }
            self.dispatch.detach()
            let types = self.pendingTypes
            self.pendingTypes = []
            guard !types.isEmpty else { return }
            if await self.identityChanged() { return }
            self.onEvents?(types)
        })
    }

    /// Bounded FIFO dedupe; false for an id already seen.
    private func remember(_ eventId: String) -> Bool {
        let key = eventId.lowercased()
        guard seen.insert(key).inserted else { return false }
        seenOrder.append(key)
        if seenOrder.count > Self.dedupeWindow {
            seen.remove(seenOrder.removeFirst())
        }
        return true
    }
}

// MARK: - Event → store refresh maps

/// What a Staff identity refreshes for a set of event types. Only the
/// stores' existing reads; nothing from the event is written anywhere.
enum StaffRealtimeRefresh: Hashable, CaseIterable {
    case offers
    case attendance
    case history
    case unreadCount

    static func refreshes(for types: Set<String>) -> Set<StaffRealtimeRefresh> {
        var result = Set<StaffRealtimeRefresh>()
        for type in types {
            if type.hasPrefix("offer.") || type == "shift.updated" || type == "shift.cancelled" {
                result.insert(.offers)
            }
            if type == "attendance.changed" {
                result.insert(.attendance)
                result.insert(.history)
            }
            if type == "payroll.record_changed" { result.insert(.history) }
            if type == "notification.created" { result.insert(.unreadCount) }
        }
        return result
    }
}

/// A Venue Manager identity: offer, shift, request and attendance changes
/// re-run the full refresh (single-flight, so a burst costs at most one
/// extra run).
enum VMRealtimeRefresh {
    static func needsRefresh(_ types: Set<String>) -> Bool {
        types.contains { type in
            type.hasPrefix("offer.") || type.hasPrefix("shift.") || type.hasPrefix("shift_request.") || type == "attendance.changed"
        }
    }
}

import Darwin
import Foundation

// MARK: - Contract (DESIGN §7.2)

/// `POST /rest/v1/attendance/me/sync` body: 1...25 entries in ascending
/// `clientSeq`. Nothing else (the DTO refuses unknown members with 400).
struct OfflineSyncRequestBody: Encodable, Equatable {
    let entries: [OfflinePunchEntry]
}

/// One per-item outcome, matched to an entry by `idempotencyKey`.
struct OfflineSyncItemResult: Decodable, Equatable {
    enum Outcome: String {
        case applied
        case duplicate
        case replayed
        case rejected
    }

    let idempotencyKey: String
    /// nil for an outcome this build does not know: the entry stays pending
    /// (never treated as received; a resend is answered `replayed`).
    let outcome: Outcome?
    let code: String?

    enum CodingKeys: String, CodingKey {
        case idempotencyKey, outcome, code
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        idempotencyKey = try c.decode(String.self, forKey: .idempotencyKey)
        outcome = (try? c.decodeIfPresent(String.self, forKey: .outcome)).flatMap { Outcome(rawValue: $0) }
        code = try? c.decodeIfPresent(String.self, forKey: .code)
    }
}

/// The 200 answer. There is no 207: one batch, one 200, per-item outcomes.
struct OfflineSyncResponse: Decodable {
    let serverNow: Date?
    let results: [OfflineSyncItemResult]
    let offlineTicket: String?

    enum CodingKeys: String, CodingKey {
        case serverNow, results, offlineTicket
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serverNow = try? c.decodeIfPresent(Date.self, forKey: .serverNow)
        results = try c.decode([OfflineSyncItemResult].self, forKey: .results)
        offlineTicket = try? c.decodeIfPresent(String.self, forKey: .offlineTicket)
    }
}

// MARK: - Staff words (DESIGN §3.6, §4.6)

enum OfflineSyncMessages {
    static let managerCanSee = "Your manager can see this and can record your hours."
    static let undeliverable = "Could not send. Contact support."
    static let tooOld = "Too old to send automatically. Tell your manager."
    static let waiting = "Waiting to send"

    /// Plain words per rejection code. Server text is never shown.
    static let reasons: [String: String] = [
        "SHIFT_NOT_FOUND": "This shift could not be found for you.",
        "OFFLINE_NOT_ENABLED": "Offline clocking is not turned on for this venue.",
        "TIME_UNTRUSTED": "The time of this action could not be confirmed.",
        "SYNC_TOO_LATE": "This was sent too late to be recorded automatically.",
        "REPORT_FINALISED": "The shift report was already finalised.",
        "OUTSIDE_WINDOW": "This was outside the shift's clock-in and clock-out times.",
        "INVALID_QR": "The venue QR code could not be confirmed.",
        "MANAGER_ALREADY_RECORDED": "Your manager already recorded this.",
        "DEPENDENCY_REJECTED": "An earlier action for this shift was not accepted.",
        "ALREADY_ACTIVE": "You were still clocked in to another shift.",
        "NO_OPEN_BREAK": "There was no break to end.",
        "BREAK_ALREADY_OPEN": "Your break had already started.",
        "MOCK_LOCATION": "Your location could not be trusted.",
        "ENTRY_NOT_ACCEPTED": "This action could not be accepted from this phone.",
        "SIGNATURE_INVALID": "This action could not be accepted from this phone.",
        "DEVICE_KEY_REVOKED": "This action could not be accepted from this phone.",
        "IDEMPOTENCY_KEY_REUSED": "This action could not be accepted from this phone.",
    ]

    static func reason(_ code: String?) -> String {
        if let code, let text = reasons[code] ?? StaffAttendanceMessages.staff[code] { return text }
        return "This action was not accepted."
    }
}

// MARK: - Engine (DESIGN §3.5)

/// Sends saved actions: `clientSeq` order, at most 25 per request, one
/// request at a time (single-flight), partial success handled per item.
///
/// - `applied`, `duplicate` and `replayed` entries are deleted; `rejected`
///   ones stay visible (with the server's code) until dismissed.
/// - A missing or unknown per-item outcome leaves the entry pending and ENDS
///   the run: no later batch is sent while an earlier entry is unanswered, so
///   a later punch never overtakes an earlier one (and never a tight loop).
/// - 400 / 413 / 422 for the whole batch (a client bug): resent one at a
///   time, and the entry the server still refuses is parked as undeliverable.
/// - 401: the API client already refreshed and retried once; the session has
///   ended, so the run stops and the queue is kept.
/// - 429: nothing is sent before `Retry-After` (capped at 15 min, so a bad
///   header cannot park the queue for days), whatever the trigger.
/// - Before every request the signed-in user must still be the queue's
///   owner; otherwise nothing is sent (another account never sends it).
/// - Network failure, timeout, 5xx, 403, 404 (a server without the route) or
///   an undecodable answer: exponential backoff, 1 s to 5 min, for the
///   automatic triggers; the entries stay pending. A resend is always safe:
///   the server answers `replayed` for a key it has already seen.
@MainActor
final class OfflineSyncEngine {
    enum Trigger: Equatable {
        /// Successful read, resume, the 30 s reconcile: honours the backoff.
        case automatic
        /// "Send now": skips the backoff, still honours `Retry-After`.
        case manual
    }

    enum RunResult: Equatable {
        case nothingToSend
        /// Backoff, `Retry-After`, or a run already in flight.
        case deferred
        /// `received`: applied, duplicate or replayed (deleted from the phone).
        case sent(received: Int, rejected: Int)
        case failed
    }

    typealias Send = (OfflineSyncRequestBody) async throws -> OfflineSyncResponse
    /// A fresh ticket from the answer, its `serverNow`, and the boot reading
    /// taken just before the request (for the 10 s rule).
    typealias TicketHandler = (String?, Date?, OfflineBootReading?) -> Void

    static let minBackoffMs: Int64 = 1_000
    static let maxBackoffMs: Int64 = 300_000
    static let maxRetryAfterSeconds = 900

    private let queue: OfflinePunchQueue
    private let send: Send
    private let bootClock: OfflineBootClock
    private let monotonicMs: () -> Int64
    private let onTicket: TicketHandler
    private let isOwnerSignedIn: () -> Bool

    private(set) var isRunning = false
    private(set) var consecutiveFailures = 0
    /// Automatic runs wait until this monotonic instant (ms).
    private(set) var notBeforeMs: Int64?
    /// Every run waits until this monotonic instant (ms) after a 429.
    private(set) var retryAfterUntilMs: Int64?

    init(
        queue: OfflinePunchQueue,
        bootClock: OfflineBootClock,
        monotonicMs: @escaping () -> Int64 = { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) },
        onTicket: @escaping TicketHandler = { _, _, _ in },
        isOwnerSignedIn: @escaping () -> Bool = { true },
        send: @escaping Send
    ) {
        self.queue = queue
        self.bootClock = bootClock
        self.monotonicMs = monotonicMs
        self.onTicket = onTicket
        self.isOwnerSignedIn = isOwnerSignedIn
        self.send = send
    }

    /// One sync run. `trustedNow` (server-anchored) marks entries older than
    /// 72 h as too old before anything is sent; nil judges nothing.
    func run(trigger: Trigger, trustedNow: Date?) async -> RunResult {
        guard !isRunning else { return .deferred }
        queue.markTooOld(now: trustedNow)
        guard queue.hasPending else { return .nothingToSend }
        let now = monotonicMs()
        if let until = retryAfterUntilMs, now < until { return .deferred }
        if trigger == .automatic, let notBefore = notBeforeMs, now < notBefore { return .deferred }
        isRunning = true
        defer { isRunning = false }

        var received = 0
        var rejected = 0
        let limits = queue.limits
        let maxRounds = limits.maxEntries / max(1, limits.maxBatch) + 2
        for _ in 0..<maxRounds {
            let batch = Array(queue.pending.prefix(max(1, limits.maxBatch)))
            if batch.isEmpty { break }
            switch await sendBatch(batch) {
            case .settled(let r, let j, let complete):
                received += r
                rejected += j
                if !complete { return .sent(received: received, rejected: rejected) }
            case .refusedAsRequest:
                if batch.count == 1 {
                    queue.settle(remove: [], undeliverable: [batch[0].id])
                    continue
                }
                let single = await sendOneByOne(batch)
                received += single.received
                rejected += single.rejected
                if single.stopped { return received + rejected > 0 ? .sent(received: received, rejected: rejected) : .failed }
            case .stop:
                return received + rejected > 0 ? .sent(received: received, rejected: rejected) : .failed
            }
        }
        return .sent(received: received, rejected: rejected)
    }

    private enum BatchOutcome {
        /// `complete`: every entry of the batch got a known outcome.
        case settled(received: Int, rejected: Int, complete: Bool)
        case refusedAsRequest
        case stop
    }

    private func sendBatch(_ batch: [OfflineQueuedPunch]) async -> BatchOutcome {
        guard isOwnerSignedIn() else { return .stop }
        let started = bootClock.reading()
        do {
            let response = try await send(OfflineSyncRequestBody(entries: batch.map(\.entry)))
            succeeded()
            onTicket(response.offlineTicket, response.serverNow, started)
            return settle(batch, with: response)
        } catch let error as APIError {
            switch error {
            case .validation:
                return .refusedAsRequest
            case .http(let status, _) where status == 413:
                return .refusedAsRequest
            case .rateLimited(let seconds, _):
                retryAfterUntilMs = monotonicMs() + Int64(min(max(1, seconds), Self.maxRetryAfterSeconds)) * 1_000
                return .stop
            case .unauthorized, .sessionChanged, .cancelled:
                return .stop
            default:
                backOff()
                return .stop
            }
        } catch {
            backOff()
            return .stop
        }
    }

    private func sendOneByOne(_ batch: [OfflineQueuedPunch]) async -> (received: Int, rejected: Int, stopped: Bool) {
        var received = 0
        var rejected = 0
        for punch in batch {
            guard queue.pending.contains(where: { $0.id == punch.id }) else { continue }
            switch await sendBatch([punch]) {
            case .settled(let r, let j, let complete):
                received += r
                rejected += j
                if !complete { return (received, rejected, true) }
            case .refusedAsRequest:
                queue.settle(remove: [], undeliverable: [punch.id])
            case .stop:
                return (received, rejected, true)
            }
        }
        return (received, rejected, false)
    }

    private func settle(_ batch: [OfflineQueuedPunch], with response: OfflineSyncResponse) -> BatchOutcome {
        var byKey: [String: OfflineSyncItemResult] = [:]
        for result in response.results where byKey[result.idempotencyKey] == nil {
            byKey[result.idempotencyKey] = result
        }
        var remove = Set<String>()
        var rejected: [String: String] = [:]
        var complete = true
        for punch in batch {
            guard let result = byKey[punch.id], let outcome = result.outcome else {
                complete = false
                continue
            }
            switch outcome {
            case .applied, .duplicate:
                remove.insert(punch.id)
            case .replayed:
                // The stored outcome of the first attempt: a replayed
                // rejection keeps its code.
                if let code = result.code {
                    rejected[punch.id] = Self.reasonCode(code)
                } else {
                    remove.insert(punch.id)
                }
            case .rejected:
                rejected[punch.id] = Self.reasonCode(result.code)
            }
        }
        queue.settle(remove: remove, rejected: rejected)
        return .settled(received: remove.count, rejected: rejected.count, complete: complete)
    }

    /// Only a well-formed code is kept (the receipt CHECK's shape); anything
    /// else becomes the generic `REJECTED`.
    static func reasonCode(_ raw: String?) -> String {
        guard let raw, raw.range(of: "^[A-Z][A-Z_]{2,48}$", options: .regularExpression) != nil else { return "REJECTED" }
        return raw
    }

    private func succeeded() {
        consecutiveFailures = 0
        notBeforeMs = nil
        retryAfterUntilMs = nil
    }

    private func backOff() {
        consecutiveFailures += 1
        let exponent = min(consecutiveFailures - 1, 20)
        let delay = min(Self.maxBackoffMs, Self.minBackoffMs << exponent)
        notBeforeMs = monotonicMs() + delay
    }
}

import Foundation

/// DESIGN §3.4 / §3.5 / D5. One shift is about 8 events, so these are far
/// above normal use; they bound what a lost phone holds and what one request
/// carries.
struct OfflineQueueLimits: Equatable, Sendable {
    /// Entries per user.
    var maxEntries = 30
    /// Stored bytes per user (the whole queue, encoded).
    var maxBytes = 48 * 1024
    /// No new entry more than 16 h after the ticket arrived
    /// (`OFFLINE_MAX_CAPTURE_AGE_HOURS`).
    var maxCaptureAgeMs: Int64 = 16 * 3_600_000
    /// An entry captured more than 72 h ago is not sent
    /// (`OFFLINE_SYNC_MAX_DELAY_HOURS`).
    var maxSyncDelay: TimeInterval = 72 * 3600
    /// Entries per sync request (`OFFLINE_SYNC_MAX_BATCH`).
    var maxBatch = 25
    /// A ticket whose fetch took longer than this is thrown away, so the
    /// gap between its issue time and its arrival stays small (§4.2).
    var maxTicketFetchMs: Int64 = 10_000

    static let standard = OfflineQueueLimits()
}

/// One saved action plus what only the phone needs to know about it. Only
/// `entry` is ever sent.
struct OfflineQueuedPunch: Codable, Equatable, Identifiable, Sendable {
    enum State: String, Codable, Sendable {
        /// Waiting to be sent.
        case pending
        /// The server refused it. It holds a receipt, so the manager sees it.
        case rejected
        /// Captured more than 72 h ago: never sent automatically (D5).
        case tooOld
        /// The server refused the request itself (400): a client bug. Parked.
        case undeliverable
    }

    var entry: OfflinePunchEntry
    var state: State
    /// The server's reason code for a rejection (`^[A-Z][A-Z_]{2,48}$` only).
    var rejectionCode: String?
    /// Server-anchored estimate of the button press: the ticket response's
    /// `serverNow` plus the boot-clock time since it arrived. For the screen
    /// ("saved at 09:02") and the local 72 h check only; never sent, never
    /// the device wall clock, and never what the server records.
    let estimatedAt: Date

    var id: String { entry.idempotencyKey }
    var type: OfflinePunchType { entry.type }
    var shiftId: String { entry.shiftId }
    /// Not yet received by the server. A rejected entry has reached it.
    var isUnsent: Bool { state != .rejected }
}

/// The latest offline ticket (DESIGN §4.2) and the boot-clock reading taken
/// when it arrived. Stored only while the server says offline is enabled;
/// its presence IS the server's permission as last seen.
struct OfflineTicketRecord: Codable, Equatable, Sendable {
    let ticket: String
    let received: OfflineBootReading
    /// `serverNow` of the response that carried the ticket (display and the
    /// local age check only).
    let serverNow: Date
}

/// Encrypted at rest (DESIGN §3.3): Keychain items through the app's existing
/// `SecureStore` (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not
/// synchronizable, so never in iCloud Keychain and never restored to another
/// device). Everything is keyed by the signed-in user's id: a different user
/// on the same phone never reads, sends or overwrites another user's queue.
final class OfflinePunchStorage {
    static let installIdKey = "rab.offline.installId"
    static func queueKey(_ userId: String) -> String { "rab.offline.queue.\(userId)" }
    static func ticketKey(_ userId: String) -> String { "rab.offline.ticket.\(userId)" }
    static func sequenceKey(_ installId: String) -> String { "rab.offline.seq.\(installId)" }

    enum LoadResult: Equatable {
        case loaded([OfflineQueuedPunch])
        /// Present but not decodable. Never overwritten silently: new
        /// captures are refused until the person discards it.
        case unreadable
    }

    enum StorageError: Error, Equatable {
        case encoding
        case write
    }

    let userId: String
    private let store: any SecureStore

    init(store: any SecureStore, userId: String) {
        self.store = store
        self.userId = userId
    }

    func loadQueue() -> LoadResult {
        guard let text = store.string(for: Self.queueKey(userId)) else { return .loaded([]) }
        guard let items = try? CrewflowJSON.makeDecoder().decode([OfflineQueuedPunch].self, from: Data(text.utf8)) else {
            return .unreadable
        }
        return .loaded(items)
    }

    /// The encoded queue exactly as it would be stored (for the size limit).
    func encode(_ items: [OfflineQueuedPunch]) throws -> String {
        guard let data = try? CrewflowJSON.makeEncoder().encode(items), let text = String(data: data, encoding: .utf8) else {
            throw StorageError.encoding
        }
        return text
    }

    func saveQueue(_ items: [OfflineQueuedPunch]) throws {
        if items.isEmpty {
            store.remove(Self.queueKey(userId))
            return
        }
        let text = try encode(items)
        do {
            try store.set(text, for: Self.queueKey(userId))
        } catch {
            throw StorageError.write
        }
    }

    func clearQueue() {
        store.remove(Self.queueKey(userId))
    }

    func loadTicket() -> OfflineTicketRecord? {
        guard let text = store.string(for: Self.ticketKey(userId)) else { return nil }
        return try? CrewflowJSON.makeDecoder().decode(OfflineTicketRecord.self, from: Data(text.utf8))
    }

    func saveTicket(_ record: OfflineTicketRecord) throws {
        guard let data = try? CrewflowJSON.makeEncoder().encode(record), let text = String(data: data, encoding: .utf8) else {
            throw StorageError.encoding
        }
        do {
            try store.set(text, for: Self.ticketKey(userId))
        } catch {
            throw StorageError.write
        }
    }

    func clearTicket() {
        store.remove(Self.ticketKey(userId))
    }

    /// A random id for this install (made once, kept in the secure store).
    func installId() throws -> String {
        if let existing = store.string(for: Self.installIdKey), !existing.isEmpty { return existing }
        let made = UUID().uuidString.lowercased()
        do {
            try store.set(made, for: Self.installIdKey)
        } catch {
            throw StorageError.write
        }
        return made
    }

    /// The next `clientSeq`: persisted BEFORE it is used, so a crash can skip
    /// a number but never reuse one. `atLeast` (the highest number already in
    /// the queue) keeps it increasing even if the counter item was lost.
    func nextClientSeq(atLeast floor: Int64) throws -> Int64 {
        let key = Self.sequenceKey(try installId())
        let stored = store.string(for: key).flatMap { Int64($0) } ?? 0
        let next = max(stored, floor) + 1
        do {
            try store.set(String(next), for: key)
        } catch {
            throw StorageError.write
        }
        return next
    }
}

/// The saved actions of ONE user, in memory and in the secure store. Every
/// change is written first and published only after the write succeeded, so
/// the screen never shows an action the phone did not keep.
@MainActor
final class OfflinePunchQueue: ObservableObject {
    enum AppendError: Error, Equatable {
        case full
        case unreadable
        case storage
    }

    @Published private(set) var items: [OfflineQueuedPunch] = []
    /// The stored queue could not be read. Nothing new is captured, and
    /// sign-out still asks first (it may hold unsent actions).
    @Published private(set) var unreadable = false

    let storage: OfflinePunchStorage
    let limits: OfflineQueueLimits

    init(storage: OfflinePunchStorage, limits: OfflineQueueLimits = .standard) {
        self.storage = storage
        self.limits = limits
        reload()
    }

    func reload() {
        switch storage.loadQueue() {
        case .loaded(let loaded):
            items = loaded.sorted { $0.entry.clientSeq < $1.entry.clientSeq }
            unreadable = false
        case .unreadable:
            items = []
            unreadable = true
        }
    }

    /// Waiting to be sent, in `clientSeq` order (the replay order, §3.5).
    var pending: [OfflineQueuedPunch] {
        items.filter { $0.state == .pending }
    }

    var hasPending: Bool { items.contains { $0.state == .pending } }

    /// Actions the server has not received (D18 blocks sign-out on these).
    /// An unreadable queue counts as one: it may hold some.
    var unsentCount: Int {
        let count = items.filter(\.isUnsent).count
        return unreadable ? max(count, 1) : count
    }

    var highestClientSeq: Int64 { items.map(\.entry.clientSeq).max() ?? 0 }

    /// The pending action of `type` for `shiftId`, if any.
    func pending(_ type: OfflinePunchType, shiftId: String) -> OfflineQueuedPunch? {
        items.last { $0.state == .pending && $0.type == type && $0.shiftId == shiftId }
    }

    /// Saved actions for one shift, in capture order.
    func punches(forShift shiftId: String) -> [OfflineQueuedPunch] {
        items.filter { $0.shiftId == shiftId }
    }

    /// Adds one action, enforcing the entry and byte limits (§3.4).
    func append(_ punch: OfflineQueuedPunch) throws {
        guard !unreadable else { throw AppendError.unreadable }
        guard items.count < limits.maxEntries else { throw AppendError.full }
        let next = items + [punch]
        let encoded: String
        do {
            encoded = try storage.encode(next)
        } catch {
            throw AppendError.storage
        }
        guard encoded.utf8.count <= limits.maxBytes else { throw AppendError.full }
        try commit(next, or: AppendError.storage)
    }

    /// Applies a sync answer: `remove` were received (applied, duplicate or
    /// replayed); `rejected` maps an id to the server's reason code;
    /// `undeliverable` were refused as a request. Anything else is unchanged.
    func settle(remove: Set<String>, rejected: [String: String] = [:], undeliverable: Set<String> = []) {
        guard !remove.isEmpty || !rejected.isEmpty || !undeliverable.isEmpty else { return }
        var next: [OfflineQueuedPunch] = []
        for var punch in items {
            if remove.contains(punch.id) { continue }
            if let code = rejected[punch.id] {
                punch.state = .rejected
                punch.rejectionCode = code
            } else if undeliverable.contains(punch.id) {
                punch.state = .undeliverable
            }
            next.append(punch)
        }
        try? commit(next, or: AppendError.storage)
    }

    /// D5: pending actions captured more than 72 h ago (measured on the
    /// server-anchored clock) are no longer sent. Without trusted time
    /// nothing is judged; the server decides (`SYNC_TOO_LATE`).
    func markTooOld(now: Date?) {
        guard let now else { return }
        var changed = false
        let next = items.map { punch -> OfflineQueuedPunch in
            guard punch.state == .pending, now.timeIntervalSince(punch.estimatedAt) > limits.maxSyncDelay else { return punch }
            var copy = punch
            copy.state = .tooOld
            changed = true
            return copy
        }
        if changed { try? commit(next, or: AppendError.storage) }
    }

    /// The person dismissed a rejected, too-old or undeliverable action. A
    /// pending one is never dismissed one by one (only `discardAll`, D18).
    func dismiss(id: String) {
        guard let punch = items.first(where: { $0.id == id }), punch.state != .pending else { return }
        try? commit(items.filter { $0.id != id }, or: AppendError.storage)
    }

    /// D18: the person explicitly discarded everything saved on this phone.
    /// Discarded actions are never sent and the manager is not told.
    func discardAll() {
        storage.clearQueue()
        items = []
        unreadable = false
    }

    private func commit(_ next: [OfflineQueuedPunch], or failure: AppendError) throws {
        do {
            try storage.saveQueue(next)
        } catch {
            throw failure
        }
        items = next
    }
}

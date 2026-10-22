import Foundation

/// Keeps shift colour assignments across cold starts (Flutter
/// `ShiftColourStore`). Presentation only: the file holds hashed keys and
/// palette slots, never shift ids or shift data. Any read/write failure
/// falls back to in-memory colours (colour carries no authority, so failing
/// open here is safe).
@MainActor
public final class ShiftColourStore {
    /// Most recent assignments kept; the oldest are dropped first.
    public static let maxEntries = 500

    private let file: URL
    private var entries: [String: Int] = [:]
    /// Insertion order, oldest first (Dictionary has none).
    private var order: [String] = []
    private var pending: Task<Void, Never>?

    init(file: URL) {
        self.file = file
    }

    /// Restores saved colours into [registry] and records new assignments.
    public static func attach(_ registry: ShiftColourRegistry, fileManager: FileManager = .default) {
        do {
            let directory = try fileManager.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            )
            let store = ShiftColourStore(file: directory.appendingPathComponent("shift_colours.json"))
            store.load()
            registry.restore(store.entries)
            registry.onAssigned = { [store] key, slot in store.remember(key, slot) }
        } catch {
            debugLog("Shift colours will not persist this session: \(error)")
        }
    }

    /// Saved oldest first, so trimming after a restart still drops the
    /// oldest assignments.
    private struct Entry: Codable {
        let key: String
        let slot: Int
    }

    func load() {
        guard let data = try? Data(contentsOf: file),
              let decoded = try? JSONDecoder().decode([Entry].self, from: data)
        else { return }
        for entry in decoded where entries[entry.key] == nil {
            entries[entry.key] = entry.slot
            order.append(entry.key)
        }
        trim()
    }

    func remember(_ key: String, _ slot: Int) {
        if entries[key] != nil { order.removeAll { $0 == key } }
        entries[key] = slot
        order.append(key)
        trim()
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    var savedEntriesForTesting: [String: Int] { entries }

    private func trim() {
        while order.count > Self.maxEntries {
            entries.removeValue(forKey: order.removeFirst())
        }
    }

    private func save() {
        do {
            let saved = order.compactMap { key in entries[key].map { Entry(key: key, slot: $0) } }
            let data = try JSONEncoder().encode(saved)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            Self.debugLog("Shift colours not saved: \(error)")
        }
    }

    private static func debugLog(_ message: String) {
        #if DEBUG
        print(message)
        #endif
    }
}

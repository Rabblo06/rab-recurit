import XCTest
@testable import Crewflow

@MainActor
final class ShiftColourStoreTests: XCTestCase {
    private var file: URL!

    override func setUp() {
        super.setUp()
        file = FileManager.default.temporaryDirectory
            .appendingPathComponent("shift-colours-\(UUID().uuidString).json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: file)
        super.tearDown()
    }

    func testAssignmentsSurviveARestart() async throws {
        let first = ShiftColourRegistry()
        let store = ShiftColourStore(file: file)
        first.onAssigned = { key, slot in store.remember(key, slot) }
        first.registerGroup(["shift-a", "shift-b", "shift-c"])
        let before = ["shift-a", "shift-b", "shift-c"].map { first.resolve($0) }
        try await Task.sleep(nanoseconds: 700_000_000)

        let restarted = ShiftColourRegistry()
        let reloaded = ShiftColourStore(file: file)
        reloaded.load()
        restarted.restore(reloaded.savedEntriesForTesting)
        // Resolve in a different order: restored slots win over allocation.
        let after = ["shift-c", "shift-b", "shift-a"].map { restarted.resolve($0) }.reversed()
        XCTAssertEqual(before, Array(after))
    }

    func testFileHoldsHashedKeysNotShiftIds() async throws {
        let store = ShiftColourStore(file: file)
        store.remember(ShiftColourRegistry.persistenceKey("secret-shift-id"), 1)
        try await Task.sleep(nanoseconds: 700_000_000)
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(text.contains("secret-shift-id"))
    }

    func testOldestEntriesAreDroppedFirst() {
        let store = ShiftColourStore(file: file)
        for index in 0...ShiftColourStore.maxEntries {
            store.remember("k\(index)", index % 3)
        }
        let saved = store.savedEntriesForTesting
        XCTAssertEqual(saved.count, ShiftColourStore.maxEntries)
        XCTAssertNil(saved["k0"])
        XCTAssertNotNil(saved["k\(ShiftColourStore.maxEntries)"])
    }

    func testUnreadableFileFallsBackToNoColours() throws {
        try Data("not json".utf8).write(to: file)
        let store = ShiftColourStore(file: file)
        store.load()
        XCTAssertTrue(store.savedEntriesForTesting.isEmpty)
    }
}

import SwiftUI

/// Stable presentation identity of a Shift (one of three approved pastels),
/// shared by the Staff and Venue Manager shells. Port of
/// packages/rab-mobile/lib/core/theme/shift_visual_style.dart.
/// UI only: no authorisation or business meaning.
public enum ShiftVisualStyle: Int, CaseIterable, Sendable {
    case mint = 0
    case peach = 1
    case lavender = 2

    /// The three approved pastels in reference order. Fixed order is a
    /// visual contract (indexes are persisted). Never reorder.
    public static let palette: [ShiftVisualStyle] = [.mint, .peach, .lavender]

    /// One registry for the app session, shared across screens and roles.
    @MainActor public static let registry = ShiftColourRegistry()

    @MainActor public static func forShift(_ shiftId: String) -> ShiftVisualStyle {
        registry.resolve(shiftId)
    }

    @MainActor public static func registerGroup<S: Sequence>(_ shiftIds: S) where S.Element == String {
        registry.registerGroup(shiftIds)
    }

    /// Portable preferred slot (not the final collision-resolved one):
    /// `hash = (hash * 31 + codeUnit) % 2147483647` over UTF-16 code units,
    /// identical to Dart's `String.codeUnits` loop. Dart throws for an empty
    /// id; here an empty id maps to slot 0 instead of crashing the UI.
    public static func preferredIndex(_ shiftId: String) -> Int {
        guard !shiftId.isEmpty else { return 0 }
        var hash: Int64 = 0
        for unit in shiftId.utf16 {
            hash = (hash * 31 + Int64(unit)) % 2_147_483_647
        }
        return Int(hash % Int64(palette.count))
    }

    // MARK: Colours

    public var cardRGBA: RGBA {
        switch self {
        case .lavender: return SchedulePalette.lavender
        case .peach: return SchedulePalette.peach
        case .mint: return SchedulePalette.mint
        }
    }

    /// Detail-only strong surface.
    public var strongBackgroundRGBA: RGBA {
        switch self {
        case .lavender: return RGBA(argb: 0xFFC5CAFF)
        case .peach: return RGBA(argb: 0xFFFFD2B5)
        case .mint: return RGBA(argb: 0xFFB4E6CF)
        }
    }

    /// Status pill surface ("New Offer", "Confirmed").
    public var badgeSurfaceRGBA: RGBA {
        switch self {
        case .mint: return RGBA(argb: 0xFFCDF3E1)
        case .peach: return RGBA(argb: 0xFFFFDDC6)
        case .lavender: return RGBA(argb: 0xFFC8CDFF)
        }
    }

    /// Badge text; at least 4.5:1 on the badge surface.
    public var badgeTextRGBA: RGBA {
        switch self {
        case .mint: return RGBA(argb: 0xFF0B6B47)
        case .peach: return RGBA(argb: 0xFF9A4310)
        case .lavender: return RGBA(argb: 0xFF3B41A8)
        }
    }

    public var card: Color { cardRGBA.color }
    public var strongBackground: Color { strongBackgroundRGBA.color }
    public var badgeSurface: Color { badgeSurfaceRGBA.color }
    public var badgeText: Color { badgeTextRGBA.color }
    /// Hairline around a pastel card.
    public var cardBorder: Color { cardRGBA.lerp(to: strongBackgroundRGBA, 0.55).color }
    public var page: Color { SchedulePalette.surface.lerp(to: cardRGBA, 0.18).color }
    public var shadowColor: Color { cardRGBA.lerp(to: SchedulePalette.ink, 0.4).withAlpha(0.08).color }
}

/// UI-only identity registry. Never reassigns a known shift during the
/// process lifetime; spreads neighbours across the three pastels.
///
/// Persistence is optional: set `onAssigned` and call `restore` to keep
/// colours across launches. Keys are one-way hashes of shift ids (never ids
/// or shift data) and carry no authorisation meaning, so plain
/// UserDefaults is acceptable for them.
@MainActor
public final class ShiftColourRegistry {
    private var assigned: [String: Int] = [:]
    private var usage: [Int] = Array(repeating: 0, count: ShiftVisualStyle.palette.count)
    private var restored: [String: Int] = [:]
    private var last: Int?

    /// Called with (persistence key, slot) for every NEW assignment.
    public var onAssigned: ((String, Int) -> Void)?

    public init() {}

    /// Non-reversible persistence key: two bounded polynomial hashes in base
    /// 36, identical to Flutter's `ShiftColourRegistry.persistenceKey`.
    public nonisolated static func persistenceKey(_ shiftId: String) -> String {
        var a: Int64 = 0
        var b: Int64 = 0
        for unit in shiftId.utf16 {
            a = (a * 31 + Int64(unit)) % 2_147_483_647
            b = (b * 131 + Int64(unit)) % 2_147_483_629
        }
        return String(a, radix: 36) + "." + String(b, radix: 36)
    }

    /// Restores saved assignments. Out-of-range slots are ignored; ids
    /// already known in this process are never recoloured.
    public func restore(_ saved: [String: Int]) {
        for (key, slot) in saved where slot >= 0 && slot < usage.count {
            restored[key] = slot
        }
    }

    private func known(_ id: String) -> Int? {
        if let current = assigned[id] { return current }
        guard let saved = restored[Self.persistenceKey(id)] else { return nil }
        assigned[id] = saved
        usage[saved] += 1
        return saved
    }

    public func resolve(_ shiftId: String) -> ShiftVisualStyle {
        if let slot = known(shiftId) { return ShiftVisualStyle.palette[slot] }
        return ShiftVisualStyle.palette[allocate(shiftId, nearby: usage, previous: last)]
    }

    /// Register a whole list before lazily building its cards, so adjacent
    /// cards get different colours where possible.
    public func registerGroup<S: Sequence>(_ shiftIds: S) where S.Element == String {
        var seen = Set<String>()
        let ids = shiftIds.filter { seen.insert($0).inserted }
        var local = Array(repeating: 0, count: usage.count)
        for id in ids {
            if let slot = known(id) { local[slot] += 1 }
        }
        var previous: Int?
        for id in ids {
            let knownSlot = known(id)
            let slot = knownSlot ?? allocate(id, nearby: local, previous: previous)
            if knownSlot == nil { local[slot] += 1 }
            previous = slot
        }
    }

    /// Picks the least-used slot nearest the preferred one, avoiding the
    /// previous neighbour's slot on a tie. Records the assignment and bumps
    /// the GLOBAL usage once (the caller tracks any local group usage).
    private func allocate(_ id: String, nearby: [Int], previous: Int?) -> Int {
        let count = ShiftVisualStyle.palette.count
        let preferred = ShiftVisualStyle.preferredIndex(id)
        let least = nearby.min() ?? 0
        var candidates = (0..<count)
            .map { (preferred + $0) % count }
            .filter { nearby[$0] == least }
        if candidates.count > 1, let previous, let index = candidates.firstIndex(of: previous) {
            candidates.remove(at: index)
        }
        let slot = candidates[0]
        assigned[id] = slot
        usage[slot] += 1
        last = slot
        onAssigned?(Self.persistenceKey(id), slot)
        return slot
    }
}

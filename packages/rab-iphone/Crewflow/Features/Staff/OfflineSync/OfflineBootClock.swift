import Darwin
import Foundation

/// One reading of the boot clock (docs/plans/m4-offline/DESIGN.md §3.3,
/// §4.2): the boot session id plus milliseconds of Darwin
/// `CLOCK_MONOTONIC_RAW` (the `mach_continuous_time` base), which keeps
/// counting while the phone sleeps and is unaffected by wall-clock changes
/// and by time/frequency adjustment. NOT `ProcessInfo.systemUptime`: that
/// stops in sleep, so an
/// offline clock-in would look EARLIER than it was, which means more pay.
///
/// The phone's wall clock is never an input to an offline punch time. The
/// server anchors the time to its own signed ticket plus this elapsed value
/// and bounds it (§4.3); the phone never computes paid time.
struct OfflineBootReading: Codable, Equatable, Sendable {
    let bootId: String
    let bootMs: Int64

    /// Milliseconds from `earlier` to this reading, or nil when the two
    /// readings come from different boots (a reboot resets the clock, so the
    /// difference would mean nothing).
    func elapsedMs(since earlier: OfflineBootReading) -> Int64? {
        guard bootId == earlier.bootId else { return nil }
        return bootMs - earlier.bootMs
    }
}

protocol OfflineBootClock: AnyObject {
    /// nil when the boot session id cannot be read: offline capture is then
    /// refused (fail closed), never guessed.
    func reading() -> OfflineBootReading?
}

final class SystemOfflineBootClock: OfflineBootClock {
    init() {}

    func reading() -> OfflineBootReading? {
        guard let bootId = Self.bootSessionId() else { return nil }
        let nanos = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
        return OfflineBootReading(bootId: bootId, bootMs: Int64(nanos / 1_000_000))
    }

    /// sysctl `kern.bootsessionuuid`: a new value on every boot, so a reading
    /// taken before a reboot is never compared with one taken after it.
    static func bootSessionId() -> String? {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1, size <= 256 else { return nil }
        // One spare byte so the text is always NUL-terminated.
        var buffer = [CChar](repeating: 0, count: size + 1)
        guard sysctlbyname("kern.bootsessionuuid", &buffer, &size, nil, 0) == 0 else { return nil }
        let text = buffer.withUnsafeBufferPointer { pointer -> String in
            guard let base = pointer.baseAddress else { return "" }
            return String(cString: base)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

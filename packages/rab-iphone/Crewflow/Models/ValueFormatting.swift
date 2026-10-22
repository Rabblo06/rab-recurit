import Foundation

/// Money is always an integer number of pence (CLAUDE.md). Never a Double.
/// Formatting is identical to the Flutter app's `formatPence` /
/// `payRateLabel` / `estimatedPayLabel`
/// (packages/rab-mobile/lib/core/theme/money.dart): `£<pounds>.<pp>`, no
/// thousands separator.
///
/// PARITY NOTE (flagged, not invented): like Flutter, a NEGATIVE amount
/// under £1 loses its sign (-50 → "£0.50") because pounds truncate toward
/// zero. Kept identical deliberately for parity (not verified whether any
/// mobile surface can receive a negative amount). Fix both apps together.
public enum Money {
    public static func formatPence(_ pence: Int64) -> String {
        let pounds = pence / 100
        let remainder = abs(Int(pence % 100))
        return "£\(pounds)." + (remainder < 10 ? "0\(remainder)" : "\(remainder)")
    }

    /// ASSUMPTION carried over from Flutter (display only, flagged to the
    /// owner there): 0 pence means no rate configured → "Rate not set".
    public static func payRateLabel(_ pence: Int64) -> String {
        pence > 0 ? "\(formatPence(pence))/h" : "Rate not set"
    }

    public static func estimatedPayLabel(ratePence: Int64, estimatedPence: Int64) -> String {
        ratePence > 0 ? "\(formatPence(estimatedPence)) estimated pay" : "Estimated pay unavailable"
    }
}

/// Date/time display. All shift times render in Europe/London, the
/// business's operating time zone, regardless of the device's zone.
///
/// ASSUMPTION (flagged): the Flutter app formats with the DEVICE zone
/// (`toLocal()`); for UK-based devices the two are identical. Showing venue
/// (London) time on a phone set to another zone is the safer reading for
/// shift start/end. Change `displayTimeZone` in one place if the owner
/// decides otherwise. Elapsed/worked time is never computed here.
public enum CrewflowDateFormat {
    public static let displayTimeZone = TimeZone(identifier: "Europe/London") ?? .current
    public static let locale = Locale(identifier: "en_GB")

    private static func formatter(_ pattern: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = displayTimeZone
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = pattern
        return formatter
    }

    private static let hourMinute = formatter("HH:mm")
    private static let weekdayDayMonth = formatter("EEE d MMM")
    private static let dayMonth = formatter("d MMM")
    private static let dayMonthYear = formatter("d MMM yyyy")
    private static let dayMonthTime = formatter("d MMM, HH:mm")
    private static let timeWeekdayDayMonth = formatter("HH:mm, EEE d MMM")
    private static let isoDay = formatter("yyyy-MM-dd")

    /// "09:30"
    public static func time(_ date: Date) -> String { hourMinute.string(from: date) }
    /// "Tue 21 Oct"
    public static func weekdayDay(_ date: Date) -> String { weekdayDayMonth.string(from: date) }
    /// "21 Oct"
    public static func day(_ date: Date) -> String { dayMonth.string(from: date) }
    /// "21 Oct 2026"
    public static func fullDay(_ date: Date) -> String { dayMonthYear.string(from: date) }
    /// "21 Oct, 09:30"
    public static func dayTime(_ date: Date) -> String { dayMonthTime.string(from: date) }
    /// "09:30, Tue 21 Oct"
    public static func timeDay(_ date: Date) -> String { timeWeekdayDayMonth.string(from: date) }
    /// "2026-10-21" (London calendar day, for API day keys)
    public static func isoDayKey(_ date: Date) -> String { isoDay.string(from: date) }

    /// "09:00 - 17:00", with " (+1 day)" when the end falls on a later
    /// London calendar day.
    public static func timeRange(_ start: Date, _ end: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = displayTimeZone
        let nextDay = !calendar.isDate(start, inSameDayAs: end)
        return "\(time(start)) - \(time(end))\(nextDay ? " (+1 day)" : "")"
    }
}

/// A date-only value (`"YYYY-MM-DD"`), e.g. payroll `payday` and
/// `period.start/end`, which the server sends as Europe/London calendar
/// days. Decoded separately from instants so it is never shifted by a time
/// zone. Unknown/invalid strings fail decoding (never a guessed day).
public struct CalendarDay: Codable, Hashable, Comparable, Sendable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init?(year: Int, month: Int, day: Int) {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = CrewflowDateFormat.displayTimeZone
        guard (1...12).contains(month), (1...31).contains(day), components.isValidDate(in: calendar) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    public init?(isoString: String) {
        let parts = isoString.split(separator: "-", omittingEmptySubsequences: false)
        guard isoString.count == 10, parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let value = CalendarDay(isoString: raw) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected YYYY-MM-DD")
        }
        self = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    /// "2026-10-21"
    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// Midnight at the start of this day in Europe/London.
    public var startDate: Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = CrewflowDateFormat.displayTimeZone
        return calendar.date(from: DateComponents(year: year, month: month, day: day))
    }

    public static func < (lhs: CalendarDay, rhs: CalendarDay) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }
}

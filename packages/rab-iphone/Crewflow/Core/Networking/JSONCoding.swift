import Foundation

/// The one JSON configuration every request and test uses.
///
/// Dates: the server serialises JavaScript `Date`s with `toISOString()`
/// (`2026-10-21T09:15:30.123Z`) and some PostgreSQL timestamps pass through
/// with more or fewer fraction digits or a numeric offset. All of those
/// parse; anything else is a decoding error (never a silently wrong date).
public enum CrewflowJSON {
    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            guard let date = ISO8601.date(from: raw) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected an ISO-8601 date-time"
                )
            }
            return date
        }
        return decoder
    }

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.string(from: date))
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

/// ISO-8601 parsing with and without fractional seconds.
public enum ISO8601 {
    // ISO8601DateFormatter is documented as thread-safe.
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let whole: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fraction = try! NSRegularExpression(pattern: #"\.(\d+)"#)

    public static func date(from string: String) -> Date? {
        let text = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if let date = fractional.date(from: text) ?? whole.date(from: text) {
            return date
        }
        // Normalise unusual fraction lengths (".5", ".123456789") to
        // milliseconds and retry once.
        let range = NSRange(text.startIndex..., in: text)
        guard let match = fraction.firstMatch(in: text, range: range),
              let digitsRange = Range(match.range(at: 1), in: text),
              let wholeRange = Range(match.range, in: text)
        else { return nil }
        let digits = String(text[digitsRange])
        let millis = String((digits + "000").prefix(3))
        let normalised = text.replacingCharacters(in: wholeRange, with: "." + millis)
        return fractional.date(from: normalised)
    }

    public static func string(from date: Date) -> String {
        fractional.string(from: date)
    }
}

/// A loosely typed JSON value, used for error bodies so a caller can branch
/// on structured fields (`{code, availableAt}`) without a dedicated type.
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// Mirrors Dart's `toString()` of a decoded JSON scalar for message text.
    var displayText: String {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        case .array(let values): return "[" + values.map(\.displayText).joined(separator: ", ") + "]"
        case .object: return "{...}"
        }
    }
}

/// Decoding helper for "any JSON object" response bodies.
struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

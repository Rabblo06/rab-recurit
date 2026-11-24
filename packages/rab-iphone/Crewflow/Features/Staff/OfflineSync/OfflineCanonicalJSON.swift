import Foundation

/// RFC 8785 (JSON Canonicalization Scheme) for the bytes an offline entry's
/// signature covers (DESIGN §6.2): object members sorted by UTF-16 code
/// units, no whitespace, strings escaped like ECMAScript `JSON.stringify`,
/// numbers spelled like ECMAScript `Number.prototype.toString`. The server
/// canonicalises the same way, so any field changed after signing breaks the
/// signature (`SIGNATURE_INVALID`).
enum OfflineCanonicalJSON {
    enum Failure: Error, Equatable {
        case encoding
        case notFinite
    }

    /// Canonical bytes of `value`, without the named top-level members (the
    /// signature itself is never part of what it signs). The value is encoded
    /// with the app's JSON encoder, then read back as `JSONValue`, so member
    /// order and number spelling come only from this canonicaliser.
    static func data<T: Encodable>(_ value: T, excluding excluded: Set<String> = []) throws -> Data {
        let encoded: Data
        do {
            encoded = try CrewflowJSON.makeEncoder().encode(value)
        } catch {
            throw Failure.encoding
        }
        var tree: JSONValue
        do {
            tree = try JSONDecoder().decode(JSONValue.self, from: encoded)
        } catch {
            throw Failure.encoding
        }
        if !excluded.isEmpty, case .object(var members) = tree {
            for key in excluded { members[key] = nil }
            tree = .object(members)
        }
        return Data(try string(tree).utf8)
    }

    static func string(_ value: JSONValue) throws -> String {
        var out = ""
        try write(value, into: &out)
        return out
    }

    private static func write(_ value: JSONValue, into out: inout String) throws {
        switch value {
        case .null:
            out += "null"
        case .bool(let flag):
            out += flag ? "true" : "false"
        case .number(let number):
            out += try self.number(number)
        case .string(let text):
            writeString(text, into: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                try write(item, into: &out)
            }
            out += "]"
        case .object(let members):
            out += "{"
            let keys = members.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (index, key) in keys.enumerated() {
                if index > 0 { out += "," }
                writeString(key, into: &out)
                out += ":"
                try write(members[key] ?? .null, into: &out)
            }
            out += "}"
        }
    }

    /// ECMAScript `Number::toString` for a finite double. Swift's
    /// `description` already gives the shortest digits that round-trip; only
    /// the placement of the decimal point and the exponent differ.
    static func number(_ value: Double) throws -> String {
        guard value.isFinite else { throw Failure.notFinite }
        if value == 0 { return "0" } // also -0
        let negative = value < 0
        let text = "\(abs(value))"
        var mantissa = Substring(text)
        var exponent = 0
        if let marker = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = text[..<marker]
            guard let parsed = Int(text[text.index(after: marker)...]) else { throw Failure.encoding }
            exponent = parsed
        }
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        let integerPart = parts.first.map(String.init) ?? ""
        let fractionPart = parts.count > 1 ? String(parts[1]) : ""
        var digits = integerPart + fractionPart
        // value = 0.<digits> × 10^point
        var point = integerPart.count + exponent
        while digits.hasPrefix("0") {
            digits.removeFirst()
            point -= 1
        }
        while digits.hasSuffix("0") { digits.removeLast() }
        guard !digits.isEmpty else { return "0" }
        let k = digits.count
        let n = point
        let result: String
        if k <= n && n <= 21 {
            result = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let split = digits.index(digits.startIndex, offsetBy: n)
            result = String(digits[..<split]) + "." + String(digits[split...])
        } else if -6 < n && n <= 0 {
            result = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let first = String(digits.prefix(1))
            let rest = String(digits.dropFirst())
            result = first + (rest.isEmpty ? "" : "." + rest) + "e" + (e < 0 ? "-" : "+") + String(abs(e))
        }
        return negative ? "-" + result : result
    }

    private static func writeString(_ text: String, into out: inout String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

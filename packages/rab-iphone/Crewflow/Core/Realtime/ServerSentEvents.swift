import Foundation

/// A line longer than the bound: the stream is malformed (or hostile), so it
/// is dropped and reconnected rather than buffered without limit.
struct SSELineTooLong: Error, Equatable {}

/// Splits a `text/event-stream` byte stream into lines (`\n`, `\r\n` or
/// `\r`), INCLUDING the empty lines that end an event —
/// `URLSession.AsyncBytes.lines` drops those, so it cannot be used for SSE.
struct SSELineSplitter {
    let maxLineBytes: Int
    private var buffer: [UInt8] = []
    private var lastWasCR = false

    init(maxLineBytes: Int = 65_536) {
        self.maxLineBytes = maxLineBytes
    }

    /// Feeds one byte; returns the line it completed, if any.
    mutating func push(_ byte: UInt8) throws -> String? {
        if byte == 0x0A {
            if lastWasCR {
                // The LF of a CRLF: the CR already ended the line.
                lastWasCR = false
                return nil
            }
            return flush()
        }
        lastWasCR = false
        if byte == 0x0D {
            lastWasCR = true
            return flush()
        }
        guard buffer.count < maxLineBytes else { throw SSELineTooLong() }
        buffer.append(byte)
        return nil
    }

    private mutating func flush() -> String {
        let line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        return line
    }
}

/// One dispatched server-sent event.
struct SSEEvent: Equatable, Sendable {
    let type: String
    let data: String
    let id: String?
}

/// The WHATWG event-stream field rules, minus `retry` (the client owns its
/// own backoff): `data` lines join with `\n`, `event` names the type,
/// `id` is kept, comment lines (`: keepalive`) only count as activity, and a
/// blank line dispatches the event if it carried any data.
struct SSEParser {
    private var dataLines: [String] = []
    private var type = ""
    private var id: String?

    init() {}

    mutating func feed(_ line: String) -> SSEEvent? {
        if line.isEmpty {
            let event: SSEEvent? = dataLines.isEmpty
                ? nil
                : SSEEvent(type: type.isEmpty ? "message" : type, data: dataLines.joined(separator: "\n"), id: id)
            dataLines = []
            type = ""
            id = nil
            return event
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "data": dataLines.append(String(value))
        case "event": type = String(value)
        case "id": id = String(value)
        default: break
        }
        return nil
    }
}

/// The realtime envelope (`rab-server` `realtime-envelope.ts`, schema 1).
/// Ids only: an event never carries record data, it only says "go refetch".
struct RealtimeEnvelope: Equatable, Sendable {
    let eventId: String
    let type: String
    let organisationId: String
    let workspaceId: String?
    let targetUserId: String
    let entityId: String
    let occurredAt: Date

    static let schemaVersion = 1

    /// The server's recipient-only catalogue the iOS app acts on (Phase C1b).
    /// `navigation_layout.saved` is a web-console event and is ignored here.
    /// Never ahead of the server's `KNOWN_REALTIME_EVENT_TYPES`.
    static let knownTypes: Set<String> = [
        "offer.sent",
        "offer.accepted",
        "offer.confirmed",
        "offer.declined",
        "offer.withdrawn",
        "offer.expired",
        "offer.rejected",
        "shift.updated",
        "shift.cancelled",
        "shift_request.created",
        "shift_request.approved",
        "shift_request.declined",
        "attendance.changed",
        "notification.created",
        "payroll.record_changed",
    ]

    /// Parses and validates one `data:` payload, or nil for anything that
    /// fails a check (bounded size, JSON object, schema version, UUID ids,
    /// known type, recipient present, ISO time). Never throws: a bad frame
    /// never breaks the stream.
    static func parse(_ raw: String) -> RealtimeEnvelope? {
        guard !raw.isEmpty, raw.utf8.count <= 8192,
              let json = try? JSONSerialization.jsonObject(with: Data(raw.utf8)),
              let object = json as? [String: Any]
        else { return nil }
        guard let version = object["version"] as? Int, version == schemaVersion else { return nil }
        guard let eventId = uuid(object["eventId"]),
              let type = object["type"] as? String, knownTypes.contains(type),
              let organisationId = uuid(object["organisationId"]),
              let entityId = uuid(object["entityId"]),
              let targetUserId = uuid(object["targetUserId"]),
              let occurredText = object["occurredAt"] as? String,
              let occurredAt = ISO8601.date(from: occurredText)
        else { return nil }
        var workspaceId: String?
        if let workspaceValue = object["workspaceId"], !(workspaceValue is NSNull) {
            guard let value = uuid(workspaceValue) else { return nil }
            workspaceId = value
        }
        return RealtimeEnvelope(
            eventId: eventId,
            type: type,
            organisationId: organisationId,
            workspaceId: workspaceId,
            targetUserId: targetUserId,
            entityId: entityId,
            occurredAt: occurredAt
        )
    }

    private static func uuid(_ value: Any?) -> String? {
        guard let text = value as? String, UUID(uuidString: text) != nil else { return nil }
        return text
    }
}

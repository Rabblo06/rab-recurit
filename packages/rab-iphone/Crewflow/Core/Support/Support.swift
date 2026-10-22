import Foundation
import os

/// Logging rules (docs/SECURITY_NOTES.md):
/// - NEVER log access/refresh tokens, Authorization headers, passwords,
///   request/response bodies, presigned storage URLs (their query string IS
///   a credential) or document (PDF) content.
/// - Paths can contain record ids: interpolate them with `privacy: .private`.
/// - Status codes, durations, error codes and method names are public.
public enum Log {
    private static let subsystem = Bundle.main.bundleIdentifier ?? "crewflow"
    public static let network = Logger(subsystem: subsystem, category: "network")
    public static let session = Logger(subsystem: subsystem, category: "session")
    public static let ui = Logger(subsystem: subsystem, category: "ui")
}

/// Runs `operation` with a hard overall deadline (URLRequest's own
/// timeoutInterval is an idle timeout, not a total one). Mirrors Flutter's
/// `.timeout(requestTimeout)` (CF-19): a hung network can never block an
/// action until the app restarts.
enum Deadline {
    static func run<T: Sendable>(
        seconds: TimeInterval,
        timeoutError: APIError,
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                throw timeoutError
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw timeoutError }
            return first
        }
    }
}

/// Per-session scratch directory for downloaded documents (payslip and
/// report PDFs). Purged on sign-out and on account switch so one person's
/// files never remain for the next. Files are written with complete file
/// protection (unreadable while the device is locked).
public final class TemporaryFiles: Sendable {
    public let directory: URL

    public init(directory: URL = FileManager.default.temporaryDirectory.appendingPathComponent("crewflow-session", isDirectory: true)) {
        self.directory = directory
    }

    /// Writes `data` under a sanitised file name and returns its URL.
    public func write(_ data: Data, named name: String) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(Self.sanitised(name), isDirectory: false)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    public func purge() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Strips path separators and control characters; never empty.
    static func sanitised(_ name: String) -> String {
        let disallowed = CharacterSet(charactersIn: "/\\:?%*|\"<>").union(.controlCharacters).union(.newlines)
        let cleaned = name.components(separatedBy: disallowed).joined(separator: "_")
            .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespaces))
        let limited = String(cleaned.prefix(120))
        return limited.isEmpty ? "document" : limited
    }
}

/// `Content-Disposition` filename extraction, same rules as Flutter's
/// `_dispositionFilename` (RFC 5987 `filename*=` first, then `filename=`).
enum ContentDisposition {
    private static let star = try! NSRegularExpression(pattern: #"filename\*=UTF-8''([^;]+)"#, options: [.caseInsensitive])
    private static let plain = try! NSRegularExpression(pattern: #"filename="?([^";]+)"?"#, options: [.caseInsensitive])

    static func filename(from header: String?) -> String? {
        guard let header else { return nil }
        let range = NSRange(header.startIndex..., in: header)
        if let match = star.firstMatch(in: header, range: range), let group = Range(match.range(at: 1), in: header) {
            let raw = header[group].trimmingCharacters(in: .whitespaces)
            return raw.removingPercentEncoding ?? raw
        }
        if let match = plain.firstMatch(in: header, range: range), let group = Range(match.range(at: 1), in: header) {
            return header[group].trimmingCharacters(in: .whitespaces)
        }
        return nil
    }
}

import Foundation

/// The actions that may be saved on the phone (DESIGN §3.1). Nothing else is
/// ever queued: geofence-exit auto clock-out (D14; not built on iPhone),
/// offers, profile and every other action need a connection.
enum OfflinePunchType: String, Codable, CaseIterable, Sendable {
    case checkIn = "check_in"
    case clockIn = "clock_in"
    case breakStart = "break_start"
    case breakEnd = "break_end"
    case clockOut = "clock_out"

    /// Words for the screen ("Clock-in saved on this phone at 09:02").
    var label: String {
        switch self {
        case .checkIn: return "Check-in"
        case .clockIn: return "Clock-in"
        case .breakStart: return "Break start"
        case .breakEnd: return "Break end"
        case .clockOut: return "Clock-out"
        }
    }
}

/// A location fix as evidence (DESIGN §5.1). `fixBootMs` is the boot clock at
/// the fix, so the server judges freshness against the anchored punch time.
struct OfflinePunchLocation: Codable, Equatable, Sendable {
    let lat: Double
    let lng: Double
    let accuracyM: Double
    let fixBootMs: Int64
    let mock: Bool
}

/// Client-asserted signals. A flag on the server receipt only, never a block
/// (D11, §6.4): the client can fake it.
struct OfflinePunchIntegrity: Codable, Equatable, Sendable {
    let rootedSignal: Bool
}

/// One saved action, exactly the DESIGN §3.2 shape and nothing more: the
/// server's DTO refuses any other member with 400 (`forbidNonWhitelisted`).
///
/// Never in an entry: `organisationId`, `workspaceId`, `staffProfileId`,
/// `status`, `clockInAt` / `clockOutAt` or any amount of money. The server
/// derives all of them from the session and its own records. Optional members
/// are omitted from the JSON when nil (never `null`).
struct OfflinePunchEntry: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let v: Int
    /// UUID v4 made on the phone at the tap; the same key as the online
    /// attempt it replaces (D17), so the server never applies it twice.
    let idempotencyKey: String
    /// Per-install counter, strictly increasing, never reused.
    let clientSeq: Int64
    let type: OfflinePunchType
    /// Always present (never "the current shift").
    let shiftId: String
    let ticket: String
    /// Boot session and boot-clock reading when the ticket arrived.
    let bootId: String
    let ticketBootMs: Int64
    /// Boot session and boot-clock reading at the button press.
    let punchBootId: String
    let punchBootMs: Int64
    /// The phone's wall clock at the press: diagnostics for the server's
    /// skew flags only, NEVER used as a time.
    let deviceWallClockAt: String
    /// The scanned QR text verbatim (clock-in / clock-out, as online).
    let qrToken: String?
    let location: OfflinePunchLocation?
    let integrity: OfflinePunchIntegrity
    let appVersion: String
    /// The registered device key that signs this entry.
    let deviceKeyId: String
    /// ES256 over the RFC 8785 canonical JSON of every other member.
    var sig: String

    /// The bytes the signature covers: every member except `sig`.
    func signingInput() throws -> Data {
        try OfflineCanonicalJSON.data(self, excluding: ["sig"])
    }
}

/// Signs an entry's canonical bytes with the registered device key (DESIGN
/// §6.1-6.2: a Secure Enclave P-256 key, ES256, IEEE P1363 r||s, base64url).
///
/// No production implementation exists in this build: device-key
/// registration (`POST /attendance/me/device-key`) is not on the server yet,
/// so the app has no signer and offline capture stays OFF (fail closed). The
/// queue, the entry shape and the canonical bytes are ready for it.
protocol OfflineEntrySigning: AnyObject {
    var deviceKeyId: String { get }
    func signature(for message: Data) throws -> String
}

/// A weak, client-asserted jailbreak signal (DESIGN §6.4): recorded on the
/// server receipt as a flag, never a block. Any result here can be faked by a
/// hooked app; it only helps a manager notice a pattern.
enum OfflineIntegritySignal {
    static let paths = [
        "/Applications/Cydia.app",
        "/Applications/Sileo.app",
        "/Library/MobileSubstrate/MobileSubstrate.dylib",
        "/usr/sbin/sshd",
        "/etc/apt",
        "/private/var/lib/apt",
        "/var/jb",
    ]

    static func rootedSignal(fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Bool {
        #if targetEnvironment(simulator)
        // The simulator shares the Mac's file system; these paths say nothing.
        return false
        #else
        return paths.contains(where: fileExists)
        #endif
    }
}

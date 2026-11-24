import XCTest
@testable import Crewflow

/// RFC 8785 canonical JSON: the bytes the device-key signature covers must be
/// byte-identical to what the server canonicalises, or every entry fails with
/// SIGNATURE_INVALID.
final class OfflineCanonicalJSONTests: XCTestCase {
    /// RFC 8785 Appendix B number samples (ECMAScript Number::toString).
    func testNumbersAreSpelledLikeECMAScript() throws {
        let cases: [(Double, String)] = [
            (0, "0"),
            (-0.0, "0"),
            (1, "1"),
            (-1.5, "-1.5"),
            (100, "100"),
            (0.001, "0.001"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (9007199254740992, "9007199254740992"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.2345e20, "123450000000000000000"),
            (333333333.3333332, "333333333.3333332"),
            (51.4545, "51.4545"),
            (-2.5879, "-2.5879"),
            (1_700_000_123_456, "1700000123456"),
        ]
        for (value, expected) in cases {
            XCTAssertEqual(try OfflineCanonicalJSON.number(value), expected, "\(value)")
        }
    }

    func testNonFiniteNumbersAreRefused() {
        XCTAssertThrowsError(try OfflineCanonicalJSON.number(.nan))
        XCTAssertThrowsError(try OfflineCanonicalJSON.number(.infinity))
    }

    func testMembersAreSortedByUTF16AndStringsEscapedLikeJSONStringify() throws {
        let value: JSONValue = .object([
            "b": .number(2),
            "a": .array([.bool(true), .null, .string("x\"y\\z\n\u{01}é€")]),
            "\u{20AC}": .number(1),
            "A": .object(["z": .number(1), "y": .number(0.5)]),
        ])
        XCTAssertEqual(
            try OfflineCanonicalJSON.string(value),
            "{\"A\":{\"y\":0.5,\"z\":1},\"a\":[true,null,\"x\\\"y\\\\z\\n\\u0001é€\"],\"b\":2,\"\u{20AC}\":1}"
        )
    }

    func testTheSignatureCoversEveryMemberExceptSig() throws {
        var entry = OfflinePunchEntry(
            v: 1, idempotencyKey: "0d6c3c2e-0000-4000-8000-000000000001", clientSeq: 41, type: .clockIn,
            shiftId: "s-1", ticket: "t.t.t", bootId: "boot", ticketBootMs: 123_456_789, punchBootId: "boot",
            punchBootMs: 125_012_345, deviceWallClockAt: "2026-11-21T09:02:11.000Z", qrToken: "qr",
            location: OfflinePunchLocation(lat: 51.5, lng: -0.12, accuracyM: 14, fixBootMs: 125_010_001, mock: false),
            integrity: OfflinePunchIntegrity(rootedSignal: false), appVersion: "2.14.0 (412)", deviceKeyId: "dk", sig: ""
        )
        let unsigned = try entry.signingInput()
        entry.sig = "anything"
        XCTAssertEqual(try entry.signingInput(), unsigned, "sig is never part of what it signs")
        let text = String(decoding: unsigned, as: UTF8.self)
        XCTAssertFalse(text.contains("\"sig\""))
        XCTAssertTrue(text.hasPrefix("{\"appVersion\":\"2.14.0 (412)\",\"bootId\":\"boot\",\"clientSeq\":41,"))
        XCTAssertTrue(text.contains("\"location\":{\"accuracyM\":14,\"fixBootMs\":125010001,\"lat\":51.5,\"lng\":-0.12,\"mock\":false}"))
        XCTAssertFalse(text.contains("\": ") || text.contains(", \""), "no insignificant whitespace")

        let tampered = OfflinePunchEntry(
            v: entry.v, idempotencyKey: entry.idempotencyKey, clientSeq: entry.clientSeq, type: entry.type,
            shiftId: entry.shiftId, ticket: entry.ticket, bootId: entry.bootId, ticketBootMs: entry.ticketBootMs,
            punchBootId: entry.punchBootId, punchBootMs: entry.punchBootMs - 60_000, deviceWallClockAt: entry.deviceWallClockAt,
            qrToken: entry.qrToken, location: entry.location, integrity: entry.integrity, appVersion: entry.appVersion,
            deviceKeyId: entry.deviceKeyId, sig: entry.sig
        )
        XCTAssertNotEqual(try tampered.signingInput(), unsigned, "changing the elapsed time changes the signed bytes")
    }
}

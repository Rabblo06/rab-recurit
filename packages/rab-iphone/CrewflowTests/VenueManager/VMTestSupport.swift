import Foundation
import XCTest
@testable import Crewflow

/// Venue Manager fixtures (CrewflowTests/VenueManager/Fixtures, copied from
/// the server projections in shift-report.service.ts / scheduling and staff
/// controllers) plus small builders for per-row variations.
enum VMFixture {
    static func object(_ name: String) -> [String: Any] {
        // swiftlint:disable:next force_cast
        try! JSONSerialization.jsonObject(with: Fixture.data(name)) as! [String: Any]
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try CrewflowJSON.makeDecoder().decode(type, from: Fixture.data(name))
    }

    static func decode<T: Decodable>(_ type: T.Type, object: Any) throws -> T {
        try CrewflowJSON.makeDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The main report fixture, optionally patched at the top level.
    static func report(_ name: String = "vm_shift_report", patch: (inout [String: Any]) -> Void = { _ in }) throws -> ShiftReportDetail {
        var json = object(name)
        patch(&json)
        return try decode(ShiftReportDetail.self, object: json)
    }

    /// One report row by its fixture position, with field overrides
    /// (`NSNull()` for JSON null).
    static func row(_ index: Int, _ overrides: [String: Any] = [:]) throws -> ShiftReportStaffRow {
        let staff = object("vm_shift_report")["staff"] as? [[String: Any]] ?? []
        var json = staff[index]
        for (key, value) in overrides { json[key] = value }
        return try decode(ShiftReportStaffRow.self, object: json)
    }

    // Fixture positions (vm_shift_report.json).
    static let provisionalNoShow = 0
    static let confirmedNoShow = 1
    static let clockedIn = 2
    static let checkedInOnly = 3
    static let notCheckedIn = 4
    static let recorded = 5

    static let shiftId = "a1b2c3d4-0000-4000-8000-000000000001"
}

func vmRepository() -> VenueManagerRepository {
    VenueManagerRepository(api: makeClient().0)
}

func vmJSON(_ request: URLRequest) -> [String: Any] {
    request.jsonBody ?? [:]
}

extension StubServer {
    /// Requests whose path contains `fragment` (query excluded).
    func requests(containing fragment: String) -> [URLRequest] {
        requests.filter { ($0.url?.path ?? "").contains(fragment) }
    }
}

/// ISO helper for building test dates.
func vmDate(_ text: String) -> Date {
    guard let date = ISO8601.date(from: text) else { fatalError("Bad test date \(text)") }
    return date
}

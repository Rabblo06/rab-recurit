import Foundation
import XCTest
@testable import Crewflow

/// Server-shaped JSON builders for the Staff tests. Field names and value
/// shapes follow docs/API_CONTRACT_MAP.md (§2 AttendanceSummary/CheckInState,
/// §3.1 OfferSummary, §5 payroll, §9 notifications) exactly: ISO instants
/// with milliseconds and `Z`, money as integer pence, payroll days as
/// date-only strings. Optional fields are OMITTED when nil, like an older
/// server would.
enum StaffFixtures {
    static let offerId = "8b0c3f52-1d2e-4a5b-9c6d-7e8f9a0b1c2d"
    static let shiftId = "5d2c7b1e-8f3a-4c6d-9e0f-1a2b3c4d5e6f"
    static let attendanceId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
    static let staffProfileId = "c0ffee00-1111-4222-8333-444455556666"

    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try CrewflowJSON.makeDecoder().decode(type, from: Data(json.utf8))
    }

    static func date(_ iso: String) -> Date {
        guard let date = ISO8601.date(from: iso) else { fatalError("bad fixture date \(iso)") }
        return date
    }

    private static func field(_ key: String, _ value: String?) -> String? {
        value.map { "\"\(key)\":\($0)" }
    }

    private static func quoted(_ value: String?) -> String? {
        value.map { "\"\($0)\"" }
    }

    private static func json(_ fields: [String?]) -> String {
        "{" + fields.compactMap { $0 }.joined(separator: ",") + "}"
    }

    static func presentationJSON(state: String, homeLabel: String = "Today's Shift", isToday: Bool = true, serverNow: String = "2026-10-21T08:00:00.000Z", clockInAt: String? = nil, nextTransitionAt: String? = nil) -> String {
        json([
            field("state", quoted(state)),
            field("homeLabel", quoted(homeLabel)),
            field("isToday", isToday ? "true" : "false"),
            field("serverNow", quoted(serverNow)),
            field("nextTransitionAt", quoted(nextTransitionAt) ?? "null"),
            field("clockInAt", quoted(clockInAt) ?? "null"),
            field("clockOutAt", "null"),
            field("timezone", quoted("Europe/London")),
        ])
    }

    static func offerJSON(
        id: String = offerId,
        shiftId: String = shiftId,
        status: String = "manager_confirmed",
        startsAt: String = "2026-10-21T09:00:00.000Z",
        endsAt: String = "2026-10-21T17:00:00.000Z",
        presentation: String? = presentationJSON(state: "confirmed"),
        payRatePence: Int = 1250,
        estimatedPayPence: Int = 10000,
        checkInRequired: Bool? = nil,
        checkedInAt: String? = nil,
        geofenceEnforced: Bool? = nil,
        offerKind: String? = nil,
        venuePhotoFileId: String? = nil,
        shiftNotes: String? = nil
    ) -> String {
        json([
            field("id", quoted(id)),
            field("status", quoted(status)),
            field("sentAt", quoted("2026-10-19T10:00:00.000Z")),
            field("expiresAt", quoted("2026-10-21T10:00:00.000Z")),
            field("respondedAt", "null"),
            field("declineReason", "null"),
            field("staffAcceptedAt", "null"),
            field("managerConfirmedAt", "null"),
            field("managerRejectedAt", "null"),
            field("rejectionReason", "null"),
            field("estimatedPayPence", String(estimatedPayPence)),
            field("offerBatchId", "null"),
            field("shiftId", quoted(shiftId)),
            field("startsAt", quoted(startsAt)),
            field("endsAt", quoted(endsAt)),
            field("venueName", quoted("Harbour Hall")),
            field("roleName", quoted("Bar Staff")),
            field("staffProfileId", quoted(staffProfileId)),
            field("staffName", quoted("Sam Staff")),
            field("payRatePence", String(payRatePence)),
            field("venueAddress", quoted("1 Quay Street, Bristol")),
            field("shiftNotes", quoted(shiftNotes) ?? "null"),
            field("venuePhotoFileId", quoted(venuePhotoFileId) ?? "null"),
            field("offerKind", quoted(offerKind)),
            field("checkInRequired", checkInRequired.map { $0 ? "true" : "false" }),
            field("checkedInAt", checkedInAt.map { "\"\($0)\"" } ?? (checkInRequired == nil ? nil : "null")),
            field("checkInSource", checkInRequired == nil ? nil : (checkedInAt == nil ? "null" : "\"staff\"")),
            field("geofenceEnforced", geofenceEnforced.map { $0 ? "true" : "false" }),
            field("presentation", presentation ?? "null"),
        ])
    }

    static func attendanceJSON(
        id: String = attendanceId,
        status: String = "clocked_out",
        shiftId: String = shiftId,
        clockInAt: String = "2026-10-21T09:00:00.000Z",
        clockOutAt: String? = "2026-10-21T17:00:00.000Z",
        startsAt: String = "2026-10-21T09:00:00.000Z",
        endsAt: String = "2026-10-21T17:00:00.000Z",
        workedMinutes: Int? = 450,
        payrollStatus: String? = nil,
        payrollApprovedPence: Int? = nil,
        checkInRequired: Bool? = nil
    ) -> String {
        json([
            field("id", quoted(id)),
            field("status", quoted(status)),
            field("clockInAt", quoted(clockInAt)),
            field("clockOutAt", quoted(clockOutAt) ?? "null"),
            field("workedMinutes", workedMinutes.map(String.init) ?? "null"),
            field("earnedPence", workedMinutes.map { String($0 * 20) } ?? "null"),
            field("breakMinutes", "30"),
            field("locationVerified", "true"),
            field("clockOutMethod", clockOutAt == nil ? "null" : "\"manual\""),
            field("shiftId", quoted(shiftId)),
            field("startsAt", quoted(startsAt)),
            field("endsAt", quoted(endsAt)),
            field("venueName", quoted("Harbour Hall")),
            field("roleName", quoted("Bar Staff")),
            field("staffProfileId", quoted(staffProfileId)),
            field("staffName", quoted("Sam Staff")),
            field("venuePhotoFileId", "null"),
            field("payrollStatus", quoted(payrollStatus) ?? "null"),
            field("payrollApprovedPence", payrollApprovedPence.map(String.init) ?? "null"),
            field("clockInMethod", quoted("staff")),
            field("checkInRequired", checkInRequired.map { $0 ? "true" : "false" }),
        ])
    }

    static func activeJSON(attendance: String? = nil, serverNow: String = "2026-10-21T08:00:00.000Z", maxAccuracyM: Int = 100) -> String {
        #"{"attendance":\#(attendance ?? "null"),"serverNow":"\#(serverNow)","clockInEarlyMinutes":15,"locationEvidence":{"maxAccuracyM":\#(maxAccuracyM),"maxAgeSeconds":120,"maxFutureSkewSeconds":30}}"#
    }

    static func checkInStateJSON(
        shiftId: String = shiftId,
        checkInRequired: Bool = true,
        checkedInAt: String? = nil,
        geofenceEnforced: Bool = false,
        opensAt: String = "2026-10-21T08:45:00.000Z",
        serverNow: String = "2026-10-21T08:50:00.000Z",
        alreadyCheckedIn: Bool = false
    ) -> String {
        json([
            field("shiftId", quoted(shiftId)),
            field("checkInRequired", checkInRequired ? "true" : "false"),
            field("checkedInAt", quoted(checkedInAt) ?? "null"),
            field("checkInSource", checkedInAt == nil ? "null" : "\"staff\""),
            field("locationVerified", geofenceEnforced && checkedInAt != nil ? "true" : "false"),
            field("distanceM", geofenceEnforced && checkedInAt != nil ? "12" : "null"),
            field("accuracyM", geofenceEnforced && checkedInAt != nil ? "8" : "null"),
            field("geofenceEnforced", geofenceEnforced ? "true" : "false"),
            field("window", #"{"opensAt":"\#(opensAt)","closesAt":"2026-10-21T19:00:00.000Z"}"#),
            field("clockedIn", "false"),
            field("alreadyCheckedIn", alreadyCheckedIn ? "true" : "false"),
            field("serverNow", quoted(serverNow)),
        ])
    }

    static func statementJSON(id: String, startsAt: String = "2026-10-10T09:00:00.000Z", status: String = "approved", state: String = "available", payday: String? = "2026-10-30") -> String {
        let fileId = state == "available" ? "\"f00d0000-0000-4000-8000-000000000001\"" : "null"
        return #"{"payrollRecordId":"\#(id)","status":"\#(status)","attendanceId":"\#(attendanceId)","shiftId":"\#(shiftId)","venueName":"Harbour Hall","roleName":"Bar Staff","startsAt":"\#(startsAt)","endsAt":"2026-10-10T17:00:00.000Z","workedMinutes":450,"payRatePence":1250,"amountPence":9375,"approvedAt":"2026-10-11T12:00:00.000Z","payrollPeriod":{"id":"p-1","start":"2026-10-05","end":"2026-10-18"},"payday":\#(payday.map { "\"\($0)\"" } ?? "null"),"allocationStatus":"allocated","statement":{"state":"\#(state)","fileId":\#(fileId),"filename":"statement.pdf","generatedAt":null,"notifiedAt":null}}"#
    }
}

/// Identity fence double: the store drops answers when `current` is false.
@MainActor
final class StaffTestFence: StaffSessionFence {
    var epoch: UInt64 = 1
    var current = true
    func isCurrent(_ candidate: UInt64) -> Bool { current && candidate == epoch }
}

/// Location double that records every call (so a test can prove that no
/// location was requested at all).
final class StaffFakeLocation: StaffLocationProviding {
    var status: StaffLocationAuthorization = .authorized
    var fix: StaffRawFix? = StaffRawFix(latitude: 51.4545, longitude: -2.5879, horizontalAccuracy: 12, timestamp: Date())
    private(set) var authorizationCalls = 0
    private(set) var requestCalls = 0
    private(set) var fixCalls = 0

    var totalCalls: Int { authorizationCalls + requestCalls + fixCalls }

    @MainActor func authorization() -> StaffLocationAuthorization {
        authorizationCalls += 1
        return status
    }

    @MainActor func requestWhenInUse() async -> StaffLocationAuthorization {
        requestCalls += 1
        return status
    }

    @MainActor func currentFix() async -> StaffRawFix? {
        fixCalls += 1
        return fix
    }
}

/// Prompt double: fixed answers, records what was shown.
final class StaffFakePrompts: StaffAttendancePrompting {
    var explainAnswer = true
    var confirmAnswer = true
    var token: String? = "venue-qr-token-verbatim"
    private(set) var shown: [String] = []

    @MainActor func explainLocation() async -> Bool { shown.append("explain"); return explainAnswer }
    @MainActor func locationUnavailable() async { shown.append("unavailable") }
    @MainActor func confirmClockOut() async -> Bool { shown.append("confirm"); return confirmAnswer }
    @MainActor func showEarly(availableAt: Date, checkIn: Bool) async { shown.append(checkIn ? "early-checkin" : "early-clockin") }
    @MainActor func scanQR() async -> String? { shown.append("scan"); return token }
}

/// A controllable monotonic clock (nanoseconds).
final class StaffFakeMonotonic {
    var nanos: UInt64 = 1_000_000_000
    func advance(seconds: Double) { nanos += UInt64(seconds * 1_000_000_000) }
}

@MainActor
func makeStaffStore(fence: StaffTestFence? = nil, monotonic: StaffFakeMonotonic = StaffFakeMonotonic()) -> StaffStore {
    // Main-actor default arguments are not allowed, so build the fence here.
    let fence = fence ?? StaffTestFence()
    let (client, _) = makeClient()
    return StaffStore(repository: StaffRepository(api: client), fence: fence, monotonic: { monotonic.nanos })
}

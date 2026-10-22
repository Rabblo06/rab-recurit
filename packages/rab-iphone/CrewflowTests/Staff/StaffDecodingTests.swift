import XCTest
@testable import Crewflow

/// Decoding of the Staff server projections (docs/API_CONTRACT_MAP.md).
final class StaffDecodingTests: XCTestCase {

    // MARK: OfferSummary

    func testOfferSummaryDecodesFullServerShapeWithPresentationCheckInAndOfferKind() throws {
        let json = StaffFixtures.offerJSON(
            presentation: StaffFixtures.presentationJSON(state: "live", homeLabel: "Live Shift", clockInAt: "2026-10-21T09:02:00.000Z", nextTransitionAt: "2026-10-21T19:00:00.000Z"),
            payRatePence: 1250,
            estimatedPayPence: 10000,
            checkInRequired: true,
            checkedInAt: "2026-10-21T08:51:30.123Z",
            geofenceEnforced: true,
            offerKind: "replacement",
            venuePhotoFileId: "b7a1c2d3-0000-4000-8000-000000000123",
            shiftNotes: "Black shirt."
        )
        let offer = try StaffFixtures.decode(StaffOfferSummary.self, json)
        XCTAssertEqual(offer.id, StaffFixtures.offerId)
        XCTAssertEqual(offer.shiftId, StaffFixtures.shiftId)
        XCTAssertEqual(offer.status, "manager_confirmed")
        XCTAssertEqual(offer.payRatePence, 1250)
        XCTAssertEqual(offer.estimatedPayPence, 10000)
        XCTAssertEqual(offer.startsAt, StaffFixtures.date("2026-10-21T09:00:00.000Z"))
        XCTAssertEqual(offer.venueAddress, "1 Quay Street, Bristol")
        XCTAssertEqual(offer.shiftNotes, "Black shirt.")
        XCTAssertEqual(offer.venuePhotoFileId, "b7a1c2d3-0000-4000-8000-000000000123")
        XCTAssertEqual(offer.offerKind, "replacement")
        XCTAssertTrue(offer.checkInRequired)
        XCTAssertEqual(offer.checkedInAt, StaffFixtures.date("2026-10-21T08:51:30.123Z"))
        XCTAssertEqual(offer.checkInSource, "staff")
        XCTAssertEqual(offer.geofenceEnforced, true)
        let presentation = try XCTUnwrap(offer.presentation)
        XCTAssertEqual(presentation.state, "live")
        XCTAssertEqual(presentation.homeLabel, "Live Shift")
        XCTAssertTrue(presentation.isToday)
        XCTAssertEqual(presentation.serverNow, StaffFixtures.date("2026-10-21T08:00:00.000Z"))
        XCTAssertEqual(presentation.clockInAt, StaffFixtures.date("2026-10-21T09:02:00.000Z"))
        XCTAssertEqual(presentation.nextTransitionAt, StaffFixtures.date("2026-10-21T19:00:00.000Z"))
        XCTAssertEqual(presentation.label, "Live")
        XCTAssertEqual(StaffShiftRules.offerKindTag(offer)?.title, "Replacement shift")
    }

    func testOfferFromServerBeforeCheckInMigrationKeepsTheOldFlow() throws {
        // No checkInRequired / checkedInAt / geofenceEnforced / offerKind keys.
        let offer = try StaffFixtures.decode(StaffOfferSummary.self, StaffFixtures.offerJSON(presentation: nil))
        XCTAssertFalse(offer.checkInRequired, "absent → false (old flow), never invented")
        XCTAssertNil(offer.checkedInAt)
        XCTAssertNil(offer.geofenceEnforced, "absent → unknown, so the app keeps asking for location")
        XCTAssertNil(offer.offerKind)
        XCTAssertNil(StaffShiftRules.offerKindTag(offer), "no tag without a server offerKind")
        XCTAssertNil(offer.presentation)
    }

    func testStandardAndStandbyOfferKinds() throws {
        let standard = try StaffFixtures.decode(StaffOfferSummary.self, StaffFixtures.offerJSON(offerKind: "standard"))
        XCTAssertNil(StaffShiftRules.offerKindTag(standard))
        let standby = try StaffFixtures.decode(StaffOfferSummary.self, StaffFixtures.offerJSON(offerKind: "standby"))
        XCTAssertEqual(StaffShiftRules.offerKindTag(standby)?.title, "Standby")
        XCTAssertNotNil(StaffShiftRules.offerKindTag(standby)?.detail)
    }

    func testUnknownStatusAndStateNeverFailTheDecode() throws {
        let offer = try StaffFixtures.decode(
            StaffOfferSummary.self,
            StaffFixtures.offerJSON(status: "some_future_status", presentation: StaffFixtures.presentationJSON(state: "teleported"))
        )
        XCTAssertEqual(offer.status, "some_future_status")
        XCTAssertEqual(offer.presentation?.label, "Updating")
        let state = StaffDetailState.resolve(offer: offer, active: nil, history: [], clockableShiftId: nil, now: nil)
        XCTAssertEqual(state, .error, "an unknown projection is never treated as clockable")
    }

    func testOfferMissingRequiredFieldFailsClosed() {
        let json = StaffFixtures.offerJSON().replacingOccurrences(of: "\"shiftId\":\"\(StaffFixtures.shiftId)\",", with: "")
        XCTAssertThrowsError(try StaffFixtures.decode(StaffOfferSummary.self, json))
    }

    func testOfferListIsAPlainArray() throws {
        let list = "[\(StaffFixtures.offerJSON()),\(StaffFixtures.offerJSON(id: "9d0e1f2a-0000-4000-8000-000000000002", status: "pending", presentation: StaffFixtures.presentationJSON(state: "pending")))]"
        let offers = try StaffFixtures.decode([StaffOfferSummary].self, list)
        XCTAssertEqual(offers.count, 2)
        XCTAssertTrue(offers[1].isPending)
    }

    // MARK: AttendanceSummary

    func testAttendanceSummaryPayrollFieldsAndApprovalGate() throws {
        let approved = try StaffFixtures.decode(
            StaffAttendanceSummary.self,
            StaffFixtures.attendanceJSON(payrollStatus: "approved", payrollApprovedPence: 9375, checkInRequired: true)
        )
        XCTAssertEqual(approved.payrollStatus, "approved")
        XCTAssertEqual(approved.payrollApprovedPence, 9375)
        XCTAssertEqual(approved.workedMinutes, 450)
        XCTAssertEqual(approved.earnedPence, 9000)
        XCTAssertTrue(approved.payrollApproved)
        XCTAssertTrue(approved.checkInRequired)
        XCTAssertEqual(approved.clockInMethod, "staff")
        XCTAssertFalse(approved.isOpen)
        XCTAssertTrue(approved.hasEnded)

        for status in ["processing", "paid"] {
            let row = try StaffFixtures.decode(StaffAttendanceSummary.self, StaffFixtures.attendanceJSON(payrollStatus: status, payrollApprovedPence: 9375))
            XCTAssertTrue(row.payrollApproved, status)
        }
        for status in ["draft", "pending_approval", "rejected", "corrected", "unknown_new_state"] {
            let row = try StaffFixtures.decode(StaffAttendanceSummary.self, StaffFixtures.attendanceJSON(payrollStatus: status))
            XCTAssertFalse(row.payrollApproved, status)
        }
        let none = try StaffFixtures.decode(StaffAttendanceSummary.self, StaffFixtures.attendanceJSON())
        XCTAssertFalse(none.payrollApproved)
        XCTAssertFalse(none.checkInRequired, "absent → false")
    }

    func testOpenAttendance() throws {
        let open = try StaffFixtures.decode(
            StaffAttendanceSummary.self,
            StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil)
        )
        XCTAssertTrue(open.isOpen)
        XCTAssertFalse(open.hasEnded)
        XCTAssertNil(open.clockOutAt)
    }

    func testActiveAttendanceWithLocationEvidence() throws {
        let response = try StaffFixtures.decode(StaffActiveAttendance.self, StaffFixtures.activeJSON(attendance: StaffFixtures.attendanceJSON(status: "clocked_in", clockOutAt: nil, workedMinutes: nil)))
        XCTAssertEqual(response.attendance?.status, "clocked_in")
        XCTAssertEqual(response.serverNow, StaffFixtures.date("2026-10-21T08:00:00.000Z"))
        XCTAssertEqual(response.clockInEarlyMinutes, 15)
        XCTAssertEqual(response.locationEvidence, StaffLocationEvidenceLimits(maxAccuracyM: 100, maxAgeSeconds: 120, maxFutureSkewSeconds: 30))

        let idle = try StaffFixtures.decode(StaffActiveAttendance.self, #"{"attendance":null,"serverNow":"2026-10-21T08:00:00.000Z","clockInEarlyMinutes":-5}"#)
        XCTAssertNil(idle.attendance)
        XCTAssertNil(idle.locationEvidence, "dev server before the check-in migration has no locationEvidence")
        XCTAssertNil(idle.clockInEarlyMinutes, "negative → nil (Flutter)")
    }

    func testCheckInStateDecodes() throws {
        let state = try StaffFixtures.decode(StaffCheckInState.self, StaffFixtures.checkInStateJSON(checkedInAt: "2026-10-21T08:52:00.000Z", geofenceEnforced: true, alreadyCheckedIn: true))
        XCTAssertTrue(state.checkInRequired)
        XCTAssertTrue(state.checkedIn)
        XCTAssertEqual(state.checkInSource, "staff")
        XCTAssertTrue(state.geofenceEnforced)
        XCTAssertTrue(state.locationVerified)
        XCTAssertEqual(state.distanceM, 12)
        XCTAssertEqual(state.opensAt, StaffFixtures.date("2026-10-21T08:45:00.000Z"))
        XCTAssertEqual(state.closesAt, StaffFixtures.date("2026-10-21T19:00:00.000Z"))
        XCTAssertTrue(state.alreadyCheckedIn)
        XCTAssertEqual(state.serverNow, StaffFixtures.date("2026-10-21T08:50:00.000Z"))
    }

    func testTeamAndNotificationsDecode() throws {
        let team = try StaffFixtures.decode([StaffTeamMember].self, #"[{"displayName":"Alex","startsAt":"2026-10-21T09:00:00.000Z","endsAt":"2026-10-21T17:30:00.000Z","isYou":false},{"displayName":"Team member","startsAt":"2026-10-21T09:00:00.000Z","endsAt":"2026-10-21T17:00:00.000Z","isYou":true}]"#)
        XCTAssertEqual(team.map(\.displayName), ["Alex", "Team member"])
        XCTAssertEqual(StaffTeamRules.durationLabel(team[0]), "8h 30m")
        XCTAssertTrue(team[1].isYou)

        let notifications = try StaffFixtures.decode([StaffNotification].self, #"[{"id":"n1","organisationId":"o1","userId":"u1","type":"offer_sent","title":"New shift offer","message":"You have a new offer.","relatedEntityType":"job_offer","relatedEntityId":"x","channelState":{},"readAt":null,"createdAt":"2026-10-21T08:00:00.000Z"}]"#)
        XCTAssertTrue(notifications[0].isUnread)
        XCTAssertEqual(try StaffFixtures.decode(StaffUnreadCount.self, #"{"count":3}"#).count, 3)
    }

    // MARK: Payroll (date-only days)

    func testStatementsDecodeDateOnlyPaydayAndPeriod() throws {
        let page = try StaffFixtures.decode(StaffStatementsPage.self, #"{"data":[\#(StaffFixtures.statementJSON(id: "r1")),\#(StaffFixtures.statementJSON(id: "r2", state: "processing", payday: nil))],"total":2}"#)
        XCTAssertEqual(page.total, 2)
        let available = page.data[0]
        XCTAssertEqual(available.payday, CalendarDay(year: 2026, month: 10, day: 30))
        XCTAssertEqual(available.payrollPeriod?.start, CalendarDay(year: 2026, month: 10, day: 5))
        XCTAssertEqual(available.payrollPeriod?.label, "5 – 18 Oct 2026")
        XCTAssertEqual(available.amountPence, 9375)
        XCTAssertTrue(available.isAvailable)
        XCTAssertEqual(available.documentFileId, "f00d0000-0000-4000-8000-000000000001")
        XCTAssertEqual(StaffPayrollRules.paydayText(available.payday), "Payday 30 Oct 2026")

        let preparing = page.data[1]
        XCTAssertNil(preparing.payday)
        XCTAssertFalse(preparing.isAvailable, "a file id is only usable when the statement is available")
        XCTAssertEqual(StaffPayrollRules.statementAction(preparing), "Preparing…")
        XCTAssertEqual(StaffPayrollRules.paydayText(preparing.payday), "Payday to be confirmed")
    }

    func testPayslipsDecodeWithoutTimeZoneShift() throws {
        let body = #"""
        {"data":[
          {"payslipId":"ps1","runId":"run1","period":{"id":"p1","start":"2026-09-28","end":"2026-10-11"},"payday":"2026-10-24","status":"paid","shiftCount":5,"grossPence":48000,"netPence":41234,"netSource":"provider_document","document":{"fileId":"f1","filename":"payslip.pdf","version":1,"uploadedAt":"2026-10-20T10:00:00.000Z"},"paidAt":"2026-10-24T09:00:00.000Z"},
          {"payslipId":null,"runId":null,"period":{"id":"p2","start":"2026-12-21","end":"2027-01-03"},"payday":"2027-01-09","status":"upcoming","shiftCount":0,"grossPence":0,"netPence":null,"netSource":null,"document":null,"paidAt":null}
        ],"unallocated":{"shiftCount":1,"grossPence":9375}}
        """#
        let payslips = try StaffFixtures.decode(StaffPayslipsResponse.self, body).data
        XCTAssertEqual(payslips[0].payday, CalendarDay(year: 2026, month: 10, day: 24))
        XCTAssertEqual(payslips[0].period.label, "28 Sep – 11 Oct 2026")
        XCTAssertEqual(payslips[0].netPence, 41234)
        XCTAssertTrue(payslips[0].hasDocument)
        XCTAssertEqual(StaffFormat.day(payslips[0].payday), "24 Oct")
        XCTAssertEqual(payslips[1].period.label, "21 Dec 2026 – 3 Jan 2027")
        XCTAssertNil(payslips[1].netPence, "net pay only ever comes from the provider document")
        XCTAssertFalse(payslips[1].hasDocument)
        XCTAssertEqual(StaffPayrollRules.nextPayday(payslips), CalendarDay(year: 2027, month: 1, day: 9))
        XCTAssertEqual(StaffPayrollRules.pill("paid").label, "Paid")
        XCTAssertEqual(StaffPayrollRules.pill("approved").label, "Approved")
    }

    func testInvalidPaydayFailsClosed() {
        let body = #"{"data":[{"period":{"start":"2026-09-28","end":"2026-10-11"},"payday":"24/10/2026","status":"paid"}]}"#
        XCTAssertThrowsError(try StaffFixtures.decode(StaffPayslipsResponse.self, body))
    }

    // MARK: Request bodies

    func testCheckInBodyWithoutLocationSendsOnlyTheShiftId() throws {
        let data = try CrewflowJSON.makeEncoder().encode(StaffCheckInBody(shiftId: StaffFixtures.shiftId, location: nil))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["shiftId"], "no qrToken on Check In and no null location fields")
    }

    func testClockBodiesCarryTheTokenVerbatimAndAnOffsetTimestamp() throws {
        let fix = StaffLocationFix(lat: 51.45, lng: -2.58, accuracyM: 9.5, capturedAt: StaffFixtures.date("2026-10-21T08:59:58.000Z"))
        let token = "eyJhbGciOiJIUzI1NiJ9.e30.signature-with_odd/chars+="
        let clockIn = try XCTUnwrap(JSONSerialization.jsonObject(with: CrewflowJSON.makeEncoder().encode(StaffClockInBody(shiftId: StaffFixtures.shiftId, qrToken: token, location: fix))) as? [String: Any])
        XCTAssertEqual(clockIn["qrToken"] as? String, token)
        XCTAssertEqual(clockIn["lat"] as? Double, 51.45)
        XCTAssertEqual(clockIn["accuracyM"] as? Double, 9.5)
        XCTAssertEqual(clockIn["capturedAt"] as? String, "2026-10-21T08:59:58.000Z", "UTC with Z, seconds included")
        let clockOut = try XCTUnwrap(JSONSerialization.jsonObject(with: CrewflowJSON.makeEncoder().encode(StaffClockOutBody(qrToken: token, location: nil))) as? [String: Any])
        XCTAssertEqual(Set(clockOut.keys), ["qrToken"], "clock-out never sends a shiftId")
    }
}

import XCTest
@testable import Crewflow

/// Teams on-behalf eligibility: a DISPLAY HINT mirror of the server rules
/// (blocked before Check In, unverified check-in at an enforcing venue,
/// clock-out refused where location is enforced, ≥ 10-word reasons). The
/// server stays the authority; these only decide what is offered/sent.
final class VMOnBehalfEligibilityTests: XCTestCase {
    func testActionOfferedOnlyWithEditPermissionAndNotFinalised() throws {
        let eve = try VMFixture.row(VMFixture.notCheckedIn)
        XCTAssertEqual(teamRowAction(eve, canEdit: true, finalised: false), .clockIn)
        XCTAssertNil(teamRowAction(eve, canEdit: false, finalised: false), "no attendance.edit → no button")
        XCTAssertNil(teamRowAction(eve, canEdit: true, finalised: true), "finalised report → no button")
        XCTAssertEqual(teamRowAction(try VMFixture.row(VMFixture.clockedIn), canEdit: true, finalised: false), .clockOut)
        XCTAssertNil(teamRowAction(try VMFixture.row(VMFixture.provisionalNoShow), canEdit: true, finalised: false), "no-show seat")
        XCTAssertNil(teamRowAction(try VMFixture.row(VMFixture.recorded), canEdit: true, finalised: false), "attendance exists")
    }

    func testClockInBlockedBeforeTheStaffMemberChecksIn() throws {
        let report = try VMFixture.report()
        let eve = try VMFixture.row(VMFixture.notCheckedIn)
        let block = try XCTUnwrap(onBehalfPrecheck(eve, action: .clockIn, policy: report.attendancePolicy))
        XCTAssertEqual(block.panelTitle, "Staff hasn't checked in yet")
        XCTAssertEqual(block.panelMessage, "Eve must check in before you can clock them in.")
        XCTAssertFalse(block.offersReport)
    }

    func testClockInBlockedForUnverifiedCheckInAtEnforcingVenue() throws {
        let report = try VMFixture.report()
        let dan = try VMFixture.row(VMFixture.checkedInOnly)
        XCTAssertEqual(onBehalfPrecheck(dan, action: .clockIn, policy: report.attendancePolicy)?.panelTitle, "Check-in not location-verified")
        let relaxed = ReportAttendancePolicy(geofenceEnforced: false, onBehalfClockOutAllowed: true)
        XCTAssertNil(onBehalfPrecheck(dan, action: .clockIn, policy: relaxed), "non-enforcing venue: the reason sheet opens")
    }

    func testClockOutOnBehalfRefusedWhereLocationIsEnforcedAndGuidesToRecordAttendance() throws {
        let report = try VMFixture.report()
        let cara = try VMFixture.row(VMFixture.clockedIn)
        let block = try XCTUnwrap(onBehalfPrecheck(cara, action: .clockOut, policy: report.attendancePolicy))
        XCTAssertTrue(block.offersReport, "offers Review staff report → Record attendance")
        XCTAssertNil(onBehalfPrecheck(cara, action: .clockOut, policy: nil), "older server without a policy: the server decides")
    }

    func testReasonWordCountMatchesServerRule() {
        XCTAssertEqual(reasonWordCount("- - - - - - - - - - -"), 0, "punctuation is not a reason")
        XCTAssertEqual(reasonWordCount("  Phone   died\nat the door  "), 5)
        XCTAssertEqual(reasonWordCount("Téléphone mort à l'entrée 2 fois"), 6, "letters and digits in any script")
        let nine = "one two three four five six seven eight nine"
        XCTAssertFalse(onBehalfReasonAccepted(nine, policy: nil))
        XCTAssertTrue(onBehalfReasonAccepted(nine + " ten", policy: nil))
        let stricter = ReportAttendancePolicy(geofenceEnforced: false, onBehalfClockOutAllowed: true, onBehalfReasonMinWords: 12)
        XCTAssertFalse(onBehalfReasonAccepted(nine + " ten eleven", policy: stricter), "server-sent minimum wins")
    }

    func testManagerMessagesPreferUserFacingServerTextThenCodeWording() {
        let presence = APIError.conflict(ServerErrorPayload(message: "Clock-out on behalf is not available at this venue.", code: "PRESENCE_EVIDENCE_REQUIRED"))
        XCTAssertEqual(VMAttendanceMessages.forManager(presence), "Clock-out on behalf is not available at this venue.")
        XCTAssertTrue(VMAttendanceMessages.guidesToRecordAttendance(presence))
        let technical = APIError.conflict(ServerErrorPayload(message: "staff_not_checked_in", code: "STAFF_NOT_CHECKED_IN"))
        XCTAssertEqual(VMAttendanceMessages.forManager(technical), VMAttendanceMessages.manager["STAFF_NOT_CHECKED_IN"])
        XCTAssertEqual(VMAttendanceMessages.forManager(APIError.server(status: 500)), APIMessages.serverError)
        XCTAssertFalse(VMAttendanceMessages.guidesToRecordAttendance(technical))
    }

    func testPolicyRefusalSurfacesAsCodeAndIsNotRetried() async throws {
        URLProtocolStub.server.reset()
        URLProtocolStub.server.setHandler { _ in
            .json(409, #"{"code":"PRESENCE_EVIDENCE_REQUIRED","message":"This venue requires location for clock-out."}"#)
        }
        let repository = vmRepository()
        do {
            _ = try await repository.clockOutOnBehalf(shiftId: VMFixture.shiftId, staffProfileId: "b0000000-0000-4000-8000-00000000000c",
                                                      reason: "  one two three four five six seven eight nine ten  ")
            XCTFail("expected the policy refusal")
        } catch {
            XCTAssertEqual((error as? APIError)?.code, "PRESENCE_EVIDENCE_REQUIRED")
            XCTAssertTrue(VMAttendanceMessages.guidesToRecordAttendance(error))
        }
        let sent = URLProtocolStub.server.requests(containing: "/clock-out-on-behalf")
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.url?.path, "/rest/v1/attendance/report/shift/\(VMFixture.shiftId)/staff/b0000000-0000-4000-8000-00000000000c/clock-out-on-behalf")
        XCTAssertEqual(vmJSON(sent[0])["reason"] as? String, "one two three four five six seven eight nine ten", "trimmed")
        XCTAssertEqual(Set(vmJSON(sent[0]).keys), ["reason"], "no organisationId, status or any undeclared field")
    }

    func testClockInOnBehalfUncertainOutcomeIsNeverResent() async throws {
        URLProtocolStub.server.reset()
        URLProtocolStub.server.setHandler { _ in .json(503, #"{"message":"Service unavailable"}"#) }
        do {
            _ = try await vmRepository().clockInOnBehalf(shiftId: VMFixture.shiftId, staffProfileId: "b0000000-0000-4000-8000-00000000000d",
                                                         reason: "one two three four five six seven eight nine ten")
            XCTFail("expected 503")
        } catch {
            XCTAssertTrue((error as? APIError)?.isUncertainOutcome == true)
        }
        XCTAssertEqual(URLProtocolStub.server.requests(containing: "/clock-in-on-behalf").count, 1, "NOT replay-safe: never retried")
    }
}

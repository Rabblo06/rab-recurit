import XCTest
@testable import Crewflow

/// Owner brief 2026-11-15 ("Compact attendance correction warning"): the
/// server refuses a corrected clock-in earlier than the seat's start minus
/// CLOCK_IN_EARLY_MINUTES with 409 `CLOCK_IN_CONFIRMATION_REQUIRED` unless
/// `confirmUnusualClockIn: true` is sent. The review screen shows the same
/// system alert as "Confirm no-show" (Edit / Confirm); these tests cover the
/// pieces it is built from: parsing, the two displayed values, the
/// unchanged ordinary body and the confirmed resend.
final class VMUnusualClockInTests: XCTestCase {
    private let reason = "Staff arrived early; start confirmed by the manager."
    private let refusal = #"""
    {"statusCode":409,"code":"CLOCK_IN_CONFIRMATION_REQUIRED",
     "message":"This time is earlier than the normal allowance. Please check before continuing.",
     "earliestAllowed":"2026-10-16T07:45:00.000Z","enteredTime":"2026-10-16T04:00:00.000Z"}
    """#

    private func conflict(_ json: String, status: Int = 409) -> APIError {
        let payload = ServerErrorPayload.parse(Data(json.utf8))
        return status == 409 ? .conflict(payload) : .validation(status: status, payload)
    }

    func testOnlyTheConfirmationRefusalWithBothTimesOpensTheWarning() {
        let warning = UnusualClockInWarning.from(conflict(refusal))
        XCTAssertEqual(warning?.earliestAllowed, vmDate("2026-10-16T07:45:00Z"))
        XCTAssertEqual(warning?.enteredTime, vmDate("2026-10-16T04:00:00Z"))
        XCTAssertNil(UnusualClockInWarning.from(conflict(refusal, status: 422)), "only the 409")
        XCTAssertNil(UnusualClockInWarning.from(conflict(#"{"code":"INVALID_CLOCK_OUT_TIME","reason":"in_future","message":"x"}"#)))
        XCTAssertNil(UnusualClockInWarning.from(conflict(#"{"code":"CLOCK_IN_CONFIRMATION_REQUIRED","message":"x"}"#)),
                     "without both times there is nothing to show: the ordinary error path")
        XCTAssertNil(UnusualClockInWarning.from(APIError.offline))
    }

    func testTheWarningShowsOnlyTheTwoTimes() throws {
        // 07:45Z / 04:00Z are 08:45 / 05:00 in London (BST) — the app's display zone.
        let warning = try XCTUnwrap(UnusualClockInWarning.from(conflict(refusal)))
        XCTAssertEqual(UnusualClockInWarning.title, "Unusual clock-in time")
        XCTAssertEqual(UnusualClockInWarning.message, "This time is earlier than the normal allowance. Please check before continuing.")
        XCTAssertEqual(warning.summary, "Earliest allowed: 08:45\nEntered time: 05:00")
        // On different days a bare time would mislead: both get the day.
        let previousEvening = UnusualClockInWarning(earliestAllowed: vmDate("2026-10-16T07:45:00Z"),
                                                    enteredTime: vmDate("2026-10-15T22:00:00Z"))
        XCTAssertEqual(previousEvening.summary, "Earliest allowed: Fri 16 Oct, 08:45\nEntered time: Thu 15 Oct, 23:00")
    }

    func testOrdinaryCorrectionIsUnchangedAndConfirmResendsTheSameDraftConfirmed() throws {
        let row = try VMFixture.row(VMFixture.recorded)
        var draft = CorrectionDraft(row: row)
        XCTAssertEqual(draft.field, .clockInAt)
        draft.reason = reason
        draft.value = vmDate("2026-10-21T13:00:00Z") // 14:00 London, well before this seat's start
        let ordinary = CorrectAttendanceBody(field: "clockInAt", newValue: "2026-10-21T13:00:00.000Z", reason: reason)
        XCTAssertEqual(draft.build(row: row), .body(ordinary))
        let before = draft
        var confirmed = ordinary
        confirmed.confirmUnusualClockIn = true
        XCTAssertEqual(draft.build(row: row, confirmUnusualClockIn: true), .body(confirmed))
        XCTAssertEqual(draft, before, "building never changes what the manager typed (Edit returns to the same form)")
        // Never attached to another field.
        draft.select(.breakMinutes, row: row)
        draft.breakText = "30"
        XCTAssertEqual(draft.build(row: row, confirmUnusualClockIn: true),
                       .body(CorrectAttendanceBody(field: "breakMinutes", newValue: "30", reason: reason)))
    }

    func testOnTheWireRefusedWithoutConfirmationSavedWithItEachSentOnce() async throws {
        URLProtocolStub.server.reset()
        let refusal = self.refusal
        URLProtocolStub.server.setHandler { request in
            request.jsonBody?["confirmUnusualClockIn"] as? Bool == true ? .json(201, "{}") : .json(409, refusal)
        }
        let repository = vmRepository()
        let attendanceId = "c0000000-0000-4000-8000-00000000000c"
        let ordinary = CorrectAttendanceBody(field: "clockInAt", newValue: "2026-10-16T04:00:00.000Z", reason: reason)
        do {
            try await repository.correctAttendance(attendanceId: attendanceId, body: ordinary)
            XCTFail("expected the confirmation refusal")
        } catch {
            XCTAssertNotNil(UnusualClockInWarning.from(error))
        }
        var confirmed = ordinary
        confirmed.confirmUnusualClockIn = true
        try await repository.correctAttendance(attendanceId: attendanceId, body: confirmed)

        let sent = URLProtocolStub.server.requests(containing: "/correct")
        XCTAssertEqual(sent.count, 2, "one refused request, one confirmed resend; never auto-retried")
        let first = vmJSON(sent[0]), second = vmJSON(sent[1])
        XCTAssertEqual(Set(first.keys), ["field", "newValue", "reason"], "an ordinary body carries no confirmation key")
        XCTAssertEqual(second["confirmUnusualClockIn"] as? Bool, true)
        XCTAssertEqual(second["newValue"] as? String, first["newValue"] as? String)
        XCTAssertEqual(second["reason"] as? String, first["reason"] as? String)
    }

    // MARK: Owner decisions 2026-11-15: Record attendance, the 12-hour floor, the report flag

    func testRecordAttendanceBodyIsUnchangedUntilConfirmed() throws {
        var draft = RecordAttendanceDraft(row: try VMFixture.row(VMFixture.provisionalNoShow))
        draft.clockIn = vmDate("2026-10-21T13:00:00Z")
        draft.clockOut = vmDate("2026-10-22T00:50:00Z")
        draft.breakText = "30"
        draft.reason = .forgotClockIn
        let now = vmDate("2026-10-22T02:15:30.000Z")
        let ordinary = try XCTUnwrap(draft.body(expectedVersion: nil, now: now))
        XCTAssertNil(ordinary.confirmUnusualClockIn)
        let confirmed = try XCTUnwrap(draft.body(expectedVersion: nil, now: now, confirmUnusualClockIn: true))
        XCTAssertEqual(confirmed.confirmUnusualClockIn, true)
        XCTAssertEqual(confirmed.clockInAt, ordinary.clockInAt)
        XCTAssertEqual(confirmed.clockOutAt, ordinary.clockOutAt)
        XCTAssertEqual(confirmed.reasonCode, ordinary.reasonCode)
    }

    func testRecordAttendanceOnTheWireRefusedThenConfirmed() async throws {
        URLProtocolStub.server.reset()
        let refusal = self.refusal
        URLProtocolStub.server.setHandler { request in
            request.jsonBody?["confirmUnusualClockIn"] as? Bool == true ? .fixture("vm_shift_report") : .json(409, refusal)
        }
        let body = RecordAttendanceBody(clockInAt: vmDate("2026-10-21T13:00:00Z"), clockOutAt: vmDate("2026-10-22T00:50:00Z"),
                                        breakMinutes: 30, reasonCode: "forgot_clock_in", reasonNote: nil, expectedVersion: nil)
        do {
            _ = try await vmRepository().recordAttendance(shiftId: VMFixture.shiftId, staffProfileId: "b0000000-0000-4000-8000-00000000000a", body: body)
            XCTFail("expected the confirmation refusal")
        } catch {
            XCTAssertNotNil(UnusualClockInWarning.from(error), "the record sheet shows the same warning")
        }
        var confirmed = body
        confirmed.confirmUnusualClockIn = true
        _ = try await vmRepository().recordAttendance(shiftId: VMFixture.shiftId, staffProfileId: "b0000000-0000-4000-8000-00000000000a", body: confirmed)
        let sent = URLProtocolStub.server.requests(containing: "/record-attendance")
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(Set(vmJSON(sent[0]).keys), ["clockInAt", "clockOutAt", "breakMinutes", "reasonCode"], "no confirmation key before Confirm")
        XCTAssertEqual(vmJSON(sent[1])["confirmUnusualClockIn"] as? Bool, true)
    }

    func testBeyondTheHardFloorIsAnErrorMessageNeverTheWarning() {
        let floor = #"{"statusCode":422,"code":"CLOCK_IN_TOO_EARLY_ABSOLUTE","message":"The clock-in time cannot be more than 12 hours before the scheduled start.","earliestPossible":"2026-10-21T04:45:00.000Z"}"#
        let error = conflict(floor, status: 422)
        XCTAssertNil(UnusualClockInWarning.from(error), "never the confirmation dialog")
        XCTAssertEqual(error.code, "CLOCK_IN_TOO_EARLY_ABSOLUTE")
        XCTAssertEqual(userMessage(for: error), "The clock-in time cannot be more than 12 hours before the scheduled start.")
    }

    func testReportRowCarriesTheServerFlag() throws {
        XCTAssertTrue(try VMFixture.row(VMFixture.recorded, ["unusualClockInConfirmed": true]).unusualClockInConfirmed)
        XCTAssertFalse(try VMFixture.row(VMFixture.recorded, ["unusualClockInConfirmed": false]).unusualClockInConfirmed)
        XCTAssertFalse(try VMFixture.row(VMFixture.recorded).unusualClockInConfirmed, "an older server without the field: not flagged")
    }
}

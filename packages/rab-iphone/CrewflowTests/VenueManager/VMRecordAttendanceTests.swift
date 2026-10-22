import XCTest
@testable import Crewflow

/// Record attendance: no pre-filled times, reason rules, `expectedVersion`
/// echoed unchanged, exact request body, never auto-retried.
final class VMRecordAttendanceTests: XCTestCase {
    private let serverNow = vmDate("2026-10-22T02:15:30.000Z")

    func testMissingAttendanceStartsWithEmptyTimesNeverTheSchedule() throws {
        let amy = try VMFixture.row(VMFixture.provisionalNoShow)
        let draft = RecordAttendanceDraft(row: amy)
        XCTAssertNil(draft.clockIn, "never pre-filled with scheduledStart")
        XCTAssertNil(draft.clockOut, "never pre-filled with scheduledEnd")
        XCTAssertNil(draft.reason)
        XCTAssertEqual(draft.breakText, "30", "the scheduled break is the starting value")
        let errors = draft.validate(now: serverNow)
        XCTAssertEqual(errors[.clockIn], "Select the actual clock-in date and time.")
        XCTAssertEqual(errors[.clockOut], "Select the actual clock-out date and time.")
        XCTAssertEqual(errors[.reason], "Select a reason.")
        XCTAssertNil(draft.body(expectedVersion: nil, now: serverNow), "an invalid draft never builds a body")
    }

    func testOtherReasonNeedsTenCharacterExplanation() throws {
        var draft = RecordAttendanceDraft(row: try VMFixture.row(VMFixture.provisionalNoShow))
        draft.clockIn = vmDate("2026-10-21T17:10:00Z")
        draft.clockOut = vmDate("2026-10-22T00:50:00Z")
        draft.reason = .other
        draft.note = "  too short"
        XCTAssertEqual(draft.validate(now: serverNow)[.note], "Explain the reason in at least 10 characters.")
        draft.note = "Venue tablet was offline all evening"
        XCTAssertTrue(draft.validate(now: serverNow).isEmpty)
    }

    func testTimeOrderBreakAndFutureChecks() throws {
        var draft = RecordAttendanceDraft(row: try VMFixture.row(VMFixture.provisionalNoShow))
        draft.reason = .forgotClockIn
        draft.clockIn = vmDate("2026-10-21T22:00:00Z")
        draft.clockOut = vmDate("2026-10-21T21:00:00Z")
        XCTAssertNotNil(draft.validate(now: serverNow)[.clockOut], "out must follow in")
        draft.clockOut = vmDate("2026-10-21T22:20:00Z")
        draft.breakText = "20"
        XCTAssertEqual(draft.validate(now: serverNow)[.breakMinutes], "The break must be shorter than the time between clock-in and clock-out.")
        draft.breakText = "-1"
        XCTAssertEqual(draft.validate(now: serverNow)[.breakMinutes], "Enter the break in whole minutes.")
        draft.breakText = "5"
        draft.clockOut = vmDate("2026-10-22T03:00:00Z")
        XCTAssertEqual(draft.validate(now: serverNow)[.clockOut], "The clock-out time cannot be in the future.", "judged against SERVER time")
        XCTAssertNil(draft.validate(now: nil)[.clockOut], "no server time → the server alone decides")
    }

    func testBodyEchoesVersionAndSendsNoteOnlyForOther() throws {
        let finn = try VMFixture.row(VMFixture.recorded)
        var draft = RecordAttendanceDraft(row: finn)
        XCTAssertEqual(draft.clockIn, finn.clockInAt, "an existing recorded value is shown as it is")
        draft.reason = .forgotClockOut
        draft.note = "ignored for this reason code"
        let body = try XCTUnwrap(draft.body(expectedVersion: finn.attendanceVersion, now: serverNow))
        XCTAssertEqual(body.expectedVersion, "2026-10-22 01:10:09.987654+00")
        XCTAssertNil(body.reasonNote)
        XCTAssertEqual(body.reasonCode, "forgot_clock_out")
        XCTAssertEqual(body.breakMinutes, 30)
    }

    func testRequestBodyOnTheWireAndNeverRetried() async throws {
        URLProtocolStub.server.reset()
        URLProtocolStub.server.setHandler { _ in .failure(.timedOut) }
        var draft = RecordAttendanceDraft(row: try VMFixture.row(VMFixture.provisionalNoShow))
        draft.clockIn = vmDate("2026-10-21T17:10:00Z")
        draft.clockOut = vmDate("2026-10-22T00:50:00Z")
        draft.breakText = "30"
        draft.reason = .other
        draft.note = "  Venue tablet was offline all evening  "
        let body = try XCTUnwrap(draft.body(expectedVersion: nil, now: serverNow))
        do {
            _ = try await vmRepository().recordAttendance(shiftId: VMFixture.shiftId, staffProfileId: "b0000000-0000-4000-8000-00000000000a", body: body)
            XCTFail("expected a timeout")
        } catch {
            XCTAssertTrue((error as? APIError)?.isUncertainOutcome == true, "callers reload, never resend")
        }
        let sent = URLProtocolStub.server.requests(containing: "/record-attendance")
        XCTAssertEqual(sent.count, 1, "record-attendance is never auto-retried")
        let json = vmJSON(try XCTUnwrap(sent.first))
        XCTAssertEqual(json["clockInAt"] as? String, "2026-10-21T17:10:00.000Z", "UTC with Z and seconds")
        XCTAssertEqual(json["clockOutAt"] as? String, "2026-10-22T00:50:00.000Z")
        XCTAssertEqual(json["breakMinutes"] as? Int, 30)
        XCTAssertEqual(json["reasonCode"] as? String, "other")
        XCTAssertEqual(json["reasonNote"] as? String, "Venue tablet was offline all evening")
        XCTAssertNil(json["expectedVersion"], "no attendance seen → key omitted (Flutter parity)")
        XCTAssertEqual(Set(json.keys), ["clockInAt", "clockOutAt", "breakMinutes", "reasonCode", "reasonNote"])
    }

    func testRecordAttendanceErrorsKeepTheirCode() async throws {
        URLProtocolStub.server.reset()
        URLProtocolStub.server.setHandler { _ in
            .json(409, #"{"statusCode":409,"message":"This attendance was changed by someone else. Refresh and try again."}"#)
        }
        let body = RecordAttendanceBody(clockInAt: vmDate("2026-10-21T17:10:00Z"), clockOutAt: nil, breakMinutes: 30,
                                        reasonCode: "forgot_clock_out", reasonNote: nil, expectedVersion: "2026-10-22 01:10:09.987654+00")
        do {
            _ = try await vmRepository().recordAttendance(shiftId: VMFixture.shiftId, staffProfileId: "b0000000-0000-4000-8000-00000000000f", body: body)
            XCTFail("expected 409")
        } catch {
            XCTAssertEqual(userMessage(for: error), "This attendance was changed by someone else. Refresh and try again.")
        }
        let json = vmJSON(try XCTUnwrap(URLProtocolStub.server.requests(containing: "/record-attendance").first))
        XCTAssertEqual(json["expectedVersion"] as? String, "2026-10-22 01:10:09.987654+00", "echoed byte-for-byte")
    }
}

final class VMCorrectionAndReviewDraftTests: XCTestCase {
    func testCorrectionStartsOnMissingClockOutWithNoValue() throws {
        let partial = try VMFixture.row(VMFixture.clockedIn, ["attendanceStatus": "missing_clock_out"])
        let draft = CorrectionDraft(row: partial)
        XCTAssertEqual(draft.field, .clockOutAt)
        XCTAssertNil(draft.value, "never pre-filled")
        XCTAssertEqual(draft.build(row: partial), .invalid("Please explain this change in at least 10 characters."))
    }

    func testCorrectionOrderAndBody() throws {
        let partial = try VMFixture.row(VMFixture.clockedIn, ["attendanceStatus": "missing_clock_out"])
        var draft = CorrectionDraft(row: partial)
        draft.reason = "Forgot to clock out at the end of the night"
        draft.value = vmDate("2026-10-21T16:00:00Z")
        if case .invalid(let message) = draft.build(row: partial) {
            XCTAssertTrue(message.hasPrefix("This is before clock in"))
        } else {
            XCTFail("expected an order problem")
        }
        draft.value = vmDate("2026-10-22T01:05:00Z")
        XCTAssertEqual(draft.build(row: partial), .body(CorrectAttendanceBody(field: "clockOutAt", newValue: "2026-10-22T01:05:00.000Z",
                                                                             reason: "Forgot to clock out at the end of the night")))
        draft.select(.breakMinutes, row: partial)
        draft.breakText = "x"
        XCTAssertEqual(draft.build(row: partial), .invalid("Enter a whole number of minutes."))
    }

    func testReviewNeedsEveryRating() {
        var draft = ReviewDraft(review: nil)
        draft.ratings = [.grooming: 4, .attitude: 5]
        XCTAssertEqual(draft.build(), .invalid("Rate every area before saving (Skills, Attendance, Time keeping)."))
        draft.ratings = [.grooming: 4, .attitude: 5, .skills: 3, .attendance: 5, .timeKeeping: 2]
        draft.feedback = "   "
        XCTAssertEqual(draft.build(), .body(StaffReviewBody(grooming: 4, attitude: 5, skills: 3, attendance: 5, timeKeeping: 2, feedback: nil)))
    }
}

import XCTest
@testable import Crewflow

/// Shift report decoding (server ShiftReportDetail / ShiftReportStaffRow),
/// staff badges (attendance missing ≠ confirmed no-show) and finalise gating
/// from SERVER fields only.
final class VMShiftReportDecodingTests: XCTestCase {
    func testDecodesCurrentServerShape() throws {
        let report = try VMFixture.decode(ShiftReportDetail.self, "vm_shift_report")
        XCTAssertEqual(report.shiftId, VMFixture.shiftId)
        XCTAssertEqual(report.staff.count, 6)
        XCTAssertEqual(report.reportStatus, "pending")
        XCTAssertFalse(report.finalisable)
        XCTAssertEqual(report.reviewsRemaining, 4)
        XCTAssertEqual(report.lifecycle?.displayStatus, "needs_review")
        XCTAssertEqual(report.actions?.finalise, "disabled")
        XCTAssertEqual(report.actions?.preShiftDocument?.fileId, "f0000000-0000-4000-8000-000000000001")
        XCTAssertEqual(report.qrWindow?.state, "open")
        XCTAssertEqual(report.serverNow, vmDate("2026-10-22T02:15:30.412Z"))
        XCTAssertEqual(report.attendancePolicy, ReportAttendancePolicy(geofenceEnforced: true, onBehalfClockOutAllowed: false, onBehalfReasonMinWords: 10))
    }

    func testRowCarriesCheckInVersionNoShowAndManualFields() throws {
        let report = try VMFixture.decode(ShiftReportDetail.self, "vm_shift_report")
        let cara = report.staff[VMFixture.clockedIn]
        XCTAssertEqual(cara.checkedInAt, vmDate("2026-10-21T16:50:02.000Z"))
        XCTAssertTrue(cara.checkInLocationVerified)
        XCTAssertEqual(cara.clockInMethod, "manager_on_behalf")
        XCTAssertEqual(cara.clockInByName, "Val Manager")
        // Opaque: echoed byte-for-byte (microseconds, space, +00).
        XCTAssertEqual(cara.attendanceVersion, "2026-10-21 16:58:41.123456+00")
        XCTAssertTrue(cara.isOpen)

        let finn = report.staff[VMFixture.recorded]
        XCTAssertTrue(finn.manuallyEntered)
        XCTAssertEqual(finn.earnedPence, 10450, "bigint pence arrives as a decimal string")
        XCTAssertEqual(finn.workedMinutes, 420)

        let amy = report.staff[VMFixture.provisionalNoShow]
        XCTAssertTrue(amy.isNoShow)
        XCTAssertFalse(amy.noShowConfirmed)
        XCTAssertTrue(amy.attendanceMissing)
        XCTAssertEqual(amy.noShowConfirmableAt, vmDate("2026-10-21T17:30:00.000Z"))

        let ben = report.staff[VMFixture.confirmedNoShow]
        XCTAssertTrue(ben.noShowConfirmed)
        XCTAssertFalse(ben.attendanceMissing)
    }

    func testOlderServerDefaultsLikeFlutter() throws {
        let report = try VMFixture.decode(ShiftReportDetail.self, "vm_shift_report_legacy")
        XCTAssertNil(report.attendancePolicy, "no attendancePolicy before migration 1786719450000")
        let gail = report.staff[0]
        XCTAssertTrue(gail.noShowConfirmed, "no noShowConfirmed key: a reviewed no_show seat is the confirmed one")
        XCTAssertFalse(gail.checkInRequired)
        XCTAssertNil(gail.checkedInAt)
        XCTAssertFalse(gail.manuallyEntered)
        XCTAssertNil(gail.attendanceVersion)
        XCTAssertEqual(report.staff[1].earnedPence, 6012, "number pence also decodes")
    }

    func testUnparseablePunchTimeFailsInsteadOfReadingAsNotClockedIn() throws {
        XCTAssertThrowsError(try VMFixture.row(VMFixture.clockedIn, ["clockInAt": "yesterday"]))
    }

    func testNonIntegerPenceIsRejected() throws {
        XCTAssertThrowsError(try VMFixture.row(VMFixture.recorded, ["earnedPence": "104.50"]))
    }

    func testReportListDecodes() throws {
        let page = try VMFixture.decode(ReportListPage.self, "vm_report_list")
        XCTAssertEqual(page.total, 31)
        XCTAssertEqual(page.data.first?.open, 1)
        XCTAssertEqual(reportMarker(try XCTUnwrap(page.data.first).lifecycle), "Needs attendance review")
        XCTAssertEqual(reportLifecycleLook("needs_review", label: "Needs review").label, "Needs review")
    }
}

final class VMStaffBadgeTests: XCTestCase {
    func testProvisionalNoShowIsAttendanceMissingNotNoShow() throws {
        let amy = try VMFixture.row(VMFixture.provisionalNoShow)
        XCTAssertEqual(staffReportBadge(amy, ended: true), ReportBadgeState(label: "Attendance missing · Needs review", tone: .needsReview))
        // Even before the server says the shift ended, the worker's mark reads the same.
        XCTAssertEqual(staffReportBadge(amy, ended: false).label, "Attendance missing · Needs review")
        XCTAssertEqual(vmAttendanceLine(amy), "Attendance missing · Needs review")
        XCTAssertEqual(teamRowState(amy).label, "Attendance missing")
        XCTAssertEqual(ConfirmedStaffMember.from(amy).bookingLabel, "Attendance missing")
    }

    func testConfirmedNoShow() throws {
        let ben = try VMFixture.row(VMFixture.confirmedNoShow)
        XCTAssertEqual(staffReportBadge(ben, ended: true), ReportBadgeState(label: "No-show · Confirmed", tone: .reviewed))
        XCTAssertEqual(vmAttendanceLine(ben), "No-show confirmed")
        XCTAssertEqual(teamRowState(ben).tone, .danger)
        XCTAssertEqual(ConfirmedStaffMember.from(ben).bookingLabel, "No-show")
    }

    func testNotClockedInBeforeAndAfterEnd() throws {
        let eve = try VMFixture.row(VMFixture.notCheckedIn)
        XCTAssertEqual(staffReportBadge(eve, ended: false).label, "Waiting")
        XCTAssertEqual(staffReportBadge(eve, ended: true).label, "Attendance missing · Needs review")
        XCTAssertEqual(teamRowState(eve).label, "Not checked in")
    }

    func testOpenCorrectedReviewedAndFinalised() throws {
        let cara = try VMFixture.row(VMFixture.clockedIn)
        XCTAssertEqual(staffReportBadge(cara, ended: true), ReportBadgeState(label: "Clocked in", tone: .info))
        let finn = try VMFixture.row(VMFixture.recorded)
        XCTAssertEqual(staffReportBadge(finn, ended: true).label, "Corrected · Awaiting review")
        let reviewed = try VMFixture.row(VMFixture.recorded, ["attendanceReviewed": true])
        XCTAssertEqual(staffReportBadge(reviewed, ended: true).label, "Reviewed")
        XCTAssertEqual(staffReportBadge(cara, ended: true, finalised: true).label, "Finalised")
        let missingOut = try VMFixture.row(VMFixture.clockedIn, ["attendanceStatus": "missing_clock_out"])
        XCTAssertEqual(staffReportBadge(missingOut, ended: true).label, "Needs review")
        XCTAssertEqual(vmWorkedLabel(finn), "7h")
        XCTAssertEqual(vmWorkedLabel(missingOut), "Awaiting clock-out")
    }

    func testReportEndedComesFromServerLifecycleNotDeviceClock() throws {
        let inProgress = try VMFixture.report { json in
            var life = json["lifecycle"] as? [String: Any] ?? [:]
            life["displayStatus"] = "in_progress"
            json["lifecycle"] = life
        }
        XCTAssertFalse(reportEnded(inProgress), "the lifecycle says in progress, whatever the device clock says")
        let noLifecycle = try VMFixture.report { json in
            json["lifecycle"] = NSNull()
            json["serverNow"] = NSNull()
        }
        XCTAssertFalse(reportEnded(noLifecycle), "no server time → never assumed ended")
        let ended = try VMFixture.report { $0["lifecycle"] = NSNull() }
        XCTAssertTrue(reportEnded(ended), "serverNow 02:15 > end 01:00")
    }

    func testNoticeUsesServerLifecycleAndCounts() throws {
        let report = try VMFixture.report()
        // missingClockOut counts non-no-show seats without a clock-out (Cara, Dan, Eve).
        XCTAssertEqual(reportNotice(report)?.title, "3 clock-out times need checking")
    }
}

final class VMFinaliseGateTests: XCTestCase {
    func testServerDisabledFinaliseBlocksSigningWhateverTheForm() throws {
        let report = try VMFixture.report()
        XCTAssertFalse(FinaliseGate.serverReady(report))
        XCTAssertFalse(FinaliseGate.canSign(report, breaksConfirmed: true, name: "Val Manager"))
        XCTAssertFalse(report.canFinalise)
    }

    func testEnabledFinaliseStillNeedsBreakConfirmationAndName() throws {
        let report = try VMFixture.decode(ShiftReportDetail.self, "vm_shift_report_legacy")
        XCTAssertTrue(FinaliseGate.serverReady(report))
        XCTAssertFalse(FinaliseGate.canSign(report, breaksConfirmed: false, name: "Val Manager"))
        XCTAssertFalse(FinaliseGate.canSign(report, breaksConfirmed: true, name: " V "))
        XCTAssertTrue(FinaliseGate.canSign(report, breaksConfirmed: true, name: "Val Manager"))
    }

    func testFinalisedReportCanNeverBeSignedAgain() throws {
        let report = try VMFixture.report("vm_shift_report_legacy") { $0["reportStatus"] = "finalised" }
        XCTAssertFalse(FinaliseGate.serverReady(report))
        XCTAssertNil(report.finaliseBlockedReason)
    }

    func testWithoutActionsFallsBackToServerFinalisable() throws {
        let report = try VMFixture.report("vm_shift_report_legacy") { $0["actions"] = NSNull() }
        XCTAssertTrue(FinaliseGate.serverReady(report))
        let blocked = try VMFixture.report("vm_shift_report_legacy") {
            $0["actions"] = NSNull()
            $0["finalisable"] = false
        }
        XCTAssertFalse(FinaliseGate.serverReady(blocked))
    }

    func testBlockedReasonMostBlockingFirst() throws {
        let report = try VMFixture.report()
        XCTAssertEqual(report.finaliseBlockedReason, "1 staff member is still clocked in")
        let reviewsOnly = try VMFixture.report("vm_shift_report_legacy") {
            $0["finalisable"] = false
            $0["reviewsRemaining"] = 2
        }
        XCTAssertEqual(reviewsOnly.finaliseBlockedReason, "2 attendance reviews remaining")
    }

    func testFinaliseSendsTypedSignOffAndIsRepeatSafe() async throws {
        URLProtocolStub.server.reset()
        var calls = 0
        URLProtocolStub.server.setHandler { request in
            guard request.url?.path.hasSuffix("/finalise") == true else { return .json(404, #"{"message":"Not found."}"#) }
            calls += 1
            return calls == 1 ? .json(503, #"{"message":"down"}"#) : .fixture("vm_shift_report_legacy")
        }
        let repository = vmRepository()
        _ = try await repository.finalise(shiftId: VMFixture.shiftId, signedOffName: "Val Manager")
        let sent = URLProtocolStub.server.requests(containing: "/finalise")
        XCTAssertEqual(sent.count, 2, "finalise is repeat-safe by server state: one retry after a 503")
        XCTAssertEqual(sent.first?.httpMethod, "PATCH")
        XCTAssertEqual(vmJSON(sent[0])["signedOffName"] as? String, "Val Manager")
        XCTAssertEqual(vmJSON(sent[0])["breakConfirmed"] as? Bool, true)
        XCTAssertEqual(Set(vmJSON(sent[0]).keys), ["signedOffName", "breakConfirmed"])
    }
}

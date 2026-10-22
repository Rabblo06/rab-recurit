import XCTest
@testable import Crewflow

/// Retry policy per route (no Idempotency-Key exists), list paging, Send
/// Shift request body and the Staff Qr-Code states.
final class VMMutationRetryTests: XCTestCase {
    override func setUp() {
        super.setUp()
        URLProtocolStub.server.reset()
        URLProtocolStub.server.setHandler { _ in .json(503, #"{"message":"Service unavailable"}"#) }
    }

    private let shift = VMFixture.shiftId
    private let seat = "b0000000-0000-4000-8000-00000000000a"

    private func count(_ fragment: String, _ call: () async throws -> Void) async -> Int {
        do { try await call() } catch {}
        return URLProtocolStub.server.requests(containing: fragment).count
    }

    func testNonIdempotentMutationsAreSentExactlyOnceOnAnUncertainResult() async {
        let repository = vmRepository()
        let reason = "one two three four five six seven eight nine ten"
        let body = SubmitShiftRequestBody(venueId: "v", jobRoleId: "r", startsAt: Date(), endsAt: Date().addingTimeInterval(3600),
                                          breakMinutes: nil, staffRequired: 1, staffProfileIds: ["s"],
                                          staffAssignments: [], acknowledgedAvailabilityConflicts: nil)
        let record = RecordAttendanceBody(clockInAt: Date(), clockOutAt: nil, breakMinutes: 0, reasonCode: "app_issue", reasonNote: nil, expectedVersion: nil)
        let review = StaffReviewBody(grooming: 5, attitude: 5, skills: 5, attendance: 5, timeKeeping: 5, feedback: nil)
        let cases: [(String, () async throws -> Void)] = [
            ("/shifts/request", { _ = try await repository.submitShiftRequest(body) }),
            ("/clock-in-on-behalf", { _ = try await repository.clockInOnBehalf(shiftId: self.shift, staffProfileId: self.seat, reason: reason) }),
            ("/clock-out-on-behalf", { _ = try await repository.clockOutOnBehalf(shiftId: self.shift, staffProfileId: self.seat, reason: reason) }),
            ("/record-attendance", { _ = try await repository.recordAttendance(shiftId: self.shift, staffProfileId: self.seat, body: record) }),
            ("/reopen-no-show", { _ = try await repository.reopenNoShow(shiftId: self.shift, staffProfileId: self.seat, reason: "Staff did attend, verified") }),
            ("/tags", { _ = try await repository.setTags(self.seat, favourite: true) }),
            ("/correct", { try await repository.correctAttendance(attendanceId: "c0000000-0000-4000-8000-00000000000c",
                                                                   body: CorrectAttendanceBody(field: "breakMinutes", newValue: "30", reason: "Break was longer than scheduled")) }),
            ("/reviews/", { try await repository.saveReview(shiftId: self.shift, staffProfileId: self.seat, body: review) }),
        ]
        for (fragment, call) in cases {
            URLProtocolStub.server.reset()
            URLProtocolStub.server.setHandler { _ in .json(503, #"{"message":"Service unavailable"}"#) }
            let sent = await count(fragment, call)
            XCTAssertEqual(sent, 1, "\(fragment) must never be auto-retried")
        }
    }

    func testRepeatSafeSeatActionsRetryOnce() async {
        let repository = vmRepository()
        let cases: [(String, () async throws -> Void)] = [
            ("/attendance-review", { _ = try await repository.reviewAttendance(shiftId: self.shift, staffProfileId: self.seat) }),
            ("/confirm-no-show", { _ = try await repository.confirmNoShow(shiftId: self.shift, staffProfileId: self.seat) }),
        ]
        for (fragment, call) in cases {
            URLProtocolStub.server.reset()
            URLProtocolStub.server.setHandler { _ in .json(503, #"{"message":"Service unavailable"}"#) }
            let sent = await count(fragment, call)
            XCTAssertEqual(sent, 2, "\(fragment) is repeat-safe by server state (one retry)")
        }
    }

    func testSubmitShiftRequestBodyHasNoUndeclaredFields() async throws {
        URLProtocolStub.server.setHandler { _ in .json(201, #"{"id":"d0000000-0000-4000-8000-000000000009","status":"pending_manager_approval"}"#) }
        let staff = try VMFixture.decode(VMListPage<DirectoryUser>.self, "vm_directory").data
        var draft = ShiftAssignmentDraft()
        // November: London = GMT, so London wall time equals UTC here.
        let day = vmDate("2026-11-14T12:00:00Z")
        let start = vmDate("2026-11-14T18:00:00Z") // 18:00 London
        let end = vmDate("2026-11-14T02:00:00Z")   // 02:00 London → rolls to the next day
        let window = SendShiftComposer.compose(day: day, start: start, end: end)
        draft.select(Array(staff.prefix(2)), start: window.startsAt, end: window.endsAt)
        let built = SendShiftComposer.body(venueId: "v1", jobRoleId: "r1", day: day, start: start, end: end, breakText: "",
                                           draft: draft, venue: VenueSummary(id: "v1", name: "Hall", defaultBreakMinutes: 45),
                                           acknowledgements: nil)
        guard case .success(let body) = built else { return XCTFail("expected a body") }
        let created = try await vmRepository().submitShiftRequest(body)
        XCTAssertEqual(created.id, "d0000000-0000-4000-8000-000000000009")
        let json = vmJSON(try XCTUnwrap(URLProtocolStub.server.requests(containing: "/shifts/request").first))
        XCTAssertEqual(Set(json.keys), ["venueId", "jobRoleId", "startsAt", "endsAt", "staffRequired", "staffProfileIds", "staffAssignments"],
                       "no note (dropped by the server), no organisationId/status/payRatePence, break omitted = venue default")
        XCTAssertEqual(json["startsAt"] as? String, "2026-11-14T18:00:00.000Z")
        XCTAssertEqual(json["endsAt"] as? String, "2026-11-15T02:00:00.000Z", "overnight end rolls to the next London day")
        let assignments = json["staffAssignments"] as? [[String: Any]] ?? []
        XCTAssertEqual(assignments.count, 2)
        XCTAssertNil(assignments.first?["breakMinutes"], "inherit = omitted")
        XCTAssertEqual(json["staffRequired"] as? Int, 2)
    }
}

final class VMSendShiftComposerTests: XCTestCase {
    func testBreakRules() throws {
        XCTAssertEqual(SendShiftComposer.parseBreak(""), .serverDefault)
        XCTAssertEqual(SendShiftComposer.parseBreak("15"), .minutes(15))
        XCTAssertEqual(SendShiftComposer.parseBreak("-3"), .invalid)
        XCTAssertEqual(SendShiftComposer.draftBreak(text: "", venue: nil), 30)
        XCTAssertEqual(SendShiftComposer.draftBreak(text: "", venue: VenueSummary(id: "v", name: "V", defaultBreakMinutes: 45)), 45)
        let staff = try VMFixture.decode(VMListPage<DirectoryUser>.self, "vm_directory").data
        var draft = ShiftAssignmentDraft()
        let day = vmDate("2026-11-02T12:00:00Z")
        let start = vmDate("2026-11-02T09:00:00Z")
        let end = vmDate("2026-11-02T10:00:00Z")
        draft.select([staff[0]], start: start, end: end)
        let tooLong = SendShiftComposer.body(venueId: "v", jobRoleId: "r", day: day, start: start, end: end, breakText: "60",
                                             draft: draft, venue: nil, acknowledgements: nil)
        XCTAssertEqual(tooLong.failureValue, .breakTooLong)
        let none = SendShiftComposer.body(venueId: "v", jobRoleId: "r", day: day, start: start, end: end, breakText: "",
                                          draft: ShiftAssignmentDraft(), venue: nil, acknowledgements: nil)
        XCTAssertEqual(none.failureValue, .noStaff)
    }

    func testCustomisedAssignmentsKeepTheirWindow() throws {
        let staff = try VMFixture.decode(VMListPage<DirectoryUser>.self, "vm_directory").data
        var draft = ShiftAssignmentDraft()
        let a = vmDate("2026-11-02T09:00:00Z"), b = vmDate("2026-11-02T17:00:00Z")
        draft.select(Array(staff.prefix(2)), start: a, end: b)
        var custom = draft.assignments[0]
        custom.startsAt = vmDate("2026-11-02T11:00:00Z")
        custom.customised = true
        draft.update(custom)
        draft.parentChanged(start: vmDate("2026-11-02T10:00:00Z"), end: b)
        XCTAssertEqual(draft.assignments[0].startsAt, vmDate("2026-11-02T11:00:00Z"))
        XCTAssertEqual(draft.assignments[1].startsAt, vmDate("2026-11-02T10:00:00Z"))
        draft.select([staff[1]], start: a, end: b)
        XCTAssertEqual(draft.selectedIds, [staff[1].id], "deselected staff leave the draft")
    }

    func testAvailabilityConflictParsingAndAcknowledgement() throws {
        let payload = ServerErrorPayload.parse(Fixture.data("vm_availability_conflict"))
        let conflict = try XCTUnwrap(AvailabilityConflict.from(APIError.conflict(payload)))
        XCTAssertEqual(conflict.totalRecipients, 3)
        XCTAssertEqual(conflict.unknownCount, 1)
        XCTAssertEqual(conflict.entries.first?.weekdays, ["Sunday", "Monday"])
        XCTAssertEqual(conflict.acknowledgements, [.init(staffProfileId: "e0000000-0000-4000-8000-000000000002", dates: ["2026-10-25", "2026-10-26"])])
        XCTAssertEqual(VMText.formatWeekdayList(conflict.entries[0].weekdays), "Monday and Sunday", "calendar order")
        XCTAssertNil(AvailabilityConflict.from(APIError.conflict(ServerErrorPayload(message: "Overlap", code: "SHIFT_OVERLAP"))))
    }
}

final class VMRepositoryPagingTests: XCTestCase {
    override func setUp() {
        super.setUp()
        URLProtocolStub.server.reset()
    }

    func testAllReadsPagesUntilTotal() async throws {
        URLProtocolStub.server.setHandler { request in
            let query = request.url?.query ?? ""
            if query.contains("page=1") { return .json(200, #"{"data":[{"id":"j1","name":"Bar"}],"total":2}"#) }
            return .json(200, #"{"data":[{"id":"j2","name":"Floor"}],"total":2}"#)
        }
        let roles = try await vmRepository().all("/job-roles", as: JobRoleSummary.self)
        XCTAssertEqual(roles.map(\.id), ["j1", "j2"])
        XCTAssertTrue(URLProtocolStub.server.requests.allSatisfy { ($0.url?.query ?? "").contains("limit=100") })
    }

    func testPlainArrayStopsAtOnePage() async throws {
        URLProtocolStub.server.setHandler { _ in .json(200, #"[{"id":"j1","name":"Bar"}]"#) }
        let roles = try await vmRepository().all("/job-roles", as: JobRoleSummary.self)
        XCTAssertEqual(roles.count, 1)
        XCTAssertEqual(URLProtocolStub.server.requests.count, 1)
    }

    func testEmptyPageBeforeTotalFailsInsteadOfShowingAShortList() async {
        URLProtocolStub.server.setHandler { request in
            (request.url?.query ?? "").contains("page=1")
                ? .json(200, #"{"data":[{"id":"j1","name":"Bar"}],"total":3}"#)
                : .json(200, #"{"data":[],"total":3}"#)
        }
        do {
            _ = try await vmRepository().all("/job-roles", as: JobRoleSummary.self)
            XCTFail("expected listChanged")
        } catch {
            XCTAssertEqual(error as? VenueManagerError, .listChanged)
        }
    }

    func testShiftDecodingNeverReadsTheChargeRate() throws {
        let shift = try VMFixture.decode(VenueShift.self, object: [
            "id": "s1", "venueId": "v1", "jobRoleId": "r1", "createdBy": "u1", "address": NSNull(), "notes": NSNull(),
            "status": "open", "startsAt": "2026-10-25T17:00:00.000Z", "endsAt": "2026-10-26T01:00:00.000Z",
            "requiredCount": 3, "filledCount": 1, "payRatePence": "1250", "chargeRatePence": "2400",
        ] as [String: Any])
        XCTAssertEqual(shift.payRatePence, 1250)
        XCTAssertEqual(shift.vacancies, 2)
        XCTAssertFalse(String(describing: shift).contains("2400"), "chargeRatePence is not part of the model")
    }
}

final class VMStaffQrStateTests: XCTestCase {
    func testQrStatesComeFromTheReportOnly() throws {
        let open = try VMFixture.report()
        XCTAssertNil(VMStaffQrView.decide(open), "pre-shift sheet exists → download and render it")
        let closed = try VMFixture.report { json in
            var window = json["qrWindow"] as? [String: Any] ?? [:]
            window["state"] = "closed"
            json["qrWindow"] = window
        }
        XCTAssertEqual(VMStaffQrView.decide(closed), .closed)
        let scheduled = try VMFixture.report { json in
            var actions = json["actions"] as? [String: Any] ?? [:]
            actions["stage"] = "scheduled"
            actions["preShiftDocument"] = NSNull()
            json["actions"] = actions
        }
        XCTAssertEqual(VMStaffQrView.decide(scheduled), .notYet(vmDate("2026-10-21T14:00:00.000Z")))
        let preparing = try VMFixture.report { json in
            var actions = json["actions"] as? [String: Any] ?? [:]
            actions["preShiftDocument"] = NSNull()
            json["actions"] = actions
        }
        XCTAssertEqual(VMStaffQrView.decide(preparing), .preparing)
        let noActions = try VMFixture.report { $0["actions"] = NSNull() }
        XCTAssertEqual(VMStaffQrView.decide(noActions), .unavailable)
    }
}

private extension Result {
    var failureValue: Failure? {
        if case .failure(let value) = self { return value }
        return nil
    }
}

import XCTest
@testable import Crewflow

/// Users directory (assigned staff only), tag filters, Sent Shifts counts,
/// pills and relative time.
final class VMDirectoryTests: XCTestCase {
    func testDirectoryRowsDecodeWithoutInventingAvailability() throws {
        let page = try VMFixture.decode(VMListPage<DirectoryUser>.self, "vm_directory")
        XCTAssertEqual(page.total, 42)
        XCTAssertEqual(page.data[0].name, "Ivy Available")
        XCTAssertEqual(page.data[0].available, true)
        XCTAssertNil(page.data[1].jobRoleName, "blank role → nil, never shown as empty text")
        XCTAssertEqual(page.data[1].available, false)
        XCTAssertNil(page.data[2].available, "no window evaluated → no badge, never 'unavailable'")
        XCTAssertEqual(page.data[2].name, "Kai")
    }

    func testDirectoryQueryCarriesOnlyDeclaredFilters() {
        let start = vmDate("2026-10-25T18:00:00Z")
        let end = vmDate("2026-10-26T02:00:00Z")
        let path = VenueManagerRepository.directoryPath(query: "Jo & Co", page: 2, status: "active", tag: "favourite",
                                                        startAt: start, endAt: end, excludeShiftId: nil)
        XCTAssertEqual(path, "/staff/venue-directory?q=Jo%20%26%20Co&page=2&limit=30&status=active&tag=favourite&startAt=2026-10-25T18%3A00%3A00.000Z&endAt=2026-10-26T02%3A00%3A00.000Z")
        XCTAssertFalse(path.contains("organisationId"))
        XCTAssertFalse(path.contains("venueId"), "the server scopes to this Venue Manager; no selector is ever sent")
        let plain = VenueManagerRepository.directoryPath(query: "", page: 1, status: nil, tag: nil, startAt: nil, endAt: nil, excludeShiftId: nil)
        XCTAssertEqual(plain, "/staff/venue-directory?q=&page=1&limit=30")
    }

    func testServerConfirmedTagChangeLeavesFilteredList() throws {
        let page = try VMFixture.decode(VMListPage<DirectoryUser>.self, "vm_directory")
        let ivy = page.data[0]
        let unfavourited = ivy.withTags(StaffTags(isFavourite: false, isEmergency: false))
        let favouritesOnly = VMDirectory.replacing([ivy], total: 1, with: unfavourited, tag: "favourite")
        XCTAssertTrue(favouritesOnly.users.isEmpty)
        XCTAssertEqual(favouritesOnly.total, 0)
        let all = VMDirectory.replacing(page.data, total: 42, with: unfavourited, tag: nil)
        XCTAssertEqual(all.users.count, 3)
        XCTAssertEqual(all.total, 42)
        XCTAssertFalse(all.users[0].isFavourite)
    }

    func testEmptyStatesAndErrorCopy() {
        XCTAssertEqual(VMDirectory.emptyTitle(filtered: true, tag: nil), "No staff match your search.")
        XCTAssertEqual(VMDirectory.emptyTitle(filtered: false, tag: "emergency"), "No emergency cover staff yet.")
        XCTAssertEqual(VMDirectory.emptyTitle(filtered: false, tag: nil), "No staff assigned to you yet")
        let gone = APIError.notFound(ServerErrorPayload(message: "Staff member not found."))
        XCTAssertEqual(VMDirectory.errorMessage(gone, viewing: true), VMDirectory.notAssignedMessage)
        XCTAssertTrue(VMDirectory.isNotAssigned(gone))
    }

    func testSetTagsSendsOnlyTheChangedTagAndRendersServerState() async throws {
        URLProtocolStub.server.reset()
        URLProtocolStub.server.setHandler { _ in .json(200, #"{"isFavourite":true,"isEmergency":true}"#) }
        let tags = try await vmRepository().setTags("e0000000-0000-4000-8000-000000000002", emergency: true)
        XCTAssertEqual(tags, StaffTags(isFavourite: true, isEmergency: true), "the server-confirmed state, not a guess")
        let sent = try XCTUnwrap(URLProtocolStub.server.requests(containing: "/tags").first)
        XCTAssertEqual(sent.httpMethod, "PATCH")
        XCTAssertEqual(vmJSON(sent).keys.sorted(), ["emergency"])
    }
}

final class VMSentShiftTests: XCTestCase {
    func testSentShiftsDecodeWithServerCounts() throws {
        let page = try VMFixture.decode(SentShiftsPage.self, "vm_sent_shifts")
        XCTAssertEqual(page.data.count, 2)
        XCTAssertEqual(page.counts["submitted"], 5)
        let summary = VMSentViews.summary(sentShifts: page.data, counts: page.counts)
        XCTAssertEqual(summary.sent, 1, "a request awaiting approval is not 'sent'")
        XCTAssertEqual(summary.accepted, 1)
        XCTAssertEqual(summary.confirmed, 0)
        XCTAssertEqual(VMSentViews.chipLabel("expired", label: "Expired", counts: page.counts), "Expired 3")
        XCTAssertEqual(VMSentViews.sentLine(page.data[0]), "Sent to 4 staff")
        XCTAssertEqual(VMSentViews.sentLine(page.data[1]), "Not sent yet")
        XCTAssertEqual(VMText.displayRoleName(page.data[1].roleName), "Role unavailable", "a role id is never shown")
    }

    func testPillPrecedenceMirrorsServerStatusLabel() throws {
        let page = try VMFixture.decode(SentShiftsPage.self, "vm_sent_shifts")
        XCTAssertEqual(sentShiftLook(page.data[0]).label, "Accepted")
        XCTAssertEqual(sentShiftLook(page.data[1]).label, "Pending approval")
        var json = VMFixture.object("vm_sent_shifts")
        var rows = json["data"] as? [[String: Any]] ?? []
        rows[0]["actionExpired"] = true
        json["data"] = rows
        let expired = try VMFixture.decode(SentShiftsPage.self, object: json)
        XCTAssertEqual(sentShiftLook(expired.data[0]).label, "Expired", "server time (end + 5 h) wins over any offer state")
    }

    func testRelativeSentTime() {
        let submitted = vmDate("2026-10-21T10:00:00Z")
        XCTAssertEqual(VMDate.sentAgo(submitted, now: submitted.addingTimeInterval(-30)), "Sent just now", "clock skew never reads negative")
        XCTAssertEqual(VMDate.sentAgo(submitted, now: submitted.addingTimeInterval(59)), "Sent just now")
        XCTAssertEqual(VMDate.sentAgo(submitted, now: submitted.addingTimeInterval(5 * 60)), "Sent 5m ago")
        XCTAssertEqual(VMDate.sentAgo(submitted, now: submitted.addingTimeInterval(2 * 3600 + 59)), "Sent 2h ago")
        XCTAssertEqual(VMDate.sentAgo(submitted, now: submitted.addingTimeInterval(3 * 86_400)), "Sent 3d ago")
        XCTAssertEqual(VMDate.sentAgo(submitted, now: submitted.addingTimeInterval(8 * 86_400)), "Sent 21 Oct 2026")
    }

    func testOtherResponsesNeverShowACancelledBookingAsConfirmed() throws {
        let report = try VMFixture.report()
        let roster = ShiftRoster.fromReport(report)
        let offers = try VMFixture.decode([VMOffer].self, object: [
            ["id": "o1", "status": "manager_confirmed", "sentAt": "2026-10-20T10:00:00Z", "shiftId": VMFixture.shiftId,
             "startsAt": "2026-10-21T17:00:00Z", "endsAt": "2026-10-22T01:00:00Z", "staffProfileId": "x-cancelled",
             "staffName": "Zed Cancelled", "roleName": "Bartender", "venueName": "The Grand Hall"],
            ["id": "o2", "status": "declined", "sentAt": "2026-10-20T10:00:00Z", "shiftId": VMFixture.shiftId,
             "startsAt": "2026-10-21T17:00:00Z", "endsAt": "2026-10-22T01:00:00Z", "staffProfileId": "y-declined",
             "staffName": "Yan Declined", "roleName": "Bartender", "venueName": "The Grand Hall"],
            ["id": "o3", "status": "pending", "sentAt": "2026-10-20T10:00:00Z", "shiftId": "another-shift",
             "startsAt": "2026-10-21T17:00:00Z", "endsAt": "2026-10-22T01:00:00Z", "staffProfileId": "w-other",
             "staffName": "Wes Other", "roleName": "Bartender", "venueName": "The Grand Hall"],
        ])
        let responses = otherResponses(shiftId: VMFixture.shiftId, offers: offers, roster: roster)
        XCTAssertEqual(responses.map { $0.name }, ["Yan Declined", "Zed Cancelled"], "other shifts' offers never leak in")
        XCTAssertEqual(responses.map { $0.label }, ["Declined", "No longer booked"])
        XCTAssertEqual(roster.confirmedCount, 4, "no-shows are listed, not counted")
    }
}

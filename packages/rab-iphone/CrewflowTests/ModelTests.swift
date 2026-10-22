import XCTest
@testable import Crewflow

/// Decoding of real server response shapes, dates, money and colours.
final class DecodingTests: XCTestCase {
    private let decoder = CrewflowJSON.makeDecoder()

    func testCurrentUserDecodesAuthMeShape() throws {
        let user = try decoder.decode(CurrentUser.self, from: Fixture.data("auth_me_staff"))
        XCTAssertEqual(user.id, "6f1c1c3e-2c8e-4b4e-9d4f-0a1b2c3d4e5f")
        XCTAssertEqual(user.email, "sam.staff@example.com")
        XCTAssertEqual(user.fullName, "Sam Staff")
        XCTAssertEqual(user.roles, ["staff"])
        XCTAssertFalse(user.mustResetPassword)
        XCTAssertFalse(user.isPlatformAdmin)
        XCTAssertEqual(user.applicationTarget, .staffApp)
        XCTAssertEqual(user.sessionId, "a3c5e7f9-1b2d-4e6f-8a0b-c2d4e6f8a0b2")
        XCTAssertEqual(user.sessionExpiresAt, ISO8601.date(from: "2027-01-19T10:15:30.123Z"))
        XCTAssertEqual(user.presentation, .staff)
    }

    func testVenueManagerFixtureRoutesToVenueManagerShell() throws {
        let user = try decoder.decode(CurrentUser.self, from: Fixture.data("auth_me_venue_manager"))
        XCTAssertEqual(user.applicationTarget, .venueManagerApp)
        XCTAssertEqual(user.presentation, .venueManager, "venue_manager wins over staff")
    }

    func testCurrentUserDefaultsMissingOptionalFieldsLikeFlutter() throws {
        let json = #"{"id":"u1","email":"a@b.c","firstName":"A","lastName":"B","organisationId":"o1","roles":["staff"]}"#
        let user = try decoder.decode(CurrentUser.self, from: Data(json.utf8))
        XCTAssertFalse(user.mustResetPassword)
        XCTAssertFalse(user.isPlatformAdmin)
        XCTAssertNil(user.applicationTarget)
        XCTAssertNil(user.sessionExpiresAt)
    }

    func testCurrentUserKeepsUnknownApplicationTarget() throws {
        let json = #"{"id":"u1","email":"a@b.c","firstName":"A","lastName":"B","organisationId":"o1","roles":["staff"],"applicationTarget":"kiosk_app"}"#
        let user = try decoder.decode(CurrentUser.self, from: Data(json.utf8))
        XCTAssertEqual(user.applicationTarget, .unknown("kiosk_app"))
    }

    func testCurrentUserMissingRequiredFieldFailsClosed() {
        let json = #"{"id":"u1","email":"a@b.c","firstName":"A","lastName":"B","roles":["staff"]}"#
        XCTAssertThrowsError(try decoder.decode(CurrentUser.self, from: Data(json.utf8)))
    }

    func testLoginResponseHasTokensAndNoUser() throws {
        let login = try decoder.decode(LoginResponse.self, from: Fixture.data("auth_login"))
        XCTAssertEqual(login.accessToken, "access-token-1")
        XCTAssertEqual(login.refreshToken, "refresh-token-1")
        XCTAssertEqual(login.mustResetPassword, false)
        XCTAssertNotNil(login.sessionExpiresAt)
    }

    func testLoginResponseWithoutRefreshTokenFailsClosed() {
        // A web-shaped response (refresh token moved to a cookie) must never be accepted.
        let json = #"{"accessToken":"a","refreshExpiresAt":"2026-11-21T10:15:30.123Z","sessionExpiresAt":"2027-01-19T10:15:30.123Z","mustResetPassword":false}"#
        XCTAssertThrowsError(try decoder.decode(LoginResponse.self, from: Data(json.utf8)))
    }

    func testRefreshResponse() throws {
        let tokens = try decoder.decode(AuthTokensResponse.self, from: Fixture.data("auth_refresh"))
        XCTAssertEqual(tokens.accessToken, "access-token-2")
        XCTAssertEqual(tokens.refreshToken, "refresh-token-2")
    }

    func testCapabilitiesSeventeenFlagsAndFailClosed() throws {
        let caps = try decoder.decode(Capabilities.self, from: Fixture.data("auth_capabilities"))
        XCTAssertEqual(caps.flags.count, 17)
        XCTAssertTrue(caps.allows(.reportView))
        XCTAssertTrue(caps.allows(.attendanceEdit))
        XCTAssertFalse(caps.allows(.offerSend))
        XCTAssertFalse(caps.allows(.payrollApprove))
        XCTAssertFalse(caps.allows("unknown.flag"))
        XCTAssertFalse(Capabilities.none.allows(.staffView))
    }

    func testCapabilitiesNonBooleanValueReadsFalse() throws {
        let caps = try decoder.decode(Capabilities.self, from: Data(#"{"staff.view":"yes","report.view":true}"#.utf8))
        XCTAssertFalse(caps.allows(.staffView))
        XCTAssertTrue(caps.allows(.reportView))
    }

    func testCalendarDayDecodesDateOnlyWithoutTimeZoneShift() throws {
        struct Period: Decodable { let payday: CalendarDay }
        let period = try decoder.decode(Period.self, from: Data(#"{"payday":"2026-10-31"}"#.utf8))
        XCTAssertEqual(period.payday.description, "2026-10-31")
        XCTAssertEqual(period.payday, CalendarDay(year: 2026, month: 10, day: 31))
        XCTAssertNil(CalendarDay(isoString: "2026-02-30"))
        XCTAssertNil(CalendarDay(isoString: "2026-10-31T00:00:00Z"))
        XCTAssertThrowsError(try decoder.decode(Period.self, from: Data(#"{"payday":"31/10/2026"}"#.utf8)))
        XCTAssertLessThan(CalendarDay(isoString: "2026-10-30")!, CalendarDay(isoString: "2026-10-31")!)
    }

    func testServerErrorPayloadShapes() {
        let validation = ServerErrorPayload.parse(Data(#"{"statusCode":400,"message":["email must be an email","property organisationId should not exist"],"error":"Bad Request"}"#.utf8))
        XCTAssertEqual(validation.message, "email must be an email")
        XCTAssertEqual(validation.messages.count, 2)

        let structured = ServerErrorPayload.parse(Data(#"{"code":"CLOCK_IN_TOO_EARLY","message":"You can clock in from 08:45.","availableAt":"2026-10-21T08:45:00.000Z"}"#.utf8))
        XCTAssertEqual(structured.code, "CLOCK_IN_TOO_EARLY")
        XCTAssertEqual(structured.body?["availableAt"]?.stringValue, "2026-10-21T08:45:00.000Z")

        let bare = ServerErrorPayload.parse(Data(#""ThrottlerException: Too Many Requests""#.utf8))
        XCTAssertEqual(bare.message, "ThrottlerException: Too Many Requests")

        let html = ServerErrorPayload.parse(Data("<html>Bad gateway</html>".utf8))
        XCTAssertEqual(html.message, APIMessages.serverError)
    }
}

final class DateParsingTests: XCTestCase {
    private func components(_ date: Date?) -> DateComponents? {
        guard let date else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond], from: date)
    }

    func testMillisecondFraction() {
        let c = components(ISO8601.date(from: "2026-10-21T09:15:30.123Z"))
        XCTAssertEqual(c?.hour, 9)
        XCTAssertEqual(c?.second, 30)
        XCTAssertEqual(Double(c?.nanosecond ?? 0) / 1_000_000, 123, accuracy: 1)
    }

    func testNoFraction() {
        let c = components(ISO8601.date(from: "2026-10-21T09:15:30Z"))
        XCTAssertEqual(c?.minute, 15)
        XCTAssertEqual(c?.second, 30)
    }

    func testOffsetAndShortFraction() {
        let c = components(ISO8601.date(from: "2026-10-21T10:15:30.5+01:00"))
        XCTAssertEqual(c?.hour, 9)
        XCTAssertEqual(Double(c?.nanosecond ?? 0) / 1_000_000, 500, accuracy: 1)
    }

    func testMicrosecondFraction() {
        let c = components(ISO8601.date(from: "2026-10-21T09:15:30.123456Z"))
        XCTAssertEqual(c?.second, 30)
        XCTAssertEqual(Double(c?.nanosecond ?? 0) / 1_000_000, 123, accuracy: 1)
    }

    func testInvalidStringsAreRejected() {
        XCTAssertNil(ISO8601.date(from: "2026-10-21"))
        XCTAssertNil(ISO8601.date(from: "21/10/2026 09:15"))
        XCTAssertNil(ISO8601.date(from: ""))
    }

    func testDecoderRejectsBadDateInsteadOfGuessing() {
        struct Shift: Decodable { let startsAt: Date }
        XCTAssertThrowsError(try CrewflowJSON.makeDecoder().decode(Shift.self, from: Data(#"{"startsAt":"tomorrow"}"#.utf8)))
    }

    func testRoundTripKeepsMilliseconds() {
        let date = ISO8601.date(from: "2026-10-21T09:15:30.123Z")!
        let encoded = ISO8601.string(from: date)
        XCTAssertTrue(encoded.hasPrefix("2026-10-21T09:15:30."))
        XCTAssertTrue(encoded.hasSuffix("Z"))
        XCTAssertEqual(ISO8601.date(from: encoded)!.timeIntervalSince1970, date.timeIntervalSince1970, accuracy: 0.002)
    }

    func testLondonDisplayAcrossDaylightSaving() {
        // 21 Oct 2026 is BST (UTC+1); 2 Nov 2026 is GMT.
        XCTAssertEqual(CrewflowDateFormat.time(ISO8601.date(from: "2026-10-21T09:00:00.000Z")!), "10:00")
        XCTAssertEqual(CrewflowDateFormat.time(ISO8601.date(from: "2026-11-02T09:00:00.000Z")!), "09:00")
        let start = ISO8601.date(from: "2026-10-21T21:00:00.000Z")!
        let end = ISO8601.date(from: "2026-10-22T03:00:00.000Z")!
        XCTAssertEqual(CrewflowDateFormat.timeRange(start, end), "22:00 - 04:00 (+1 day)")
    }
}

final class MoneyTests: XCTestCase {
    func testFormatPenceMatchesFlutter() {
        XCTAssertEqual(Money.formatPence(0), "£0.00")
        XCTAssertEqual(Money.formatPence(5), "£0.05")
        XCTAssertEqual(Money.formatPence(1250), "£12.50")
        XCTAssertEqual(Money.formatPence(123_456), "£1234.56") // no thousands separator (parity)
        XCTAssertEqual(Money.formatPence(-150), "£-1.50")
    }

    func testPayRateLabel() {
        XCTAssertEqual(Money.payRateLabel(0), "Rate not set")
        XCTAssertEqual(Money.payRateLabel(-1), "Rate not set")
        XCTAssertEqual(Money.payRateLabel(1150), "£11.50/h")
    }

    func testEstimatedPayLabel() {
        XCTAssertEqual(Money.estimatedPayLabel(ratePence: 0, estimatedPence: 9000), "Estimated pay unavailable")
        XCTAssertEqual(Money.estimatedPayLabel(ratePence: 1200, estimatedPence: 9000), "£90.00 estimated pay")
    }
}

@MainActor
final class ShiftVisualStyleTests: XCTestCase {
    func testPreferredIndexMatchesDartHash() {
        XCTAssertEqual(ShiftVisualStyle.preferredIndex("a"), 1)
        XCTAssertEqual(ShiftVisualStyle.preferredIndex("shift-1"), 0)
        XCTAssertEqual(ShiftVisualStyle.preferredIndex("shift-2"), 1)
        XCTAssertEqual(ShiftVisualStyle.preferredIndex("shift-3"), 2)
        XCTAssertEqual(ShiftVisualStyle.preferredIndex("00000000-0000-0000-0000-000000000001"), 1)
    }

    func testPersistenceKeyMatchesDart() {
        XCTAssertEqual(ShiftColourRegistry.persistenceKey("a"), "2p.2p")
        XCTAssertEqual(ShiftColourRegistry.persistenceKey("shift-1"), "y37zdi.7jofzl")
    }

    func testRegistryIsStableAndSpreadsAGroup() {
        let registry = ShiftColourRegistry()
        let ids = ["shift-1", "shift-1b", "shift-1c"]
        registry.registerGroup(ids)
        let styles = ids.map { registry.resolve($0) }
        XCTAssertEqual(Set(styles).count, 3, "three neighbours take three different pastels")
        XCTAssertEqual(ids.map { registry.resolve($0) }, styles, "never recoloured")
    }

    func testRestoreKeepsSavedSlot() {
        let registry = ShiftColourRegistry()
        registry.restore([ShiftColourRegistry.persistenceKey("shift-1"): 2, "junk": 9])
        XCTAssertEqual(registry.resolve("shift-1"), .lavender)
    }

    func testPaletteColours() {
        XCTAssertEqual(ShiftVisualStyle.mint.cardRGBA.argb, 0xFFECFCF5)
        XCTAssertEqual(ShiftVisualStyle.peach.cardRGBA.argb, 0xFFFFF2E9)
        XCTAssertEqual(ShiftVisualStyle.lavender.cardRGBA.argb, 0xFFDFE2FF)
        XCTAssertEqual(SchedulePalette.navy.argb, 0xFF0D1B33)
    }

    func testInitials() {
        XCTAssertEqual(InitialsAvatar.initials(for: "Sam Staff"), "SS")
        XCTAssertEqual(InitialsAvatar.initials(for: "  val  "), "V")
        XCTAssertEqual(InitialsAvatar.initials(for: ""), "?")
    }
}

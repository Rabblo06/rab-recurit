import XCTest
@testable import Crewflow

/// Pure Staff presentation rules (ported from the Flutter staff app).
final class StaffRulesTests: XCTestCase {
    private func offer(
        id: String = StaffFixtures.offerId,
        shiftId: String = StaffFixtures.shiftId,
        status: String = "manager_confirmed",
        state: String? = "confirmed",
        isToday: Bool = true,
        startsAt: String = "2026-10-21T09:00:00.000Z",
        endsAt: String = "2026-10-21T17:00:00.000Z",
        checkInRequired: Bool? = nil,
        checkedInAt: String? = nil,
        geofenceEnforced: Bool? = nil
    ) throws -> StaffOfferSummary {
        try StaffFixtures.decode(StaffOfferSummary.self, StaffFixtures.offerJSON(
            id: id,
            shiftId: shiftId,
            status: status,
            startsAt: startsAt,
            endsAt: endsAt,
            presentation: state.map { StaffFixtures.presentationJSON(state: $0, isToday: isToday) },
            checkInRequired: checkInRequired,
            checkedInAt: checkedInAt,
            geofenceEnforced: geofenceEnforced
        ))
    }

    private func attendance(status: String = "clocked_out", shiftId: String = StaffFixtures.shiftId, id: String = StaffFixtures.attendanceId, startsAt: String = "2026-10-21T09:00:00.000Z", workedMinutes: Int? = 450, payrollStatus: String? = nil, payrollApprovedPence: Int? = nil) throws -> StaffAttendanceSummary {
        try StaffFixtures.decode(StaffAttendanceSummary.self, StaffFixtures.attendanceJSON(
            id: id,
            status: status,
            shiftId: shiftId,
            clockOutAt: status == "clocked_in" ? nil : "2026-10-21T17:00:00.000Z",
            startsAt: startsAt,
            workedMinutes: workedMinutes,
            payrollStatus: payrollStatus,
            payrollApprovedPence: payrollApprovedPence
        ))
    }

    private let now = StaffFixtures.date("2026-10-21T08:00:00.000Z")

    // MARK: Current-confirmed rule

    func testCurrentConfirmedUsesTheServerPresentationAndPutsLiveFirst() throws {
        let later = try offer(id: "o-later", shiftId: "s-later", state: "confirmed", startsAt: "2026-10-22T09:00:00.000Z", endsAt: "2026-10-22T17:00:00.000Z")
        let today = try offer(id: "o-today", shiftId: "s-today", state: "confirmed")
        let live = try offer(id: "o-live", shiftId: "s-live", state: "live", startsAt: "2026-10-20T09:00:00.000Z", endsAt: "2026-10-20T17:00:00.000Z")
        let finished = try ["clockedOut", "complete", "ended", "expired"].enumerated().map { index, state in
            try offer(id: "o-f\(index)", shiftId: "s-f\(index)", state: state)
        }
        let pending = try offer(id: "o-p", shiftId: "s-p", status: "pending", state: "pending")
        let rows = StaffShiftRules.currentConfirmed([later, today, pending, live] + finished, now: now)
        XCTAssertEqual(rows.map(\.id), ["o-live", "o-today", "o-later"], "live stays even after its scheduled end; finished shifts move to History")
    }

    func testCurrentConfirmedFallsBackToScheduledEndOnOlderServers() throws {
        let running = try offer(state: nil, endsAt: "2026-10-21T17:00:00.000Z")
        XCTAssertTrue(StaffShiftRules.isCurrentConfirmed(running, now: now))
        XCTAssertFalse(StaffShiftRules.isCurrentConfirmed(running, now: StaffFixtures.date("2026-10-21T17:00:01.000Z")))
    }

    func testHomeDashboardCountsAndPrimaryPreference() throws {
        let todayOffer = try offer(id: "o-today", shiftId: "s-today", state: "confirmed")
        let upcoming = try offer(id: "o-next", shiftId: "s-next", state: "confirmed", isToday: false, startsAt: "2026-10-23T09:00:00.000Z", endsAt: "2026-10-23T17:00:00.000Z")
        let pendingA = try offer(id: "o-pa", shiftId: "s-pa", status: "pending", state: "pending")
        let pendingB = try offer(id: "o-pb", shiftId: "s-pb", status: "pending", state: "pending")
        var data = StaffHomeDashboard(offers: [upcoming, todayOffer, pendingA, pendingB], now: now)
        XCTAssertEqual(data.pending, 2)
        XCTAssertEqual(data.confirmed, 2)
        XCTAssertEqual(data.upcoming.map(\.id), ["o-today", "o-next"])
        XCTAssertEqual(data.primary?.id, "o-today")
        XCTAssertEqual(data.today?.id, "o-today")

        let live = try offer(id: "o-live", shiftId: "s-live", state: "live")
        data = StaffHomeDashboard(offers: [todayOffer, live], now: now)
        XCTAssertEqual(data.primary?.id, "o-live", "a live shift always wins the primary card")
    }

    // MARK: Home clock tile ("No Shift" etc.)

    func testHomeClockTileStates() throws {
        let noShift = StaffHomeClockTile.resolve(loading: false, live: false, today: nil, dashboardHasToday: false, isCompletedToday: false, needsCheckIn: false)
        XCTAssertEqual(noShift, StaffHomeClockTile(label: "No Shift", enabled: false))

        let loading = StaffHomeClockTile.resolve(loading: true, live: false, today: nil, dashboardHasToday: false, isCompletedToday: false, needsCheckIn: false)
        XCTAssertEqual(loading, StaffHomeClockTile(label: "Loading…", enabled: false))

        let today = try offer(checkInRequired: true)
        XCTAssertEqual(StaffHomeClockTile.resolve(loading: false, live: false, today: today, dashboardHasToday: true, isCompletedToday: false, needsCheckIn: true),
                       StaffHomeClockTile(label: "Check In", enabled: true))
        XCTAssertEqual(StaffHomeClockTile.resolve(loading: false, live: false, today: today, dashboardHasToday: true, isCompletedToday: false, needsCheckIn: false),
                       StaffHomeClockTile(label: "Clock in", enabled: true))
        XCTAssertEqual(StaffHomeClockTile.resolve(loading: false, live: true, today: today, dashboardHasToday: true, isCompletedToday: false, needsCheckIn: false),
                       StaffHomeClockTile(label: "Clock out", enabled: true))

        let tomorrow = try offer(isToday: false)
        XCTAssertEqual(StaffHomeClockTile.resolve(loading: false, live: false, today: tomorrow, dashboardHasToday: false, isCompletedToday: false, needsCheckIn: false),
                       StaffHomeClockTile(label: "Be Ready", enabled: false))

        let done = try offer(state: "complete")
        let completed = StaffHomeClockTile.isCompletedToday(loading: false, live: false, today: done, history: [], now: now)
        XCTAssertTrue(completed)
        XCTAssertEqual(StaffHomeClockTile.resolve(loading: false, live: false, today: done, dashboardHasToday: true, isCompletedToday: completed, needsCheckIn: false),
                       StaffHomeClockTile(label: "Complete", enabled: false))
    }

    // MARK: Job Details / clock state

    func testDetailStateFromTheServerProjection() throws {
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(state: "confirmed"), active: nil, history: [], clockableShiftId: nil, now: now), .clockIn)
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(state: "confirmed", isToday: false), active: nil, history: [], clockableShiftId: nil, now: now), .ready)
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(state: "live"), active: nil, history: [], clockableShiftId: nil, now: now), .clockOut)
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(status: "pending", state: "pending"), active: nil, history: [], clockableShiftId: nil, now: now), .offer)
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(status: "staff_accepted", state: "pending"), active: nil, history: [], clockableShiftId: nil, now: now), .pending)
        // A stale "live" projection after a recorded clock-out is reconciling, not clockable.
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(state: "live"), active: nil, history: [try attendance()], clockableShiftId: nil, now: now), .loading)
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(), active: nil, history: [], clockableShiftId: nil, loading: true, now: now), .loading)
        XCTAssertEqual(StaffDetailState.resolve(offer: try offer(), active: nil, history: [], clockableShiftId: nil, failed: true, now: now), .error)
    }

    func testClockScreenWithNoApplicableShiftShowsDisabledNoShift() {
        let state = StaffDetailState.clockScreen(completedAttendanceId: nil, loading: false, failed: false, requestedOfferMissing: false, selected: nil, active: nil, history: [], clockableShiftId: nil, now: now)
        XCTAssertNil(state)
        XCTAssertEqual(StaffClockAction.resolve(state: state, noShift: true, live: false, needsCheckIn: false, completed: false, teams: false), .noShift)
        XCTAssertEqual(StaffClockTimerModel.statusText(state), "No Shift")
    }

    /// needs Check In → checked in → can Clock In (the server's state wins
    /// over the offer); a legacy booking goes straight to Clock In.
    func testCheckInStateMachinePresentation() throws {
        let booking = try offer(checkInRequired: true, geofenceEnforced: false)
        let state = StaffDetailState.clockScreen(completedAttendanceId: nil, loading: false, failed: false, requestedOfferMissing: false, selected: booking, active: nil, history: [], clockableShiftId: booking.shiftId, now: now)
        XCTAssertEqual(state, .clockIn)

        // 1. Needs Check In.
        XCTAssertTrue(StaffCheckInRules.needsCheckIn(booking, state: nil))
        XCTAssertEqual(StaffClockAction.resolve(state: state, noShift: false, live: false, needsCheckIn: true, completed: false, teams: false), .checkIn)

        // 2. The server answers with a check-in → no longer needed.
        let checkedIn = try StaffFixtures.decode(StaffCheckInState.self, StaffFixtures.checkInStateJSON(checkedInAt: "2026-10-21T08:52:00.000Z"))
        XCTAssertFalse(StaffCheckInRules.needsCheckIn(booking, state: checkedIn))
        XCTAssertEqual(StaffCheckInRules.checkedInAt(booking, state: checkedIn), StaffFixtures.date("2026-10-21T08:52:00.000Z"))
        // 3. Clock In is unlocked.
        XCTAssertEqual(StaffClockAction.resolve(state: state, noShift: false, live: false, needsCheckIn: false, completed: false, teams: false), .clockIn)

        // Legacy booking (made before Check In shipped): straight to Clock In.
        let legacy = try offer(checkInRequired: false)
        XCTAssertFalse(StaffCheckInRules.needsCheckIn(legacy, state: nil))

        // Geofence flag: check-in state first, then offer; unknown stays nil.
        XCTAssertEqual(StaffCheckInRules.geofenceEnforced(state: nil, offer: booking), false)
        XCTAssertEqual(StaffCheckInRules.geofenceEnforced(state: checkedIn, offer: try offer(geofenceEnforced: true)), false)
        XCTAssertNil(StaffCheckInRules.geofenceEnforced(state: nil, offer: try offer()))

        // Window: server window first, else start − early minutes.
        XCTAssertEqual(StaffCheckInRules.opensAt(offer: booking, state: checkedIn, clockInEarlyMinutes: 15), StaffFixtures.date("2026-10-21T08:45:00.000Z"))
        XCTAssertEqual(StaffCheckInRules.opensAt(offer: booking, state: nil, clockInEarlyMinutes: 15), StaffFixtures.date("2026-10-21T08:45:00.000Z"))
        XCTAssertNil(StaffCheckInRules.opensAt(offer: booking, state: nil, clockInEarlyMinutes: nil))
    }

    // MARK: History gating

    func testHistoryShowsPayrollApprovedShiftsOnly() throws {
        let rows = StaffHistoryRules.build(history: [
            try attendance(id: "a-approved", payrollStatus: "approved", payrollApprovedPence: 9375),
            try attendance(id: "a-paid", startsAt: "2026-10-20T09:00:00.000Z", payrollStatus: "paid", payrollApprovedPence: 9000),
            try attendance(id: "a-pending", payrollStatus: "pending_approval"),
            try attendance(id: "a-none"),
            try attendance(id: "a-rejected", payrollStatus: "rejected"),
            try attendance(status: "clocked_in", id: "a-open", payrollStatus: "approved"),
            try attendance(status: "under_review", id: "a-review", startsAt: "2026-10-19T09:00:00.000Z", payrollStatus: "processing"),
        ], offers: [])
        XCTAssertEqual(rows.map(\.id), ["a-approved", "a-paid", "a-review"], "newest first; clocked out / signed / pending are NOT history")
        XCTAssertEqual(rows[0].badge, "Completed")
        XCTAssertFalse(rows[0].needsAttention)
        XCTAssertEqual(rows[2].badge, "Under review")
        XCTAssertTrue(rows[2].needsAttention)
        XCTAssertEqual(rows.filter { $0.matches(.needsAttention) }.count, 1)
        XCTAssertEqual(rows.filter { $0.matches(.completed) }.count, 2)
        XCTAssertTrue(StaffHistoryRules.awaitingPayroll(shiftId: StaffFixtures.shiftId, history: [try attendance(payrollStatus: "pending_approval")]))
    }

    func testVerifiedMinutesUseTheLondonCalendarMonth() throws {
        // 30 Sep 23:30 UTC is 1 Oct 00:30 in London (BST): an October shift.
        let rows = StaffHistoryRules.build(history: [
            try attendance(id: "a1", startsAt: "2026-09-30T23:30:00.000Z", workedMinutes: 300, payrollStatus: "approved"),
            try attendance(id: "a2", startsAt: "2026-10-20T09:00:00.000Z", workedMinutes: 425, payrollStatus: "paid"),
            try attendance(id: "a3", startsAt: "2026-09-29T09:00:00.000Z", workedMinutes: 480, payrollStatus: "paid"),
        ], offers: [])
        XCTAssertEqual(StaffHistoryRules.verifiedMinutesThisMonth(rows, now: StaffFixtures.date("2026-10-21T12:00:00.000Z")), 725)
        XCTAssertEqual(StaffFormat.hours(725), "12h 05m")
    }

    // MARK: Error code → message

    func testAttendanceErrorCodesMapToStaffMessages() {
        func conflict(_ code: String?, _ message: String, extra: [String: JSONValue] = [:]) -> APIError {
            var body: [String: JSONValue] = ["message": .string(message)]
            if let code { body["code"] = .string(code) }
            body.merge(extra) { $1 }
            return .conflict(ServerErrorPayload(message: message, code: code, body: body))
        }
        XCTAssertEqual(StaffAttendanceMessages.forStaff(conflict("OUTSIDE_GEOFENCE", "Outside the venue.", extra: ["venueName": .string("Harbour Hall")])),
                       "You're outside the venue's permitted check-in area.")
        XCTAssertEqual(StaffAttendanceMessages.forStaff(conflict("CHECK_IN_REQUIRED", "Check in first.")), "Check in at the venue before you clock in.")
        XCTAssertEqual(StaffAttendanceMessages.forStaff(conflict("CLOCK_IN_TOO_EARLY", "Too early: 2026-10-21T08:45:00.000Z")), "It is too early to clock in for this shift.")
        XCTAssertEqual(StaffAttendanceMessages.forStaff(conflict("LOCATION_STALE", "stale")), "Your location reading is out of date. Refresh your location and try again.")
        // Clock-in sends this text WITHOUT a code (B6): the server's text is shown.
        XCTAssertEqual(StaffAttendanceMessages.forStaff(conflict(nil, "This shift is not confirmed for you.")), "This shift is not confirmed for you.")
        XCTAssertEqual(StaffAttendanceMessages.forStaff(APIError.server(status: 500)), APIMessages.serverError)
        XCTAssertEqual(StaffAttendanceMessages.forStaff(APIError.offline), APIMessages.offline)
    }

    // MARK: Location pre-check and evidence timestamp

    func testLocationPrecheckRefusesWhatTheServerWouldRefuse() {
        let limits = StaffLocationEvidenceLimits(maxAccuracyM: 100, maxAgeSeconds: 120, maxFutureSkewSeconds: 30)
        let at = StaffFixtures.date("2026-10-21T09:00:00.000Z")
        let good = StaffLocationFix(lat: 1, lng: 1, accuracyM: 20, capturedAt: at)
        XCTAssertNil(StaffLocationPrecheck.rejection(good, limits: limits, now: at.addingTimeInterval(30)))
        let vague = StaffLocationFix(lat: 1, lng: 1, accuracyM: 150, capturedAt: at)
        XCTAssertEqual(StaffLocationPrecheck.rejection(vague, limits: limits, now: at), "LOCATION_ACCURACY_TOO_LOW")
        XCTAssertEqual(StaffLocationPrecheck.rejection(good, limits: limits, now: at.addingTimeInterval(121)), "LOCATION_STALE")
        XCTAssertNil(StaffLocationPrecheck.rejection(vague, limits: nil, now: at), "no published limits → the server decides")
    }

    func testLocationFixIsPlacedOnTheServerTimeline() {
        // The device clock is 10 minutes fast; the fix is 5 s old by that clock.
        let deviceNow = StaffFixtures.date("2026-10-21T09:10:00.000Z")
        let trusted = StaffFixtures.date("2026-10-21T09:00:00.000Z")
        let fix = StaffLocationFix.make(latitude: 51, longitude: -2, accuracy: 8, timestamp: deviceNow.addingTimeInterval(-5), trustedNow: trusted, deviceNow: deviceNow)
        XCTAssertEqual(fix.capturedAt, trusted.addingTimeInterval(-5))
        // A fix "from the future" (clock jump) never gets a negative age.
        let future = StaffLocationFix.make(latitude: 51, longitude: -2, accuracy: 8, timestamp: deviceNow.addingTimeInterval(30), trustedNow: trusted, deviceNow: deviceNow)
        XCTAssertEqual(future.capturedAt, trusted)
    }

    // MARK: Server clock and timers

    func testServerClockAdvancesWithTheMonotonicClockOnly() {
        var clock = StaffServerClock()
        XCTAssertNil(clock.now(monotonicNanos: 5), "no server answer yet → no time (never the device clock)")
        let server = StaffFixtures.date("2026-10-21T09:00:00.000Z")
        clock.anchor(server, monotonicNanos: 1_000_000_000)
        XCTAssertEqual(clock.now(monotonicNanos: 91_000_000_000), server.addingTimeInterval(90))
        clock.anchor(nil, monotonicNanos: 200_000_000_000)
        XCTAssertEqual(clock.now(monotonicNanos: 91_000_000_000), server.addingTimeInterval(90), "a missing serverNow keeps the last anchor")
    }

    func testLiveTimerIsServerNowMinusClockIn() throws {
        let live = try attendance(status: "clocked_in")
        let model = StaffClockTimerModel.compute(now: live.clockInAt.addingTimeInterval(3723), startsAt: live.startsAt, attendance: live, live: true, completed: false, confirmed: false, status: "Clocked In")
        XCTAssertEqual(model.seconds, 3723)
        XCTAssertEqual(StaffFormat.clock(3723), "01:02:03")
        XCTAssertEqual(model.label, "LIVE SHIFT")
        XCTAssertEqual(model.badge, "Clocked In")
        XCTAssertEqual(model.phase, .onShift)

        let unknown = StaffClockTimerModel.compute(now: nil, startsAt: live.startsAt, attendance: live, live: true, completed: false, confirmed: false, status: "Clocked In")
        XCTAssertNil(unknown.seconds, "no trusted time → '—', never a device-clock value")
    }

    func testCountdownBeforeStartOverdueAndCompleted() throws {
        let start = StaffFixtures.date("2026-10-21T09:00:00.000Z")
        let soon = StaffClockTimerModel.compute(now: start.addingTimeInterval(-600), startsAt: start, attendance: nil, live: false, completed: false, confirmed: true, status: "Shift confirmed")
        XCTAssertEqual(soon.seconds, 600)
        XCTAssertEqual(soon.label, "STARTS IN")
        XCTAssertEqual(soon.badge, "Start in 10m")
        XCTAssertTrue(soon.warning)
        XCTAssertEqual(soon.phase, .beforeStart)
        XCTAssertEqual(soon.phase?.heading, "Your shift starts in")

        let overdue = StaffClockTimerModel.compute(now: start.addingTimeInterval(120), startsAt: start, attendance: nil, live: false, completed: false, confirmed: true, status: "Shift confirmed")
        XCTAssertEqual(overdue.label, "CLOCK-IN OVERDUE")
        XCTAssertEqual(overdue.badge, "Clock-in overdue")
        XCTAssertEqual(overdue.phase, .inProgress)
        XCTAssertEqual(overdue.phase?.heading, "Shift in progress")

        let record = try attendance(workedMinutes: 450)
        let done = StaffClockTimerModel.compute(now: nil, startsAt: start, attendance: record, live: false, completed: true, confirmed: false, status: "Clocked Out")
        XCTAssertEqual(done.seconds, 450 * 60, "worked time is the server's workedMinutes")
        XCTAssertEqual(done.label, "COMPLETED")
    }

    // MARK: Money and dates (Europe/London, overnight, DST)

    func testMoneyFormatting() {
        XCTAssertEqual(Money.formatPence(123_456), "£1234.56")
        XCTAssertEqual(Money.payRateLabel(1250), "£12.50/h")
        XCTAssertEqual(Money.payRateLabel(0), "Rate not set")
        XCTAssertEqual(Money.estimatedPayLabel(ratePence: 1250, estimatedPence: 10000), "£100.00 estimated pay")
    }

    func testLondonTimesAcrossSummerWinterAndOvernight() {
        XCTAssertEqual(CrewflowDateFormat.time(StaffFixtures.date("2026-07-01T08:00:00.000Z")), "09:00", "BST")
        XCTAssertEqual(CrewflowDateFormat.time(StaffFixtures.date("2026-12-01T08:00:00.000Z")), "08:00", "GMT")
        let start = StaffFixtures.date("2026-12-04T22:00:00.000Z")
        let end = StaffFixtures.date("2026-12-05T06:00:00.000Z")
        XCTAssertEqual(CrewflowDateFormat.timeRange(start, end), "22:00 - 06:00 (+1 day)")
        XCTAssertEqual(StaffFormat.timeSpan(start, end), "22:00 – 06:00")
        XCTAssertEqual(StaffFormat.nextDaySuffix(start, end), " (+1d)")
    }

    func testDSTNightKeepsRealElapsedDurationAndCalendarDays() throws {
        // Clocks go back at 02:00 BST on Sun 25 Oct 2026: 00:00 BST → 07:00 GMT is 8 real hours.
        let start = StaffFixtures.date("2026-10-24T23:00:00.000Z")
        let end = StaffFixtures.date("2026-10-25T07:00:00.000Z")
        XCTAssertEqual(StaffFormat.timeSpan(start, end), "00:00 – 07:00")
        let member = StaffTeamMember(displayName: "Alex", startsAt: start, endsAt: end, isYou: false)
        XCTAssertEqual(StaffTeamRules.durationLabel(member), "8h")

        let night = try offer(startsAt: "2026-10-24T23:00:00.000Z", endsAt: "2026-10-25T07:00:00.000Z")
        let calendar = StaffFormat.london
        let saturday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 24)))
        let sunday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 25)))
        XCTAssertFalse(StaffCalendarRules.occurs(night, onDayStarting: saturday, calendar: calendar), "starts at 00:00 London on the 25th")
        XCTAssertTrue(StaffCalendarRules.occurs(night, onDayStarting: sunday, calendar: calendar))
        XCTAssertEqual(StaffCalendarRules.summary([night]), "1 shift · 8 hours")
    }

    func testCalendarOvernightShiftAppearsOnBothDaysAndStatuses() throws {
        let overnight = try offer(startsAt: "2026-12-04T22:00:00.000Z", endsAt: "2026-12-05T06:00:00.000Z")
        let calendar = StaffFormat.london
        let friday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 12, day: 4)))
        let saturday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 12, day: 5)))
        XCTAssertTrue(StaffCalendarRules.occurs(overnight, onDayStarting: friday, calendar: calendar))
        XCTAssertTrue(StaffCalendarRules.occurs(overnight, onDayStarting: saturday, calendar: calendar))
        XCTAssertEqual(StaffCalendarRules.summary([]), "0 shifts")
        XCTAssertEqual(StaffCalendarRules.status(try offer(status: "staff_accepted", state: "pending"), active: false, ended: false), .awaiting)
        XCTAssertEqual(StaffCalendarRules.status(try offer(status: "pending", state: "pending"), active: false, ended: false), .open)
        XCTAssertEqual(StaffCalendarRules.status(try offer(state: nil), active: true, ended: false), .live)
        XCTAssertFalse(StaffCalendarRules.includes(try offer(status: "declined", state: "declined")))
    }

    func testOfferBadges() throws {
        XCTAssertEqual(StaffShiftRules.offerBadge(try offer(status: "pending", state: "pending")), "New Offer")
        XCTAssertEqual(StaffShiftRules.offerBadge(try offer(status: "staff_accepted", state: "pending")), "Awaiting confirmation")
        XCTAssertEqual(StaffShiftRules.offerBadge(try offer(state: "confirmed")), "Confirmed")
        XCTAssertEqual(StaffShiftRules.offerBadge(try offer(state: "live")), "Live now")
    }
}

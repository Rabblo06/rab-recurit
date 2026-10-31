import XCTest
@testable import Crewflow

/// Phase C1b realtime client against a scripted transport and a virtual
/// clock: 204/404 disable, 401/403 stop, 429 waits Retry-After, watchdog
/// reconnect, sustained-connection backoff reset, background close, dedupe,
/// recipient check, event → refresh maps, reconnect reconcile, identity stop.
/// Plus the SSE parser and the `APIClient` stream opener.
///
/// Written, not run (no macOS here): never compiled or executed.
@MainActor
final class RealtimeClientTests: XCTestCase {
    private var clock: VirtualClock!
    private var events: Recorder!
    private var reconciles = 0

    override func setUp() async throws {
        try await super.setUp()
        URLProtocolStub.server.reset()
        clock = VirtualClock()
        events = Recorder()
        reconciles = 0
    }

    private func makeRealtime(_ transport: FakeRealtimeTransport, random: Double = 0.5) -> RealtimeClient {
        var configuration = RealtimeClient.Configuration()
        configuration.coalesce = 0
        let clock = self.clock!
        return RealtimeClient(
            transport: transport,
            configuration: configuration,
            sleeper: clock.sleeper,
            now: { clock.now },
            random: { random }
        )
    }

    private func start(_ client: RealtimeClient, identity: GenerationBox? = nil, userId: String? = RealtimeFixtures.userId) async {
        let events = self.events!
        var identityClosure: (@MainActor () async -> UInt64)?
        if let identity {
            identityClosure = { identity.value }
        }
        await client.start(
            foreground: true,
            identity: identityClosure,
            userId: userId,
            onEvents: { types in
                for type in types.sorted() { events.add(type) }
            },
            onReconnect: { [weak self] in self?.reconciles += 1 }
        )
    }

    // MARK: Disabled / stopped

    func testNoContentMeansDisabledUntilTheNextSession() async {
        let transport = FakeRealtimeTransport([.status(204)])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .disabled }
        client.setForeground(false)
        client.setForeground(true)
        client.setVisible(false)
        client.setVisible(true)
        clock.advance(3600)
        await settle()
        XCTAssertEqual(transport.opens, 1, "a disabled gateway is never retried by this client")
        XCTAssertEqual(clock.pending, 0)
    }

    func testMissingRouteIsTreatedAsDisabled() async {
        let transport = FakeRealtimeTransport([.status(404)])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .disabled }
        XCTAssertEqual(transport.opens, 1)
    }

    func testForbiddenStops() async {
        let transport = FakeRealtimeTransport([.status(403)])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .stopped }
        clock.advance(3600)
        await settle()
        XCTAssertEqual(transport.opens, 1)
    }

    func testUnauthorizedAfterTheRefreshPathStops() async {
        // The APIClient already tried its one shared refresh; a rejected one
        // ended the session and surfaces as `.unauthorized`.
        let transport = FakeRealtimeTransport([.failure(.unauthorized(message: APIMessages.sessionExpired))])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .stopped }
        clock.advance(3600)
        await settle()
        XCTAssertEqual(transport.opens, 1, "never a reconnect loop on an ended session")
    }

    // MARK: 429 and backoff

    func testRateLimitWaitsRetryAfter() async {
        let stream = FakeEventStream()
        let transport = FakeRealtimeTransport([.status(429, retryAfter: "7"), .stream(stream)])
        let client = makeRealtime(transport, random: 0)
        await start(client)
        await waitUntil { client.status == .waiting && self.clock.pending == 1 }
        XCTAssertEqual(client.lastDelay, 7)
        clock.advance(6.9)
        await settle()
        XCTAssertEqual(transport.opens, 1, "not before Retry-After")
        clock.advance(0.2)
        await waitUntil { client.status == .connected }
        XCTAssertEqual(transport.opens, 2)
    }

    func testRateLimitWithoutHeaderWaitsThirtySeconds() async {
        let transport = FakeRealtimeTransport([.status(429)])
        let client = makeRealtime(transport, random: 0)
        await start(client)
        await waitUntil { client.status == .waiting && self.clock.pending == 1 }
        XCTAssertEqual(client.lastDelay, 30)
    }

    func testFailuresBackOffWithJitterAndCap() async {
        let transport = FakeRealtimeTransport(Array(repeating: .failure(.offline), count: 8))
        let client = makeRealtime(transport, random: 0.5)
        await start(client)
        var delays: [TimeInterval] = []
        for attempt in 1...7 {
            await waitUntil { client.status == .waiting && transport.opens == attempt && self.clock.pending == 1 }
            delays.append(client.lastDelay ?? 0)
            clock.advance(client.lastDelay ?? 0)
        }
        // 0.75 × (1, 2, 4, 8, 16, 30, 30): ×2 steps, 50–100 % jitter, 30 s cap.
        XCTAssertEqual(delays, [0.75, 1.5, 3, 6, 12, 22.5, 22.5])
    }

    // MARK: Watchdog and sustained connections

    func testWatchdogReconnectsAfterTwoMissedKeepalives() async {
        let first = FakeEventStream()
        let second = FakeEventStream()
        let transport = FakeRealtimeTransport([.stream(first), .stream(second)])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .connected && self.clock.pending == 1 }

        clock.advance(20)
        first.keepalive()
        await settle()
        clock.advance(30) // 50 s since connect, 30 s since the keepalive
        await waitUntil { self.clock.requested.count == 2 && self.clock.pending == 1 }
        XCTAssertEqual(transport.opens, 1, "a keepalive keeps the stream")
        XCTAssertFalse(first.isTerminated)

        clock.advance(20) // 50 s of silence
        await waitUntil { client.status == .waiting && self.clock.pending == 1 }
        XCTAssertTrue(first.isTerminated, "the silent stream was dropped")
        clock.advance(client.lastDelay ?? 0)
        await waitUntil { client.status == .connected && transport.opens == 2 }
    }

    func testBackoffResetsOnlyAfterASustainedConnection() async {
        let short = FakeEventStream()
        let long = FakeEventStream()
        let transport = FakeRealtimeTransport([.stream(short), .stream(long), .failure(.offline)])
        let client = makeRealtime(transport, random: 0.5)
        await start(client)
        await waitUntil { client.status == .connected }
        short.finish()
        await waitUntil { client.status == .waiting && self.clock.pending == 1 }
        XCTAssertEqual(client.attempt, 1)
        clock.advance(client.lastDelay ?? 0)
        await waitUntil { client.status == .connected && transport.opens == 2 }

        for _ in 0..<3 {
            clock.advance(25)
            long.keepalive()
            await settle()
        }
        long.finish()
        await waitUntil { client.status == .waiting && transport.opens == 2 }
        XCTAssertEqual(client.attempt, 1, "75 s up: the backoff started over")
        XCTAssertEqual(client.lastDelay, 0.75)
    }

    // MARK: Lifecycle

    func testBackgroundClosesTheStreamAndResumeReconnects() async {
        let first = FakeEventStream()
        let second = FakeEventStream()
        let transport = FakeRealtimeTransport([.stream(first), .stream(second)])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .connected }

        client.setForeground(false)
        await waitUntil { first.isTerminated }
        XCTAssertEqual(client.status, .idle)
        clock.advance(3600)
        await settle()
        XCTAssertEqual(transport.opens, 1, "no connection while in the background")

        client.setForeground(true)
        await waitUntil { client.status == .connected && transport.opens == 2 }
        XCTAssertEqual(reconciles, 0, "the shell reconciles on resume itself")
    }

    func testReconnectAfterADropReconciles() async {
        let first = FakeEventStream()
        let second = FakeEventStream()
        let transport = FakeRealtimeTransport([.stream(first), .stream(second)])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .connected }
        XCTAssertEqual(reconciles, 0, "the first connect follows the shell's own load")
        first.finish()
        await waitUntil { client.status == .waiting && self.clock.pending == 1 }
        clock.advance(client.lastDelay ?? 0)
        await waitUntil { transport.opens == 2 && client.status == .connected }
        XCTAssertEqual(reconciles, 1, "events missed while down are reconciled from the API")
    }

    func testIdentityChangeStopsAndDropsEvents() async {
        let first = FakeEventStream()
        let transport = FakeRealtimeTransport([.stream(first), .stream(FakeEventStream())])
        let identity = GenerationBox(1)
        let client = makeRealtime(transport)
        await start(client, identity: identity)
        await waitUntil { client.status == .connected }

        identity.value = 2
        first.event(RealtimeFixtures.envelope(type: "offer.sent"), id: "e1", type: "offer.sent")
        await settle()
        XCTAssertTrue(events.items.isEmpty, "never delivered into another identity")
        await waitUntil { client.status == .stopped }
        first.finish()
        clock.advance(3600)
        await settle()
        XCTAssertEqual(transport.opens, 1)
    }

    // MARK: Events

    func testEventsAreDedupedCheckedAndOnlyTriggerRefreshes() async {
        let stream = FakeEventStream()
        let transport = FakeRealtimeTransport([.stream(stream)])
        let client = makeRealtime(transport)
        await start(client)
        await waitUntil { client.status == .connected }

        let eventId = "11111111-2222-4333-8444-555555555555"
        stream.event(RealtimeFixtures.envelope(eventId: eventId, type: "offer.sent"), id: eventId, type: "offer.sent")
        await waitUntil { self.events.items == ["offer.sent"] }

        // The same event again (at-least-once delivery), another person's
        // event, an unknown type and garbage: nothing more.
        stream.event(RealtimeFixtures.envelope(eventId: eventId, type: "offer.sent"), id: eventId, type: "offer.sent")
        stream.event(RealtimeFixtures.envelope(type: "offer.sent", targetUserId: RealtimeFixtures.otherUserId), id: "x", type: "offer.sent")
        stream.event(RealtimeFixtures.envelope(type: "navigation_layout.saved"), id: "y", type: "navigation_layout.saved")
        stream.send("data: {not json")
        stream.send("")
        await settle()
        XCTAssertEqual(events.items, ["offer.sent"])

        stream.event(RealtimeFixtures.envelope(type: "attendance.changed"), id: "z", type: "attendance.changed")
        await waitUntil { self.events.items == ["offer.sent", "attendance.changed"] }
    }

    func testWithoutAKnownUserNoEventIsApplied() async {
        let stream = FakeEventStream()
        let transport = FakeRealtimeTransport([.stream(stream)])
        let client = makeRealtime(transport)
        await start(client, userId: nil)
        await waitUntil { client.status == .connected }
        stream.event(RealtimeFixtures.envelope(type: "offer.sent"), id: "a", type: "offer.sent")
        await settle()
        XCTAssertEqual(events.items, [], "the recipient check never passes without a user")
    }

    func testEventTypesMapToTheStoresExistingRefreshes() {
        XCTAssertEqual(StaffRealtimeRefresh.refreshes(for: ["offer.sent", "offer.withdrawn"]), [.offers])
        XCTAssertEqual(StaffRealtimeRefresh.refreshes(for: ["shift.cancelled"]), [.offers])
        XCTAssertEqual(StaffRealtimeRefresh.refreshes(for: ["attendance.changed"]), [.attendance, .history])
        XCTAssertEqual(StaffRealtimeRefresh.refreshes(for: ["payroll.record_changed"]), [.history])
        XCTAssertEqual(StaffRealtimeRefresh.refreshes(for: ["notification.created"]), [.unreadCount])
        XCTAssertTrue(StaffRealtimeRefresh.refreshes(for: ["shift_request.created"]).isEmpty)

        XCTAssertTrue(VMRealtimeRefresh.needsRefresh(["offer.accepted"]))
        XCTAssertTrue(VMRealtimeRefresh.needsRefresh(["shift_request.approved"]))
        XCTAssertTrue(VMRealtimeRefresh.needsRefresh(["shift.updated"]))
        XCTAssertTrue(VMRealtimeRefresh.needsRefresh(["attendance.changed"]))
        XCTAssertFalse(VMRealtimeRefresh.needsRefresh(["notification.created", "payroll.record_changed"]))
    }

    func testStaffEventRefreshesOnlyWhatItNamesInTheBackground() async {
        let server = URLProtocolStub.server
        server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/notifications/unread-count") { return .json(200, #"{"count":3}"#) }
            return .json(200, #"{"data":[],"nextCursor":null}"#)
        }
        let store = makeStaffStore()
        await store.applyRealtime(StaffRealtimeRefresh.refreshes(for: ["notification.created"]))
        XCTAssertEqual(server.requests.map { $0.url?.path ?? "" }, ["/rest/v1/notifications/unread-count"])
        XCTAssertEqual(server.requests.first?.value(forHTTPHeaderField: "X-Crewflow-Background"), "1")
        XCTAssertEqual(store.unreadCount, 3)
    }

    // MARK: Wire format

    func testSSEParserHandlesCRLFCommentsAndMultiLineData() throws {
        var splitter = SSELineSplitter()
        var lines: [String] = []
        for byte in Array("id: 1\r\nevent: offer.sent\r\ndata: {\"a\":\ndata: 1}\r\n\r\n: keepalive\n\n".utf8) {
            if let line = try splitter.push(byte) { lines.append(line) }
        }
        XCTAssertEqual(lines, ["id: 1", "event: offer.sent", "data: {\"a\":", "data: 1}", "", ": keepalive", ""])

        var parser = SSEParser()
        let dispatched = lines.compactMap { parser.feed($0) }
        XCTAssertEqual(dispatched, [SSEEvent(type: "offer.sent", data: "{\"a\":\n1}", id: "1")], "a comment alone dispatches nothing")
    }

    func testOverlongLineIsRefused() {
        var splitter = SSELineSplitter(maxLineBytes: 8)
        XCTAssertThrowsError(try Array(repeating: UInt8(0x61), count: 9).forEach { _ = try splitter.push($0) })
    }

    func testEnvelopeValidation() {
        XCTAssertNotNil(RealtimeEnvelope.parse(RealtimeFixtures.envelope(type: "offer.sent")))
        XCTAssertNil(RealtimeEnvelope.parse(RealtimeFixtures.envelope(type: "offer.unknown")))
        XCTAssertNil(RealtimeEnvelope.parse(RealtimeFixtures.envelope(eventId: "not-a-uuid", type: "offer.sent")))
        XCTAssertNil(RealtimeEnvelope.parse(RealtimeFixtures.envelope(type: "offer.sent").replacingOccurrences(of: #""version":1"#, with: #""version":2"#)))
        XCTAssertNil(RealtimeEnvelope.parse(RealtimeFixtures.envelope(type: "offer.sent").replacingOccurrences(of: #""targetUserId":"\#(RealtimeFixtures.userId)""#, with: #""targetUserId":null"#)), "recipient-only events need a recipient")
        XCTAssertNil(RealtimeEnvelope.parse(""))
    }

    // MARK: APIClient stream opener

    func testStreamUsesTheExistingAuthAndIsBackgroundTraffic() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "ACCESS", refreshToken: "R")
        URLProtocolStub.server.setHandler { _ in .empty(204) }
        let opened = try await client.openEventStream("/realtime/stream")
        XCTAssertEqual(opened.status, 204)
        let request = try XCTUnwrap(URLProtocolStub.server.requests.first)
        XCTAssertEqual(request.url?.path, "/rest/v1/realtime/stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ACCESS", "never a token in the URL")
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Crewflow-Background"), "1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Platform"), "mobile")
    }

    func testStreamLinesKeepTheBlankLineThatEndsAnEvent() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "ACCESS", refreshToken: "R")
        URLProtocolStub.server.setHandler { _ in
            StubResponse(status: 200, headers: ["Content-Type": "text/event-stream"], body: Data(": keepalive\n\ndata: x\n\n".utf8))
        }
        let opened = try await client.openEventStream("/realtime/stream")
        XCTAssertEqual(opened.status, 200)
        var lines: [String] = []
        for try await line in opened.lines { lines.append(line) }
        XCTAssertEqual(lines, [": keepalive", "", "data: x", ""])
    }

    func testStreamRefreshesOnceOn401ThenRetries() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "OLD", refreshToken: "R")
        URLProtocolStub.server.setHandler { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/auth/refresh") { return .fixture("auth_refresh") }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer OLD" {
                return .json(401, #"{"statusCode":401,"message":"Unauthorized"}"#)
            }
            return .empty(204)
        }
        let opened = try await client.openEventStream("/realtime/stream")
        XCTAssertEqual(opened.status, 204)
        XCTAssertEqual(URLProtocolStub.server.requests(to: "/auth/refresh").count, 1, "the existing single refresh path")
        XCTAssertEqual(URLProtocolStub.server.requests(to: "/realtime/stream").count, 2)
    }

    func testStreamRejectedRefreshEndsTheSession() async throws {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "OLD", refreshToken: "R")
        URLProtocolStub.server.setHandler { request in
            if (request.url?.path ?? "").hasSuffix("/auth/refresh") { return .json(401, #"{"statusCode":401,"message":"Unauthorized"}"#) }
            return .json(401, #"{"statusCode":401,"message":"Unauthorized"}"#)
        }
        do {
            _ = try await client.openEventStream("/realtime/stream")
            XCTFail("expected the session to end")
        } catch {
            XCTAssertEqual((error as? APIError)?.endsSession, true)
        }
        XCTAssertNil(tokens.accessToken(), "the usual expiry path wiped the session")
    }
}


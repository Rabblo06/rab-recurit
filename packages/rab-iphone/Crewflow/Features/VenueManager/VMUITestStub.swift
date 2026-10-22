#if DEBUG
import Foundation

/// DEBUG-ONLY canned backend for the Venue Manager UI test
/// (CrewflowUITests/VenueManager). Compiled out of Release builds, never
/// reachable in production, and only active when the app is launched with
/// BOTH `-CrewflowUITesting` and `VMUITestStub.launchArgument`.
///
/// Selected by `UITestSupport.stubConfiguration` (App/AppEnvironment.swift).
enum VMUITestStub {
    static let launchArgument = "-CrewflowUITestVenueManagerStub"

    static func isRequested(_ processInfo: ProcessInfo) -> Bool {
        processInfo.arguments.contains(launchArgument)
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = APIClient.defaultConfiguration()
        configuration.protocolClasses = [VMUITestStubProtocol.self]
        return configuration
    }

    /// (status, JSON body) for a request path relative to `/rest/v1`.
    static func response(method: String, path: String) -> (Int, String) {
        let iso = ISO8601.string
        let calendar = VMDate.calendar
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
        let start = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        let end = calendar.date(bySettingHour: 17, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        let bare = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        switch (method, bare) {
        case ("POST", "/auth/login"):
            return (200, #"{"accessToken":"ui-access","refreshToken":"ui-refresh","refreshExpiresAt":"2099-01-01T00:00:00.000Z","sessionExpiresAt":"2099-01-01T00:00:00.000Z","mustResetPassword":false}"#)
        case ("POST", "/auth/logout"):
            return (204, "")
        case ("GET", "/auth/me"):
            return (200, #"{"id":"11111111-1111-4111-8111-111111111111","email":"vm.ui@example.com","firstName":"Val","lastName":"Manager","organisationId":"22222222-2222-4222-8222-222222222222","roles":["venue_manager"],"mustResetPassword":false,"isPlatformAdmin":false}"#)
        case ("GET", "/auth/capabilities"):
            return (200, #"{"staff.view":true,"schedule.view":true,"venue.view":true,"offer.send":false,"report.view":true,"staffing_request.create":true,"attendance.view":true,"attendance.edit":true,"review.create":true,"report.export":true}"#)
        case ("GET", "/shifts"):
            return (200, """
            {"data":[{"id":"33333333-3333-4333-8333-333333333333","venueId":"44444444-4444-4444-8444-444444444444","jobRoleId":"55555555-5555-4555-8555-555555555555","createdBy":"11111111-1111-4111-8111-111111111111","address":"1 Test Street","notes":null,"status":"partially_filled","startsAt":"\(iso(start))","endsAt":"\(iso(end))","breakMinutes":30,"requiredCount":3,"filledCount":1}],"total":1}
            """)
        case ("GET", "/venues"):
            return (200, #"{"data":[{"id":"44444444-4444-4444-8444-444444444444","name":"UI Test Venue"}],"total":1}"#)
        case ("GET", "/job-roles"):
            return (200, #"[{"id":"55555555-5555-4555-8555-555555555555","name":"Bartender"}]"#)
        case ("GET", "/offers"), ("GET", "/staff/venue-directory"):
            return (200, #"{"data":[],"total":0}"#)
        case ("GET", "/shifts/sent"):
            return (200, #"{"data":[],"total":0,"view":"all","counts":{"all":0,"pending":0,"accepted":0,"confirmed":0,"declined":0,"expired":0,"submitted":0}}"#)
        case ("GET", "/attendance/report/shifts"):
            return (200, #"{"data":[],"total":0,"serverNow":"\#(iso(Date()))"}"#)
        default:
            return (404, #"{"statusCode":404,"message":"Not found."}"#)
        }
    }
}

final class VMUITestStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        var path = url.path
        if let range = path.range(of: "/rest/v1") { path = String(path[range.upperBound...]) }
        let (status, body) = VMUITestStub.response(method: request.httpMethod ?? "GET", path: path)
        let headers = body.isEmpty ? [:] : ["Content-Type": "application/json"]
        if let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif

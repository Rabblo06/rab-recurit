#if DEBUG
import Foundation

/// UI-TEST-ONLY network stub for the Staff sign-in → Home journey
/// (CrewflowUITests/Staff). Compiled into Debug builds only (`#if DEBUG`):
/// it does not exist in a Release binary, so production can never answer
/// from it. It is used only when the app is launched with BOTH
/// `-CrewflowUITesting` (in-memory secrets, placeholder host) and
/// `StaffUITestStub.launchArgument`, selected by
/// `UITestSupport.stubConfiguration` (App/AppEnvironment.swift).
///
/// The answers are server-shaped fixtures with obviously synthetic names;
/// they are never shown outside a UI-test launch.
enum StaffUITestStub {
    static let launchArgument = "-CrewflowStaffStub"

    static func configuration() -> URLSessionConfiguration {
        let configuration = APIClient.defaultConfiguration()
        configuration.protocolClasses = [StaffUITestURLProtocol.self]
        return configuration
    }
}

final class StaffUITestURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let (status, body) = Self.answer(method: request.httpMethod ?? "GET", path: url.path)
        let headers = body.isEmpty ? [:] : ["Content-Type": "application/json"]
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func iso(_ date: Date) -> String { ISO8601.string(from: date) }

    static func answer(method: String, path: String) -> (Int, String) {
        let now = Date()
        let starts = now.addingTimeInterval(2 * 3600)
        let ends = now.addingTimeInterval(10 * 3600)
        switch (method, path) {
        case ("POST", let p) where p.hasSuffix("/auth/login"):
            return (200, #"{"accessToken":"ui-test-access","refreshToken":"ui-test-refresh","refreshExpiresAt":"\#(iso(now.addingTimeInterval(86_400)))","sessionExpiresAt":"\#(iso(now.addingTimeInterval(86_400)))","mustResetPassword":false}"#)
        case ("POST", let p) where p.hasSuffix("/auth/logout"):
            return (204, "")
        case ("GET", let p) where p.hasSuffix("/auth/me"):
            return (200, #"{"id":"00000000-0000-4000-8000-000000000001","email":"ui.test@example.com","firstName":"Uitest","lastName":"Staff","organisationId":"00000000-0000-4000-8000-0000000000aa","roles":["staff"],"mustResetPassword":false,"isPlatformAdmin":false}"#)
        case ("GET", let p) where p.hasSuffix("/auth/capabilities"):
            return (200, "{}")
        case ("GET", let p) where p.hasSuffix("/offers/mine"):
            return (200, "[\(offer(id: "1", shift: "11", status: "manager_confirmed", state: "confirmed", label: "Today's Shift", starts: starts, ends: ends, now: now)),\(offer(id: "2", shift: "12", status: "pending", state: "pending", label: "Next Shift", starts: starts.addingTimeInterval(86_400), ends: ends.addingTimeInterval(86_400), now: now))]")
        case ("GET", let p) where p.hasSuffix("/attendance/me/active"):
            return (200, #"{"attendance":null,"serverNow":"\#(iso(now))","clockInEarlyMinutes":15,"locationEvidence":{"maxAccuracyM":100,"maxAgeSeconds":120,"maxFutureSkewSeconds":30}}"#)
        case ("GET", let p) where p.hasSuffix("/attendance/me/history"):
            return (200, "[]")
        case ("GET", let p) where p.hasSuffix("/notifications/unread-count"):
            return (200, #"{"count":0}"#)
        case ("GET", let p) where p.hasSuffix("/notifications"):
            return (200, "[]")
        case ("GET", let p) where p.hasSuffix("/team"):
            return (200, "[]")
        default:
            return (404, #"{"statusCode":404,"message":"Not found."}"#)
        }
    }

    private static func offer(id: String, shift: String, status: String, state: String, label: String, starts: Date, ends: Date, now: Date) -> String {
        let offerId = "00000000-0000-4000-8000-0000000000\(id)0"
        let shiftId = "00000000-0000-4000-8000-0000000000\(shift)"
        return #"{"id":"\#(offerId)","status":"\#(status)","sentAt":"\#(iso(now))","expiresAt":"\#(iso(ends))","respondedAt":null,"declineReason":null,"staffAcceptedAt":null,"managerConfirmedAt":null,"managerRejectedAt":null,"rejectionReason":null,"estimatedPayPence":9600,"offerBatchId":null,"shiftId":"\#(shiftId)","startsAt":"\#(iso(starts))","endsAt":"\#(iso(ends))","venueName":"Test Venue","roleName":"Test Role","staffProfileId":"00000000-0000-4000-8000-0000000000bb","staffName":"Uitest Staff","payRatePence":1200,"venueAddress":null,"shiftNotes":null,"venuePhotoFileId":null,"checkInRequired":false,"checkedInAt":null,"checkInSource":null,"geofenceEnforced":false,"presentation":{"state":"\#(state)","homeLabel":"\#(label)","isToday":\#(state == "confirmed"),"serverNow":"\#(iso(now))","nextTransitionAt":null,"clockInAt":null,"clockOutAt":null,"timezone":"Europe/London"}}"#
    }
}
#endif

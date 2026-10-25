#if DEBUG
import Foundation

/// DEBUG-ONLY canned backend for the account-security UI tests
/// (CrewflowUITests/TwoFactor). Compiled out of Release builds (`#if DEBUG`),
/// so production can never answer from it, and only active when the app is
/// launched with BOTH `-CrewflowUITesting` and `launchArgument`
/// (`UITestSupport.stubConfiguration`, App/AppEnvironment.swift).
///
/// Server-shaped answers for the real routes (docs/account-security/
/// STEP1_REPORT.md); every value is obviously synthetic. Anything that is
/// not an auth/2FA route is answered by the Staff stub, so a successful
/// sign-in lands on the real Staff Home.
///
/// Scenario launch arguments:
/// - `challengeArgument`: `/auth/login` answers 409 SECOND_FACTOR_REQUIRED.
/// - `enrolledArgument` / `lowCodesArgument`: `GET /auth/mfa` starts as On
///   (10 codes) / On with 2 codes left.
/// - The email `update@example.com` answers 409 CLIENT_UPDATE_REQUIRED.
///
/// Codes: `123456` accepted; `000000` invalid (attemptsRemaining counts down
/// from 4); `999999` expired; `555555` exhausted; `111111` rate limited. The
/// recovery code `7K2M-9QXR-4TZB-8HWE` is accepted; the password
/// `wrong-password` is refused.
enum TwoFactorUITestStub {
    static let launchArgument = "-CrewflowTwoFactorStub"
    static let challengeArgument = "-CrewflowTwoFactorChallenge"
    static let enrolledArgument = "-CrewflowTwoFactorEnrolled"
    static let lowCodesArgument = "-CrewflowTwoFactorLowCodes"

    static let recoveryCodes = [
        "7K2M-9QXR-4TZB-8HWE", "Q2NC-6VLA-P9DY-3JKU", "M5SA-7RGX-W8BE-1FT0", "C3HU-9ZNE-V6LQ-5MYD", "R1XW-4PAK-J2GT-8CVS",
        "B7NP-3KQD-6XWT-2MZA", "H4RV-8JCE-1TYQ-9PKN", "D6WM-2ZSB-7FQH-4XRC", "N9TK-5GVA-3MDW-8JPE", "F2QX-7HRN-6BKZ-1WSM",
    ]

    static func configuration() -> URLSessionConfiguration {
        let configuration = APIClient.defaultConfiguration()
        configuration.protocolClasses = [TwoFactorUITestURLProtocol.self]
        return configuration
    }

    /// Mutable stub state (one app process per UI test).
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var challengeAtSignIn: Bool
        private var enabled: Bool
        private var remaining: Int
        private var attemptsRemaining = 4

        init(arguments: [String]) {
            challengeAtSignIn = arguments.contains(TwoFactorUITestStub.challengeArgument)
            let low = arguments.contains(TwoFactorUITestStub.lowCodesArgument)
            enabled = low || arguments.contains(TwoFactorUITestStub.enrolledArgument)
            remaining = low ? 2 : (enabled ? 10 : 0)
        }

        func answer(method: String, path: String, headers: [String: String], body: [String: Any]) -> (Int, String, [String: String]) {
            lock.lock()
            defer { lock.unlock() }
            let iso = ISO8601.string(from: Date().addingTimeInterval(300))
            switch (method, path) {
            case ("POST", "/auth/login"):
                if (body["email"] as? String)?.lowercased() == "update@example.com" {
                    return (409, #"{"statusCode":409,"code":"CLIENT_UPDATE_REQUIRED","message":"Update Crewflow to sign in. Your account uses two-factor authentication, and this version of the app can’t ask for your code."}"#, [:])
                }
                guard challengeAtSignIn else { return TwoFactorUITestStub.staff("POST", "/auth/login") }
                let capable = headers.first { $0.key.caseInsensitiveCompare("X-Client-Capabilities") == .orderedSame }?.value
                    .lowercased().contains("mfa-verify") == true
                guard capable else {
                    return (409, #"{"statusCode":409,"code":"CLIENT_UPDATE_REQUIRED","message":"Update Crewflow to sign in."}"#, [:])
                }
                attemptsRemaining = 4
                return (409, #"{"statusCode":409,"code":"SECOND_FACTOR_REQUIRED","requirement":"verify","challengeToken":"ui-test-challenge","challengeExpiresAt":"\#(iso)","message":"Enter the code from your authenticator app to finish signing in."}"#, [:])

            case ("POST", "/auth/mfa/challenge/verify"):
                let code = (body["code"] as? String ?? "").uppercased()
                switch code {
                case "123456", TwoFactorUITestStub.recoveryCodes[0]:
                    return TwoFactorUITestStub.staff("POST", "/auth/login")
                case "999999":
                    return (401, #"{"statusCode":401,"code":"MFA_CHALLENGE_EXPIRED","state":"expired","message":"Your sign-in expired. Please sign in again."}"#, [:])
                case "555555":
                    return (401, #"{"statusCode":401,"code":"MFA_CHALLENGE_EXHAUSTED","state":"locked","message":"Too many incorrect codes. Please sign in again."}"#, [:])
                case "111111":
                    return (429, #"{"statusCode":429,"code":"MFA_RATE_LIMITED","state":"locked","message":"Too many verification attempts. Please try again in 2 minutes.","retryAfter":120}"#, ["Retry-After": "120"])
                default:
                    attemptsRemaining = max(0, attemptsRemaining - 1)
                    if attemptsRemaining == 0 {
                        return (401, #"{"statusCode":401,"code":"MFA_CHALLENGE_EXHAUSTED","state":"locked","message":"Too many incorrect codes. Please sign in again."}"#, [:])
                    }
                    return (401, #"{"statusCode":401,"code":"MFA_CODE_INVALID","state":"invalid_code","message":"That code didn’t work. Check your authenticator app and try again.","attemptsRemaining":\#(attemptsRemaining)}"#, [:])
                }

            case ("POST", "/auth/mfa/challenge/cancel"):
                return (204, "", [:])

            case ("GET", "/auth/mfa"):
                return (200, status(), [:])

            case ("POST", "/auth/mfa/enrolment"):
                guard (body["currentPassword"] as? String) != "wrong-password" else {
                    return (403, #"{"statusCode":403,"message":"Re-enter your current password to continue.","error":"Forbidden"}"#, [:])
                }
                return (200, #"{"otpauthUri":"otpauth://totp/Crewflow:ui.test%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Crewflow&algorithm=SHA1&digits=6&period=30","qrDataUrl":"data:image/png;base64,AA==","manualKey":"JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP"}"#, [:])

            case ("POST", "/auth/mfa/enrolment/confirm"):
                guard (body["code"] as? String) == "123456" else {
                    // The owner-approved server change: 400 (was 401) with the same code.
                    return (400, #"{"statusCode":400,"code":"MFA_CODE_INVALID","message":"That code didn’t work. Check your authenticator app and try again."}"#, [:])
                }
                enabled = true
                remaining = 10
                return (200, codesBody(), [:])

            case ("POST", "/auth/mfa/recovery-codes"), ("POST", "/auth/mfa/disable"):
                guard (body["currentPassword"] as? String) != "wrong-password" else {
                    return (403, #"{"statusCode":403,"message":"Re-enter your current password to continue.","error":"Forbidden"}"#, [:])
                }
                guard (body["code"] as? String) == "123456" else {
                    return (403, #"{"statusCode":403,"code":"STEP_UP_MFA_INVALID","message":"That code didn’t work. Enter the current code from your authenticator app."}"#, [:])
                }
                if path == "/auth/mfa/disable" {
                    enabled = false
                    remaining = 0
                    return (204, "", [:])
                }
                remaining = 10
                return (200, codesBody(), [:])

            default:
                return TwoFactorUITestStub.staff(method, path)
            }
        }

        private func status() -> String {
            let enabledAt = enabled ? #""2026-10-24T09:00:00.000Z""# : "null"
            let total = enabled ? 10 : 0
            return #"{"enabled":\#(enabled),"enabledAt":\#(enabledAt),"recoveryCodesRemaining":\#(remaining),"recoveryCodesTotal":\#(total),"enforced":false,"enrolmentAvailable":true,"mobileChallenged":\#(enabled),"hasPassword":true,"linkedProviders":[],"ssoReauthProviders":[]}"#
        }

        private func codesBody() -> String {
            let list = TwoFactorUITestStub.recoveryCodes.map { "\"\($0)\"" }.joined(separator: ",")
            return #"{"recoveryCodes":[\#(list)]}"#
        }
    }

    static let state = State(arguments: ProcessInfo.processInfo.arguments)

    /// Everything that is not a 2FA route: the Staff stub's answers.
    fileprivate static func staff(_ method: String, _ path: String) -> (Int, String, [String: String]) {
        let (status, body) = StaffUITestURLProtocol.answer(method: method, path: "/rest/v1" + path)
        return (status, body, [:])
    }
}

final class TwoFactorUITestURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        var path = url.path
        if let range = path.range(of: "/rest/v1") { path = String(path[range.upperBound...]) }
        let (status, body, extraHeaders) = TwoFactorUITestStub.state.answer(
            method: request.httpMethod ?? "GET",
            path: path,
            headers: request.allHTTPHeaderFields ?? [:],
            body: Self.jsonBody(of: request)
        )
        var headers = body.isEmpty ? [:] : ["Content-Type": "application/json"]
        headers.merge(extraHeaders) { _, new in new }
        if let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    /// URLSession hands a protocol the body as a stream.
    private static func jsonBody(of request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            let size = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let count = stream.read(buffer, maxLength: size)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
        }
        guard !data.isEmpty, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}
#endif

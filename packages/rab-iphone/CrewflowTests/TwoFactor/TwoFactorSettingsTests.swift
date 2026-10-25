import XCTest
@testable import Crewflow

private let statusOnJSON = #"{"enabled":true,"enabledAt":"2026-10-24T09:00:00.000Z","recoveryCodesRemaining":8,"recoveryCodesTotal":10,"enforced":false,"enrolmentAvailable":true,"mobileChallenged":true,"hasPassword":true,"linkedProviders":["microsoft"],"ssoReauthProviders":[]}"#
private let statusOffJSON = #"{"enabled":false,"enabledAt":null,"recoveryCodesRemaining":0,"recoveryCodesTotal":0,"enforced":false,"enrolmentAvailable":true,"mobileChallenged":false,"hasPassword":true,"linkedProviders":[],"ssoReauthProviders":[]}"#
private let materialJSON = #"{"otpauthUri":"otpauth://totp/Crewflow:sam.staff%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Crewflow&algorithm=SHA1&digits=6&period=30","qrDataUrl":"data:image/png;base64,AA==","manualKey":"JBSW Y3DP EHPK 3PXP"}"#
private let codesJSON = #"{"recoveryCodes":["AAAA-BBBB-CCCC-DDDD","EEEE-FFFF-GGGG-HHHH"]}"#
private let wrongPasswordJSON = #"{"statusCode":403,"message":"Re-enter your current password to continue.","error":"Forbidden"}"#
private let enrolCodeInvalid400JSON = #"{"statusCode":400,"code":"MFA_CODE_INVALID","message":"That code didn’t work. Check your authenticator app and try again."}"#
private let enrolCodeInvalidJSON = #"{"statusCode":401,"code":"MFA_CODE_INVALID","message":"That code didn’t work. Check your authenticator app and try again."}"#
private let stepUpCodeInvalidJSON = #"{"statusCode":403,"code":"STEP_UP_MFA_INVALID","message":"That code didn’t work. Enter the current code from your authenticator app."}"#

@MainActor
private final class FixedFence: TwoFactorSessionFence {
    var epoch: UInt64 = 1
    func isCurrent(_ candidate: UInt64) -> Bool { candidate == epoch }
}

@MainActor
private final class FakeSecondFactorSession: SecondFactorVerifying {
    var secondFactorChallenge: SecondFactorChallenge? = SecondFactorChallenge(token: "t", expiresAt: nil, email: "sam.staff@example.com")
    var results: [SecondFactorVerifyResult] = []
    private(set) var calls: [(code: String, method: SecondFactorMethod)] = []
    private(set) var cancels = 0

    func verifySecondFactor(code: String, method: SecondFactorMethod) async -> SecondFactorVerifyResult {
        calls.append((code, method))
        return results.isEmpty ? .ignored : results.removeFirst()
    }

    func cancelSecondFactor() async { cancels += 1 }
}

// MARK: - Decoding and pure rules

@MainActor
final class TwoFactorModelTests: XCTestCase {
    private func decodeStatus(_ json: String) throws -> TwoFactorStatus {
        try CrewflowJSON.makeDecoder().decode(TwoFactorStatus.self, from: Data(json.utf8))
    }

    func testStatusDecodesStepOneFields() throws {
        let status = try decodeStatus(statusOnJSON)
        XCTAssertTrue(status.enabled)
        XCTAssertNotNil(status.enabledAt)
        XCTAssertEqual(status.recoveryCodesRemaining, 8)
        XCTAssertEqual(status.recoveryCodesTotal, 10)
        XCTAssertTrue(status.enrolmentAvailable)
        XCTAssertTrue(status.hasPassword)
        XCTAssertEqual(status.recoveryCodesSummary, "8 of 10 left")
        XCTAssertFalse(status.recoveryCodesLow)
    }

    func testOlderServerDecodesAndFailsClosed() throws {
        let status = try decodeStatus(#"{"enabled":true,"enabledAt":null,"recoveryCodesRemaining":3}"#)
        XCTAssertNil(status.recoveryCodesTotal)
        XCTAssertEqual(status.recoveryCodesSummary, "3 left", "no invented total")
        XCTAssertFalse(status.enrolmentAvailable, "unknown availability never offers Turn on")
        XCTAssertTrue(status.hasPassword, "unknown → ask for the password; the server decides")
        XCTAssertFalse(status.enforced)
    }

    func testLowCodesThresholdIsThree() throws {
        XCTAssertEqual(TwoFactorStatus.lowRecoveryCodesThreshold, 3)
        XCTAssertTrue(TwoFactorStatus(enabled: true, recoveryCodesRemaining: 3, recoveryCodesTotal: 10).recoveryCodesLow)
        XCTAssertFalse(TwoFactorStatus(enabled: true, recoveryCodesRemaining: 4, recoveryCodesTotal: 10).recoveryCodesLow)
        XCTAssertFalse(TwoFactorStatus(enabled: false, recoveryCodesRemaining: 0, recoveryCodesTotal: 0).recoveryCodesLow, "off is not 'low'")
        XCTAssertEqual(TwoFactorStatus(enabled: true, recoveryCodesRemaining: 2).lowCodesWarning,
                       "Only 2 recovery codes left. Save a new set to keep access to your account.")
        XCTAssertEqual(TwoFactorStatus(enabled: true, recoveryCodesRemaining: 1).lowCodesWarning,
                       "Only 1 recovery code left. Save a new set to keep access to your account.")
        XCTAssertTrue(TwoFactorStatus(enabled: true, recoveryCodesRemaining: 0).lowCodesWarning.hasPrefix("No recovery codes left"))
    }

    func testOTPAuthURIParsing() throws {
        let parsed = try XCTUnwrap(OTPAuthURI.parse("otpauth://totp/Crewflow:sam.staff%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Crewflow"))
        XCTAssertEqual(parsed.accountName, "sam.staff@example.com")
        XCTAssertEqual(parsed.issuer, "Crewflow")
        XCTAssertEqual(parsed.url.scheme, "otpauth")
        XCTAssertNil(OTPAuthURI.parse("https://example.com/totp/Crewflow:x?secret=ABC"), "only otpauth links are ever opened")
        XCTAssertNil(OTPAuthURI.parse("otpauth://hotp/Crewflow:x?secret=ABC&counter=1"))
        XCTAssertNil(OTPAuthURI.parse("otpauth://totp/Crewflow:x?issuer=Crewflow"), "no secret, nothing to hand over")
        let details = TwoFactorEnrolmentDetails(TwoFactorEnrolmentMaterial(otpauthUri: "not a uri", manualKey: "ABCD EFGH"))
        XCTAssertNil(details.otpauthURL, "a malformed link hides the Open button; the key stays")
        XCTAssertEqual(details.manualKey, "ABCD EFGH")
    }

    func testCodeFieldKeepsSixAsciiDigits() {
        XCTAssertEqual(OTPCodeField.sanitised("482 913"), "482913")
        XCTAssertEqual(OTPCodeField.sanitised("12345678"), "123456")
        XCTAssertEqual(OTPCodeField.sanitised("١٢٣٤٥٦"), "", "Arabic-Indic digits are not codes")
        XCTAssertEqual(OTPCodeField.sanitised("a1b2"), "12")
    }

    func testCopyValuesAndShareText() {
        XCTAssertEqual(SetupKeyBox.copyValue("JBSW Y3DP EHPK 3PXP"), "JBSWY3DPEHPK3PXP")
        let text = RecoveryCodeGrid.shareText(codes: ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"], email: "sam.staff@example.com")
        XCTAssertTrue(text.contains("AAAA-BBBB-CCCC-DDDD\nEEEE-FFFF-GGGG-HHHH"))
        XCTAssertTrue(text.contains("Account: sam.staff@example.com"))
    }

    func testSelfServiceErrorText() {
        func payload(_ json: String) -> ServerErrorPayload { ServerErrorPayload.parse(Data(json.utf8)) }
        XCTAssertEqual(TwoFactorErrorText.message(for: APIError.from(status: 403, payload: payload(wrongPasswordJSON))), TwoFactorErrorText.wrongPassword)
        XCTAssertEqual(TwoFactorErrorText.message(for: APIError.from(status: 401, payload: payload(enrolCodeInvalidJSON))), TwoFactorErrorText.wrongCode)
        let wrong400 = APIError.from(status: 400, payload: payload(enrolCodeInvalid400JSON))
        XCTAssertEqual(TwoFactorErrorText.message(for: wrong400), TwoFactorErrorText.wrongCode, "the upcoming 400 shape")
        XCTAssertFalse(wrong400.endsSession)
        XCTAssertEqual(TwoFactorErrorText.message(for: APIError.from(status: 403, payload: payload(stepUpCodeInvalidJSON))), TwoFactorErrorText.wrongProofCode)
        XCTAssertEqual(TwoFactorErrorText.message(for: APIError.offline), TwoFactorErrorText.uncertain)
        XCTAssertEqual(TwoFactorErrorText.message(for: APIError.from(status: 403, payload: payload(#"{"code":"MFA_REQUIRED_BY_POLICY","message":"Two-factor authentication is required for your account and can’t be turned off."}"#))),
                       "Two-factor authentication is required for your account and can’t be turned off.")
    }
}

// MARK: - Verification screen model

@MainActor
final class SecondFactorViewModelTests: XCTestCase {
    private func make(_ results: [SecondFactorVerifyResult] = []) -> (SecondFactorViewModel, FakeSecondFactorSession, () -> [String]) {
        let fake = FakeSecondFactorSession()
        fake.results = results
        var spoken: [String] = []
        let model = SecondFactorViewModel(session: fake, announce: { spoken.append($0) })
        return (model, fake, { spoken })
    }

    func testVerifyNeedsSixDigits() async {
        let (model, fake, _) = make()
        XCTAssertEqual(model.email, "sam.staff@example.com")
        model.code = "12345"
        XCTAssertFalse(model.canVerify)
        await model.verify()
        XCTAssertTrue(fake.calls.isEmpty)
        model.code = "123456"
        XCTAssertTrue(model.canVerify)
    }

    func testInvalidCodeShowsTheServersAttempts() async {
        let (model, _, spoken) = make([.failed(.invalidCode(attemptsRemaining: 3)), .failed(.invalidCode(attemptsRemaining: 1)), .failed(.invalidCode(attemptsRemaining: nil))])
        model.code = "000000"
        await model.verify()
        XCTAssertEqual(model.errorText, "That code didn’t work. Check your app and try again. 3 tries left.")
        XCTAssertTrue(model.codeIsInvalid)
        XCTAssertTrue(spoken().contains { $0.contains("3 tries left") }, "errors are announced")
        await model.verify()
        XCTAssertEqual(model.errorText, "That code didn’t work. Check your app and try again. 1 try left.")
        await model.verify()
        XCTAssertEqual(model.errorText, "That code didn’t work. Check your app and try again.", "no number without the server's count")
    }

    func testRefusedCodeIsNotAutoSubmittedAgain() async throws {
        let (model, fake, _) = make([.failed(.invalidCode(attemptsRemaining: 4))])
        model.code = "000000"
        await model.verify()
        XCTAssertEqual(fake.calls.count, 1)
        model.codeCompleted()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(fake.calls.count, 1, "the same refused code is only re-sent by a deliberate tap")
        model.code = "123456"
        model.codeEdited()
        XCTAssertNil(model.errorText, "editing clears the error")
        model.codeCompleted()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(fake.calls.count, 2)
        XCTAssertEqual(fake.calls.last?.code, "123456")
        XCTAssertEqual(fake.calls.last?.method, .authenticatorCode)
    }

    func testExpiredLockedAndIncompleteStartAgain() async {
        for (failure, ending) in [
            (SecondFactorFailure.expired, SecondFactorViewModel.Ending.expired),
            (.locked, .locked),
            (.signInIncomplete(message: "Something went wrong. Please try again."), .incomplete("Something went wrong. Please try again.")),
        ] {
            let (model, _, _) = make([.failed(failure)])
            model.code = "123456"
            await model.verify()
            XCTAssertEqual(model.ending, ending)
            XCTAssertFalse(model.canVerify, "nothing more is sent on a spent challenge")
        }
    }

    func testRateLimitAndConnectionKeepTheCodeScreen() async {
        let (model, _, _) = make([.failed(.rateLimited(message: "Too many requests. Please try again in 2 minutes.")), .failed(.connection(message: SecondFactorFailure.connectionMessage))])
        model.code = "123456"
        await model.verify()
        XCTAssertNil(model.ending)
        XCTAssertEqual(model.errorText, "Too many requests. Please try again in 2 minutes.")
        XCTAssertFalse(model.codeIsInvalid)
        await model.verify()
        XCTAssertEqual(model.errorText, SecondFactorFailure.connectionMessage)
    }

    func testRecoveryCodeMode() async {
        let (model, fake, _) = make([.failed(.invalidCode(attemptsRemaining: 2))])
        model.switchMode(.recovery)
        model.recoveryCode = "abc"
        XCTAssertFalse(model.canVerify)
        model.recoveryCode = "  7K2M-9QXR-4TZB-8HWE  "
        XCTAssertTrue(model.canVerify)
        await model.verify()
        XCTAssertEqual(fake.calls.first?.code, "7K2M-9QXR-4TZB-8HWE")
        XCTAssertEqual(fake.calls.first?.method, .recoveryCode)
        XCTAssertEqual(model.errorText, "That recovery code didn’t work. Check it and try again. 2 tries left.")
        model.switchMode(.authenticator)
        XCTAssertNil(model.errorText)
    }

    func testBackToSignInCancels() async {
        let (model, fake, _) = make()
        await model.backToSignIn()
        XCTAssertEqual(fake.cancels, 1)
    }
}

// MARK: - Settings, enrolment, turn off, regenerate (against the stub server)

@MainActor
final class TwoFactorFlowTests: XCTestCase {
    private var server: StubServer { URLProtocolStub.server }

    override func setUp() async throws {
        server.reset()
    }

    private func makeAPI() throws -> (TwoFactorAPI, TokenStore) {
        let (client, tokens) = makeClient()
        try tokens.store(accessToken: "access-token-1", refreshToken: "refresh-token-1")
        return (TwoFactorAPI(api: client), tokens)
    }

    func testStatusLoadsWithBearerAndRefreshesAnExpiredAccessToken() async throws {
        let (api, tokens) = try makeAPI()
        server.setHandler { request in
            if request.url!.path.hasSuffix("/auth/refresh") { return .fixture("auth_refresh") }
            return request.bearer == "Bearer access-token-2" ? .json(200, statusOnJSON) : .json(401, #"{"message":"Invalid or expired access token"}"#)
        }
        let model = TwoFactorSettingsModel(api: api, fence: FixedFence())

        await model.load()

        XCTAssertEqual(model.status?.enabled, true)
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 1, "an expired access token refreshes once on /auth/mfa")
        XCTAssertEqual(server.requests(to: "/auth/mfa").count, 2)
        XCTAssertEqual(tokens.accessToken(), "access-token-2")
        XCTAssertEqual(server.requests(to: "/auth/mfa").last?.value(forHTTPHeaderField: "X-Client-Capabilities"), "mfa-verify")
    }

    func testStatusFailureShowsRetryNotOff() async throws {
        let (api, _) = try makeAPI()
        server.setHandler { _ in .json(500, #"{"message":"Internal server error"}"#) }
        let model = TwoFactorSettingsModel(api: api, fence: FixedFence())
        await model.load()
        guard case .failed = model.state else { return XCTFail("expected a failure state, got \(model.state)") }
        XCTAssertNil(model.status)
    }

    func testStaleStatusIsDroppedAfterAccountSwitch() async throws {
        let (api, _) = try makeAPI()
        let gate = DispatchSemaphore(value: 0)
        server.setHandler { _ in
            gate.wait()
            return .json(200, statusOnJSON)
        }
        let fence = FixedFence()
        let model = TwoFactorSettingsModel(api: api, fence: fence)
        let load = Task { await model.load() }
        let deadline = Date().addingTimeInterval(2)
        while server.requests(to: "/auth/mfa").isEmpty, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        fence.epoch += 1
        gate.signal()
        await load.value
        XCTAssertNil(model.status, "a response for the previous identity is never shown")
    }

    func testEnrolmentFlowGatesDoneOnTheAcknowledgement() async throws {
        let (api, _) = try makeAPI()
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/mfa/enrolment":
                return request.jsonBody?["currentPassword"] as? String == "correct horse" ? .json(200, materialJSON) : .json(403, wrongPasswordJSON)
            case "/rest/v1/auth/mfa/enrolment/confirm":
                return request.jsonBody?["code"] as? String == "123456" ? .json(200, codesJSON) : .json(401, enrolCodeInvalidJSON)
            default:
                return .json(404, #"{"message":"Not found."}"#)
            }
        }
        let model = TwoFactorSetupModel(api: api, hasPassword: true)

        XCTAssertFalse(model.canContinue)
        model.password = "wrong"
        await model.startEnrolment()
        XCTAssertEqual(model.step, .confirmIdentity, "a wrong password stays on step 1")
        XCTAssertEqual(model.error, TwoFactorErrorText.wrongPassword)

        model.password = "correct horse"
        await model.startEnrolment()
        guard case .connect(let details) = model.step else { return XCTFail("expected the connect step, got \(model.step)") }
        XCTAssertEqual(details.accountName, "sam.staff@example.com")
        XCTAssertEqual(details.manualKey, "JBSW Y3DP EHPK 3PXP")
        XCTAssertNotNil(details.otpauthURL)
        XCTAssertEqual(model.password, "", "the password is not kept once used")

        model.code = "000000"
        await model.confirmCode()
        XCTAssertEqual(model.error, TwoFactorErrorText.wrongCode)
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 0, "a wrong enrolment code is not a session failure")
        guard case .connect = model.step else { return XCTFail("a wrong code keeps the connect step") }

        model.code = "123456"
        await model.confirmCode()
        XCTAssertEqual(model.step, .recoveryCodes(["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"]))
        XCTAssertFalse(model.canFinish, "Done stays disabled until the codes are acknowledged")
        model.acknowledged = true
        XCTAssertTrue(model.canFinish)
        model.acknowledged = false
        XCTAssertFalse(model.canFinish)
        XCTAssertEqual(server.requests(to: "/auth/mfa/enrolment/confirm").count, 2)
    }

    func testSSOOnlyAccountCannotContinueFromThePhone() async throws {
        let (api, _) = try makeAPI()
        let model = TwoFactorSetupModel(api: api, hasPassword: false)
        model.password = "anything"
        XCTAssertFalse(model.canContinue)
        await model.startEnrolment()
        XCTAssertTrue(server.requests.isEmpty, "nothing is sent for an account without a password")
    }

    func testWrongFirstCodeAs400IsNeverASessionExpiry() async throws {
        let (api, tokens) = try makeAPI()
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/mfa/enrolment": return .json(200, materialJSON)
            case "/rest/v1/auth/mfa/enrolment/confirm": return .json(400, enrolCodeInvalid400JSON)
            case "/rest/v1/auth/refresh": return .fixture("auth_refresh")
            default: return .json(404, #"{"message":"Not found."}"#)
            }
        }
        let model = TwoFactorSetupModel(api: api, hasPassword: true)
        model.password = "correct horse"
        await model.startEnrolment()
        model.code = "000000"
        await model.confirmCode()
        XCTAssertEqual(model.error, TwoFactorErrorText.wrongCode)
        guard case .connect = model.step else { return XCTFail("a wrong code keeps the connect step") }
        XCTAssertEqual(server.requests(to: "/auth/refresh").count, 0, "no refresh")
        XCTAssertEqual(server.requests(to: "/auth/mfa/enrolment/confirm").count, 1, "no replay")
        XCTAssertEqual(tokens.accessToken(), "access-token-1", "the session is untouched")
    }

    func testLostConfirmAnswerReloadsInsteadOfResending() async throws {
        let (api, _) = try makeAPI()
        server.setHandler { request in
            switch request.url!.path {
            case "/rest/v1/auth/mfa/enrolment": return .json(200, materialJSON)
            case "/rest/v1/auth/mfa/enrolment/confirm": return .failure(.timedOut)
            case "/rest/v1/auth/mfa": return .json(200, statusOnJSON)
            default: return .json(404, #"{"message":"Not found."}"#)
            }
        }
        let model = TwoFactorSetupModel(api: api, hasPassword: true)
        model.password = "correct horse"
        await model.startEnrolment()
        model.code = "123456"
        await model.confirmCode()

        XCTAssertEqual(model.step, .enabledWithoutCodes)
        XCTAssertEqual(server.requests(to: "/auth/mfa/enrolment/confirm").count, 1, "never resent")
        XCTAssertEqual(server.requests(to: "/auth/mfa").count, 1, "the status says what happened")
    }

    func testTurnOffSendsPasswordAndCode() async throws {
        let (api, _) = try makeAPI()
        server.setHandler { request in
            request.url!.path == "/rest/v1/auth/mfa/disable" ? .empty(204) : .json(404, #"{"message":"Not found."}"#)
        }
        let model = TwoFactorProofModel(action: .turnOff, api: api, hasPassword: true)
        model.password = "correct horse"
        XCTAssertFalse(model.canSubmit, "a current code is required too")
        model.code = "123456"
        XCTAssertTrue(model.canSubmit)

        await model.submit()

        let request = try XCTUnwrap(server.requests(to: "/auth/mfa/disable").first)
        XCTAssertEqual(request.jsonBody?["currentPassword"] as? String, "correct horse")
        XCTAssertEqual(request.jsonBody?["code"] as? String, "123456")
        XCTAssertEqual(Set(request.jsonBody?.keys.map { $0 } ?? []), ["currentPassword", "code"])
        XCTAssertEqual(model.outcome, .turnedOff)
        XCTAssertEqual(model.password, "")
    }

    func testTurnOffWithARecoveryCodeAndAWrongCode() async throws {
        let (api, _) = try makeAPI()
        server.setHandler { _ in .json(403, stepUpCodeInvalidJSON) }
        let model = TwoFactorProofModel(action: .turnOff, api: api, hasPassword: true)
        model.password = "correct horse"
        model.toggleRecoveryCode()
        model.recoveryCode = " AAAA-BBBB-CCCC-DDDD "
        XCTAssertTrue(model.canSubmit)
        await model.submit()
        XCTAssertEqual(server.requests(to: "/auth/mfa/disable").first?.jsonBody?["code"] as? String, "AAAA-BBBB-CCCC-DDDD")
        XCTAssertEqual(model.error, TwoFactorErrorText.wrongProofCode)
        XCTAssertNil(model.outcome)
    }

    func testRegenerateShowsNewCodesAndNeverRetries() async throws {
        let (api, _) = try makeAPI()
        server.setHandler { request in
            request.url!.path == "/rest/v1/auth/mfa/recovery-codes" ? .json(200, codesJSON) : .json(404, #"{"message":"Not found."}"#)
        }
        let model = TwoFactorProofModel(action: .regenerate, api: api, hasPassword: true)
        model.password = "correct horse"
        model.code = "123456"
        await model.submit()
        XCTAssertEqual(model.outcome, .newCodes(["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"]))
        XCTAssertFalse(model.acknowledged)
        XCTAssertFalse(model.canSubmit, "nothing more to send once the codes are shown")

        server.setHandler { _ in .json(503, #"{"message":"Service Unavailable"}"#) }
        let second = TwoFactorProofModel(action: .regenerate, api: api, hasPassword: true)
        second.password = "correct horse"
        second.code = "123456"
        await second.submit()
        XCTAssertEqual(second.error, TwoFactorErrorText.uncertain)
        XCTAssertEqual(server.requests(to: "/auth/mfa/recovery-codes").count, 2, "one call each, no automatic retry")
    }

    func testAlreadyOffCountsAsTurnedOff() async throws {
        let (api, _) = try makeAPI()
        server.setHandler { _ in .json(409, #"{"statusCode":409,"code":"MFA_NOT_ENABLED","message":"Two-factor authentication is already off."}"#) }
        let model = TwoFactorProofModel(action: .turnOff, api: api, hasPassword: true)
        model.password = "correct horse"
        model.code = "123456"
        await model.submit()
        XCTAssertEqual(model.outcome, .turnedOff)
    }
}

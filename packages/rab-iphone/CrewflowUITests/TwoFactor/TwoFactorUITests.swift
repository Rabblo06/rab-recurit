import XCTest

/// Account security on iPhone against the DEBUG-only canned backend
/// (`TwoFactorUITestStub`, compiled out of Release). Each test also attaches
/// a PNG of every design state it reaches (`ios-<base>@<w>x<h>`, the
/// UI_PLAN §6 names) with `.keepAlways`, so a CI run's .xcresult carries
/// screenshots of all 13 mobile states.
final class TwoFactorUITests: XCTestCase {
    private static let stub = "-CrewflowTwoFactorStub"
    private static let challenge = "-CrewflowTwoFactorChallenge"
    private static let lowCodes = "-CrewflowTwoFactorLowCodes"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launch(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CrewflowUITesting", Self.stub] + extra
        app.launch()
        return app
    }

    private func signIn(_ app: XCUIApplication, email: String = "ui.test@example.com") {
        let field = app.textFields["login.email"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "login email field")
        field.tap()
        field.typeText(email)
        let password = app.secureTextFields["login.password"]
        password.tap()
        password.typeText("correct horse battery staple")
        app.buttons["login.submit"].tap()
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    /// An element whose (possibly combined) accessibility label contains `text`.
    private func labelled(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func waitForLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate(format: "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: timeout), .completed, "expected label \(label)", file: file, line: line)
    }

    /// Attaches a PNG named like the design-comparison files.
    private func capture(_ app: XCUIApplication, _ base: String) {
        Thread.sleep(forTimeInterval: 0.6)
        let size = app.windows.firstMatch.frame.size
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(base)@\(Int(size.width))x\(Int(size.height))"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func openSecurity(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["Offer Details"].waitForExistence(timeout: 15), "Staff Home after sign-in")
        app.tabButton("profile").tap()
        let row = app.buttons["staff.profile.security"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(app.staticTexts["Two-factor authentication"].waitForExistence(timeout: 10))
    }

    // MARK: Sign-in (M7, M8, M9)

    func testVerifySignInInvalidCodeRecoveryThenHome() {
        let app = launch([Self.challenge])
        signIn(app)

        XCTAssertTrue(app.staticTexts["Verify your sign-in"].waitForExistence(timeout: 10), "the 409 challenge opens the code screen")
        XCTAssertTrue(labelled(app, containing: "ui.test@example.com").exists, "account chip from the typed email")
        capture(app, "mobile-code")

        let code = app.textFields["secondFactor.code"]
        code.tap()
        code.typeText("000000")
        let error = element(app, "secondFactor.error")
        XCTAssertTrue(error.waitForExistence(timeout: 10), "invalid code notice")
        XCTAssertTrue(error.label.contains("3 tries left"), "attempts from the server: \(error.label)")
        capture(app, "mobile-invalid")

        app.buttons["secondFactor.useRecovery"].tap()
        XCTAssertTrue(app.staticTexts["Use a recovery code"].waitForExistence(timeout: 5))
        capture(app, "mobile-recovery")

        app.buttons["secondFactor.useAuthenticator"].tap()
        let again = app.textFields["secondFactor.code"]
        XCTAssertTrue(again.waitForExistence(timeout: 5))
        again.tap()
        again.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "123456")
        XCTAssertTrue(app.staticTexts["Offer Details"].waitForExistence(timeout: 15), "a valid code lands on Staff Home")
    }

    func testRecoveryCodeSignsIn() {
        let app = launch([Self.challenge])
        signIn(app)
        XCTAssertTrue(app.staticTexts["Verify your sign-in"].waitForExistence(timeout: 10))
        app.buttons["secondFactor.useRecovery"].tap()
        let field = app.textFields["secondFactor.recoveryField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("7K2M-9QXR-4TZB-8HWE")
        app.buttons["secondFactor.verifyRecovery"].tap()
        XCTAssertTrue(app.staticTexts["Offer Details"].waitForExistence(timeout: 15))
    }

    // MARK: M10, M11

    func testExpiredChallengeStartsAgainWithTheEmailKept() {
        let app = launch([Self.challenge])
        signIn(app)
        let code = app.textFields["secondFactor.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        code.tap()
        code.typeText("999999")
        XCTAssertTrue(app.staticTexts["Let’s start again"].waitForExistence(timeout: 10))
        capture(app, "mobile-expired")

        app.buttons["secondFactor.backToSignIn"].tap()
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10), "back on the sign-in screen")
        XCTAssertEqual(email.value as? String, "ui.test@example.com")
    }

    func testUpdateRequiredScreen() {
        let app = launch([Self.challenge])
        signIn(app, email: "update@example.com")
        XCTAssertTrue(app.staticTexts["Update to sign in securely"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["update.store"].exists, "no store button without an allowlisted URL")
        capture(app, "mobile-update")
        app.buttons["update.back"].tap()
        XCTAssertTrue(app.textFields["login.email"].waitForExistence(timeout: 10))
    }

    // MARK: Settings (M1–M6, M12, M13)

    func testTurnOnSaveCodesRegenerateAndTurnOff() {
        let app = launch([])
        signIn(app)
        openSecurity(app)
        let status = element(app, "security.twoFactor.status")
        waitForLabel(status, "Off")
        capture(app, "mobile-off")

        app.buttons["security.twoFactor.turnOn"].tap()
        XCTAssertTrue(app.staticTexts["Confirm it’s you"].waitForExistence(timeout: 5))
        capture(app, "mobile-password")
        let password = app.secureTextFields["setup.password"]
        password.tap()
        password.typeText("correct horse battery staple")
        app.buttons["setup.continue"].tap()

        XCTAssertTrue(app.staticTexts["Connect your authenticator"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["setup.openAuthenticator"].exists)
        XCTAssertTrue(app.buttons["setup.copyKey"].exists)
        capture(app, "mobile-setup")
        let code = app.textFields["setup.code"]
        code.tap()
        code.typeText("123456")
        app.buttons["setup.confirm"].tap()

        XCTAssertTrue(app.staticTexts["Save your recovery codes"].waitForExistence(timeout: 10))
        XCTAssertTrue(labelled(app, containing: "7K2M-9QXR-4TZB-8HWE").exists, "the server's codes are shown")
        capture(app, "mobile-codes")
        let done = app.buttons["codes.done"]
        XCTAssertFalse(done.isEnabled, "Done is gated on the acknowledgement")
        element(app, "codes.saved").tap()
        XCTAssertTrue(done.isEnabled)
        done.tap()

        waitForLabel(status, "On")
        XCTAssertTrue(labelled(app, containing: "10 of 10 left").waitForExistence(timeout: 5))
        capture(app, "mobile-on")

        app.buttons["security.twoFactor.newCodes"].tap()
        XCTAssertTrue(app.staticTexts["Get new recovery codes"].waitForExistence(timeout: 5))
        capture(app, "mobile-regenerate")
        app.buttons["proof.cancel"].tap()

        app.buttons["security.twoFactor.turnOff"].tap()
        XCTAssertTrue(app.staticTexts["Turn off two-factor authentication?"].waitForExistence(timeout: 5))
        capture(app, "mobile-disable")
        let proofPassword = app.secureTextFields["proof.password"]
        proofPassword.tap()
        proofPassword.typeText("correct horse battery staple")
        let proofCode = app.textFields["proof.code"]
        proofCode.tap()
        proofCode.typeText("123456")
        app.buttons["proof.submit"].tap()
        waitForLabel(status, "Off")
    }

    func testLowRecoveryCodesWarning() {
        let app = launch([Self.lowCodes])
        signIn(app)
        openSecurity(app)
        XCTAssertTrue(element(app, "security.twoFactor.lowCodes").waitForExistence(timeout: 10))
        XCTAssertTrue(labelled(app, containing: "2 of 10 left").exists)
        capture(app, "mobile-low")
    }
}

import XCTest

/// Staff sign-in → Home against the DEBUG-only stub network
/// (`StaffUITestStub`, compiled out of Release). Selected by
/// `UITestSupport.stubConfiguration`; without the stub argument the
/// placeholder host is unreachable and sign-in fails (the test then says so).
final class StaffLoginHomeUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CrewflowUITesting", "-CrewflowStaffStub"]
        app.launch()
        return app
    }

    private func signIn(_ app: XCUIApplication) {
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10), "login email field")
        email.tap()
        email.typeText("ui.test@example.com")
        let password = app.secureTextFields["login.password"]
        password.tap()
        password.typeText("correct horse battery staple")
        app.buttons["login.submit"].tap()
    }

    func testStaffLoginLandsOnHomeWithServerData() {
        let app = launch()
        signIn(app)

        let heading = app.staticTexts["Offer Details"]
        if !heading.waitForExistence(timeout: 15) {
            if app.staticTexts["auth.error"].exists || app.otherElements["auth.error"].exists {
                XCTFail("Sign-in failed: the Staff UI-test stub was not selected by UITestSupport.stubConfiguration.")
            }
            XCTFail("Staff Home did not appear after sign-in")
            return
        }
        // Greeting uses the server identity's first name.
        XCTAssertTrue(app.staticTexts["Uitest"].exists)
        // Today's confirmed shift from /offers/mine, legacy booking → "Clock in".
        XCTAssertTrue(app.staticTexts["Test Role"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Clock in"].exists || app.staticTexts["Clock in"].exists)
        // One pending offer.
        XCTAssertTrue(app.staticTexts["1 offer – View"].exists)
        // The Staff tab bar.
        XCTAssertTrue(app.buttons["tab.calendar"].exists)
        XCTAssertTrue(app.buttons["tab.history"].exists)
        XCTAssertTrue(app.buttons["tab.profile"].exists)
    }

    func testHistoryTabNeverShowsUnapprovedWork() {
        let app = launch()
        signIn(app)
        XCTAssertTrue(app.staticTexts["Offer Details"].waitForExistence(timeout: 15))
        app.buttons["tab.history"].tap()
        // The stub returns no payroll-approved attendance.
        XCTAssertTrue(app.staticTexts["No approved shifts yet"].waitForExistence(timeout: 5))
    }

    func testProfileShowsPayslipsInboxSecurityAndLogOut() {
        let app = launch()
        signIn(app)
        XCTAssertTrue(app.staticTexts["Offer Details"].waitForExistence(timeout: 15))
        app.buttons["tab.profile"].tap()
        XCTAssertTrue(app.buttons["staff.profile.payslips"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["staff.profile.inbox"].exists)
        XCTAssertTrue(app.buttons["staff.profile.security"].exists)
        app.buttons["profile.signOut"].tap()
        XCTAssertTrue(app.textFields["login.email"].waitForExistence(timeout: 10), "log out returns to sign-in")
    }
}

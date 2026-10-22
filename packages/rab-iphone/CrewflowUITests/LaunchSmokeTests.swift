import XCTest

/// Smoke test: a fresh launch (in-memory secrets, no stored session, no
/// biometrics, no network) lands on the native sign-in screen.
final class LaunchSmokeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFreshLaunchShowsLogin() {
        let app = XCUIApplication()
        app.launchArguments = ["-CrewflowUITesting"]
        app.launch()

        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10), "login email field")
        XCTAssertTrue(app.secureTextFields["login.password"].exists, "password field, hidden by default")
        XCTAssertTrue(app.buttons["login.submit"].exists, "Sign In button")
        XCTAssertFalse(app.buttons["login.submit"].isEnabled, "disabled until both fields are filled")
        XCTAssertTrue(app.buttons["login.forgot"].exists)
        // Email + password only: no SSO buttons on iOS.
        XCTAssertFalse(app.buttons["Continue with Google"].exists)
        XCTAssertFalse(app.buttons["Continue with Microsoft"].exists)
    }

    func testForgotPasswordOpensAndCloses() {
        let app = XCUIApplication()
        app.launchArguments = ["-CrewflowUITesting"]
        app.launch()
        let forgot = app.buttons["login.forgot"]
        XCTAssertTrue(forgot.waitForExistence(timeout: 10))
        forgot.tap()
        XCTAssertTrue(app.staticTexts["Enter your email and we'll send you a reset link."].waitForExistence(timeout: 5))
        app.buttons["Back"].tap()
        XCTAssertTrue(app.textFields["login.email"].waitForExistence(timeout: 5))
    }
}

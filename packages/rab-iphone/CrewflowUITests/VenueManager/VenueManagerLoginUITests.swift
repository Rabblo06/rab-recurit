import XCTest

/// Venue Manager sign-in → Home against the DEBUG-only canned backend
/// (`VMUITestStub` in Features/VenueManager). Selected by
/// `UITestSupport.stubConfiguration`; Release builds contain
/// neither the stub nor the launch arguments.
final class VenueManagerLoginUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testVenueManagerSignInLandsOnHome() {
        let app = XCUIApplication()
        app.launchArguments = ["-CrewflowUITesting", "-CrewflowUITestVenueManagerStub"]
        app.launch()

        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("vm.ui@example.com")
        let password = app.secureTextFields["login.password"]
        password.tap()
        password.typeText("correct horse battery staple")
        app.buttons["login.submit"].tap()

        // Routed by /auth/me.roles (venue_manager) → the Venue Manager shell.
        XCTAssertTrue(app.otherElements["shell.venueManager"].waitForExistence(timeout: 15)
                      || app.scrollViews["vm.home"].waitForExistence(timeout: 5), "Venue Manager shell")
        XCTAssertTrue(app.staticTexts["Event Details"].waitForExistence(timeout: 10), "Organisation view")
        let nextEvent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Bartender")).firstMatch
        XCTAssertTrue(nextEvent.waitForExistence(timeout: 5), "next event from the canned /shifts")
        XCTAssertTrue(app.tabButton("home").exists)
        XCTAssertTrue(app.tabButton("history").exists)

        // My Space shows server counts ("—" never replaced by an invented 0).
        app.buttons["My Space"].tap()
        XCTAssertTrue(app.staticTexts["Overview"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["vm.home.users"].exists, "staff.view → Users row")
    }
}

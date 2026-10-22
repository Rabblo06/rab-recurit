import XCTest

extension XCUIApplication {
    /// The floating tab bar button `tab.<id>`. When it is missing, prints the
    /// whole accessibility tree to the test log so CI shows why.
    func tabButton(_ id: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let button = buttons["tab.\(id)"]
        if !button.waitForExistence(timeout: 5) {
            print("=== Accessibility tree: tab.\(id) not found ===\n\(debugDescription)")
            XCTFail("Tab button tab.\(id) not found", file: file, line: line)
        }
        return button
    }
}

import SwiftUI

/// M11: `409 CLIENT_UPDATE_REQUIRED`. This build already declares
/// `mfa-verify`, so it only sees this after a future capability bump; older
/// builds show the server's `message` in their own error line.
///
/// The App Store button exists only when the server sent an allowlisted
/// HTTPS App Store URL (`ClientUpdateRequired.updateURL`); there is no store
/// listing today, so the screen says where to update instead of guessing.
struct UpdateRequiredView: View {
    let notice: ClientUpdateRequired
    let onBack: () -> Void

    @Environment(\.openURL) private var openURL

    init(notice: ClientUpdateRequired, onBack: @escaping () -> Void) {
        self.notice = notice
        self.onBack = onBack
    }

    var body: some View {
        SecurityScreen(title: "Update required", onBack: onBack) {
            SecurityEmblem(systemImage: "iphone")
            SecurityHeading("Update to sign in securely", message: notice.message)
            SecurityNotice("Your account and shifts are safe. You’ll be able to sign in once the app is updated.")
            if notice.updateURL == nil {
                Text("Update Crewflow from where you installed it, then sign in again.")
                    .scheduleType(SecurityType.caption)
            }
        } actions: {
            if let url = notice.updateURL {
                SecurityButton("Open App Store", systemImage: "arrow.up.right") { openURL(url) }
                    .accessibilityIdentifier("update.store")
            }
            SecurityLinkButton("Back", action: onBack)
                .accessibilityIdentifier("update.back")
        }
    }
}

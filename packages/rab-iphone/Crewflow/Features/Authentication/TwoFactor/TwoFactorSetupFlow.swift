import Combine
import SwiftUI
import UIKit

/// M2 → M3 → M4: confirm identity, connect the authenticator, save the
/// recovery codes. The secret is generated server-side; this model only
/// carries what the server returned, in memory, for the life of the flow.
@MainActor
final class TwoFactorSetupModel: ObservableObject {
    enum Step: Equatable {
        case confirmIdentity
        case connect(TwoFactorEnrolmentDetails)
        case recoveryCodes([String])
        /// Confirm's answer was lost (timeout, offline, 5xx) but a reload
        /// shows 2FA is now on: the one-time codes cannot be shown again.
        case enabledWithoutCodes
    }

    @Published private(set) var step: Step = .confirmIdentity
    @Published var password = ""
    @Published var code = ""
    @Published var acknowledged = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?

    let hasPassword: Bool
    private let api: TwoFactorAPI

    init(api: TwoFactorAPI, hasPassword: Bool) {
        self.api = api
        self.hasPassword = hasPassword
    }

    var canContinue: Bool { hasPassword && !password.isEmpty && !busy }
    var canConfirmCode: Bool { code.count == OTPCodeField.length && !busy }
    /// Done is gated on the acknowledgement: the codes are shown once.
    var canFinish: Bool {
        if case .recoveryCodes = step { return acknowledged }
        return true
    }

    func startEnrolment() async {
        guard canContinue else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let material = try await api.startEnrolment(currentPassword: password)
            password = ""
            code = ""
            step = .connect(TwoFactorEnrolmentDetails(material))
        } catch {
            if (error as? APIError)?.isCancellation == true { return }
            // Includes 409 MFA_ALREADY_ENABLED ("Two-factor authentication
            // is already on."): closing the flow reloads the real status.
            self.error = TwoFactorErrorText.message(for: error)
        }
    }

    func confirmCode() async {
        guard canConfirmCode, case .connect = step else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let codes = try await api.confirmEnrolment(code: code)
            code = ""
            acknowledged = false
            step = .recoveryCodes(codes)
        } catch {
            if (error as? APIError)?.isCancellation == true { return }
            if let apiError = error as? APIError, apiError.isUncertainOutcome {
                // Never resend: ask the server what happened.
                if let status = try? await api.status(), status.enabled {
                    code = ""
                    step = .enabledWithoutCodes
                    return
                }
            }
            self.error = TwoFactorErrorText.message(for: error)
        }
    }

    /// Back from "Connect" to "Confirm it’s you". Continuing again stages a
    /// brand-new secret server-side; the shown key is discarded.
    func backToIdentity() {
        guard case .connect = step, !busy else { return }
        code = ""
        error = nil
        step = .confirmIdentity
    }
}

struct TwoFactorSetupFlow: View {
    @StateObject private var model: TwoFactorSetupModel
    private let email: String
    private let onClose: () -> Void
    @State private var openFailed = false
    @Environment(\.openURL) private var openURL

    init(api: TwoFactorAPI, email: String, hasPassword: Bool, onClose: @escaping () -> Void) {
        _model = StateObject(wrappedValue: TwoFactorSetupModel(api: api, hasPassword: hasPassword))
        self.email = email
        self.onClose = onClose
    }

    var body: some View {
        Group {
            switch model.step {
            case .confirmIdentity:
                identityStep
            case .connect(let details):
                connectStep(details)
            case .recoveryCodes(let codes):
                RecoveryCodesStep(
                    title: "Save your recovery codes",
                    showSteps: true,
                    codes: codes,
                    email: email,
                    acknowledged: $model.acknowledged,
                    onDone: onClose
                )
            case .enabledWithoutCodes:
                enabledWithoutCodes
            }
        }
        .sensitiveContentShield()
        .interactiveDismissDisabled()
    }

    // MARK: M2

    private var identityStep: some View {
        SecurityScreen(title: "Set up 2FA", onBack: onClose) {
            StepIndicator(current: 1)
            SecurityEmblem(systemImage: "lock")
            SecurityHeading("Confirm it’s you", message: "Enter your current password to start protecting your Crewflow account.")
            if model.hasPassword {
                SecurityField("Current password", isError: model.error != nil) {
                    PasswordField(placeholder: "Current password", text: $model.password, identifier: "setup.password")
                        .submitLabel(.continue)
                        .onSubmit { Task { @MainActor in await model.startEnrolment() } }
                }
            } else {
                SecurityNotice(TwoFactorErrorText.ssoOnly)
            }
            if let error = model.error {
                SecurityNotice(error, kind: .error, identifier: "setup.error")
            }
        } actions: {
            SecurityButton("Continue", isBusy: model.busy) {
                Task { @MainActor in await model.startEnrolment() }
            }
            .disabled(!model.canContinue)
            .accessibilityIdentifier("setup.continue")
        }
    }

    // MARK: M3

    private func connectStep(_ details: TwoFactorEnrolmentDetails) -> some View {
        SecurityScreen(title: "Set up 2FA", onBack: { model.backToIdentity() }) {
            StepIndicator(current: 2)
            SecurityEmblem(systemImage: "iphone")
            SecurityHeading("Connect your authenticator", message: "Open an authenticator on this phone, or copy the setup key into your preferred app.")
            if let url = details.otpauthURL {
                SecurityButton("Open authenticator app", systemImage: "arrow.up.right", kind: .secondary) {
                    openAuthenticator(url)
                }
                .accessibilityIdentifier("setup.openAuthenticator")
            }
            if openFailed {
                SecurityNotice("No authenticator app opened. Copy the setup key into your authenticator instead.")
            }
            SetupKeyBox(key: details.manualKey)
            if let account = details.accountName {
                Text("Account · \(account)").scheduleType(SecurityType.caption)
            }
            OTPCodeField(code: $model.code, isError: model.error != nil, identifier: "setup.code")
            if let error = model.error {
                SecurityNotice(error, kind: .error, identifier: "setup.error")
            }
        } actions: {
            SecurityButton("Confirm code", isBusy: model.busy) {
                Task { @MainActor in await model.confirmCode() }
            }
            .disabled(!model.canConfirmCode)
            .accessibilityIdentifier("setup.confirm")
        }
    }

    private func openAuthenticator(_ url: URL) {
        // Only an `otpauth://totp/…` link built from the server's answer
        // reaches here (TwoFactorEnrolmentDetails). It is never logged.
        openFailed = false
        openURL(url) { accepted in
            openFailed = !accepted
        }
    }

    // MARK: Lost confirm answer

    private var enabledWithoutCodes: some View {
        SecurityScreen(title: "Set up 2FA", showBack: false) {
            SecurityEmblem(systemImage: "checkmark.shield")
            SecurityHeading("Two-factor authentication is on", message: "We couldn’t show your recovery codes, and they can’t be shown again. Get a new set from Security now so you can still sign in if you lose your phone.")
        } actions: {
            SecurityButton("Done", action: onClose)
                .accessibilityIdentifier("setup.done")
        }
    }
}

/// M4 (and M13's result): the one-time recovery codes, copy and share
/// (owner decision), a real acknowledgement that gates Done, and a notice
/// when a screenshot is taken (iOS cannot prevent one).
struct RecoveryCodesStep: View {
    let title: String
    let showSteps: Bool
    let codes: [String]
    let email: String
    @Binding var acknowledged: Bool
    let onDone: () -> Void

    @State private var copied = false
    @State private var screenshotTaken = false

    init(title: String, showSteps: Bool, codes: [String], email: String, acknowledged: Binding<Bool>, onDone: @escaping () -> Void) {
        self.title = title
        self.showSteps = showSteps
        self.codes = codes
        self.email = email
        self._acknowledged = acknowledged
        self.onDone = onDone
    }

    private var shareText: String { RecoveryCodeGrid.shareText(codes: codes, email: email) }

    var body: some View {
        SecurityScreen(title: showSteps ? "Set up 2FA" : "Security", showBack: false) {
            if showSteps {
                StepIndicator(current: 3)
            }
            SecurityHeading(title, message: "Use a code if you lose access to your authenticator. Each works once, and won’t be shown again.")
            RecoveryCodeGrid(codes: codes)
            HStack(spacing: 12) {
                ShareLink(item: shareText, subject: Text("Crewflow recovery codes")) {
                    SecurityButtonLabel(title: "Share or save codes", systemImage: "square.and.arrow.down", kind: .secondary)
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityIdentifier("codes.share")
                Button {
                    SecurePasteboard.copy(codes.joined(separator: "\n"))
                    copied = true
                    SecurityNotice.announce("Recovery codes copied")
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(SecurityTokens.ink)
                        .frame(width: SecurityTokens.buttonHeight, height: SecurityTokens.buttonHeight)
                        .background(Circle().fill(SecurityTokens.surface))
                        .overlay(Circle().stroke(SecurityTokens.line, lineWidth: 1))
                        .contentShape(Circle())
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(copied ? "Recovery codes copied" : "Copy recovery codes")
                .accessibilityIdentifier("codes.copy")
            }
            if copied {
                Text("Copied. It stays on this iPhone and clears from the clipboard after \(Int(SecurePasteboard.lifetime / 60)) minutes.")
                    .scheduleType(SecurityType.caption)
            }
            if screenshotTaken {
                SecurityNotice("Screenshots are saved to your photo library. Keep it somewhere safe, or delete it once your codes are stored elsewhere.", kind: .warning)
            }
            SecurityCheckbox("I’ve saved these codes somewhere safe.", isOn: $acknowledged, identifier: "codes.saved")
        } actions: {
            SecurityButton("Done", action: onDone)
                .disabled(!acknowledged)
                .accessibilityHint(acknowledged ? "" : "Confirm you’ve saved these codes first")
                .accessibilityIdentifier("codes.done")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            screenshotTaken = true
        }
    }
}

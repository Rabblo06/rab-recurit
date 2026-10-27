import SwiftUI

/// What the verification screen needs from the session (a seam for tests).
@MainActor
protocol SecondFactorVerifying: AnyObject {
    var secondFactorChallenge: SecondFactorChallenge? { get }
    func verifySecondFactor(code: String, method: SecondFactorMethod) async -> SecondFactorVerifyResult
    func cancelSecondFactor() async
}

extension SessionCoordinator: SecondFactorVerifying {}

/// M7–M10: verify sign-in, invalid code, recovery code, start again.
/// Every number and state comes from the server's answer; nothing is
/// counted or timed here.
@MainActor
final class SecondFactorViewModel: ObservableObject {
    enum Mode: Equatable {
        case authenticator
        case recovery
    }

    /// Why the sign-in must start again (the design's "Let’s start again").
    enum Ending: Equatable {
        case expired
        case locked
        case incomplete(String)
    }

    enum InlineError: Equatable {
        case invalidCode(attemptsRemaining: Int?)
        case message(String)
    }

    @Published var mode: Mode = .authenticator
    @Published var code = ""
    @Published var recoveryCode = ""
    @Published private(set) var verifying = false
    @Published private(set) var error: InlineError?
    @Published private(set) var ending: Ending?

    let email: String
    private let session: SecondFactorVerifying
    private let announce: @MainActor (String) -> Void
    /// The authenticator code the server just refused: never auto-submitted
    /// again (only a deliberate tap re-sends it).
    private var lastRefusedCode: String?

    init(session: SecondFactorVerifying, announce: @escaping @MainActor (String) -> Void = { SecurityNotice.announce($0) }) {
        self.session = session
        self.announce = announce
        self.email = session.secondFactorChallenge?.email ?? ""
    }

    var trimmedRecoveryCode: String { recoveryCode.trimmingCharacters(in: .whitespacesAndNewlines) }

    var canVerify: Bool {
        guard !verifying, ending == nil else { return false }
        switch mode {
        case .authenticator: return code.count == OTPCodeField.length
        case .recovery: return trimmedRecoveryCode.count >= 6 && trimmedRecoveryCode.count <= 64
        }
    }

    /// The design's error notice. "N tries left" only when the server sent N.
    var errorText: String? {
        switch error {
        case .none:
            return nil
        case .invalidCode(let remaining)?:
            let lead = mode == .recovery
                ? "That recovery code didn’t work. Check it and try again."
                : "That code didn’t work. Check your app and try again."
            guard let remaining else { return lead }
            return lead + " \(remaining) \(remaining == 1 ? "try" : "tries") left."
        case .message(let text)?:
            return text
        }
    }

    /// The six boxes turn red only for a refused code.
    var codeIsInvalid: Bool {
        if case .invalidCode? = error { return mode == .authenticator }
        return false
    }

    /// Called by the code field when the sixth digit lands (typed, pasted or
    /// autofilled). Submits once per distinct code.
    func codeCompleted() {
        guard mode == .authenticator, canVerify, code != lastRefusedCode else { return }
        Task { @MainActor in await self.verify() }
    }

    /// Any edit after a refusal clears the error (the boxes return to normal).
    func codeEdited() {
        if error != nil, code != lastRefusedCode { error = nil }
    }

    func switchMode(_ newMode: Mode) {
        guard mode != newMode, !verifying else { return }
        mode = newMode
        error = nil
        // Coming back to the boxes starts from an empty code.
        if newMode == .authenticator { code = "" }
    }

    func verify() async {
        guard canVerify else { return }
        let method: SecondFactorMethod = mode == .authenticator ? .authenticatorCode : .recoveryCode
        let submitted = mode == .authenticator ? code : trimmedRecoveryCode
        verifying = true
        error = nil
        let result = await session.verifySecondFactor(code: submitted, method: method)
        verifying = false
        switch result {
        case .signedIn, .ignored:
            break
        case .failed(let failure):
            apply(failure, submitted: submitted)
        }
    }

    private func apply(_ failure: SecondFactorFailure, submitted: String) {
        switch failure {
        case .invalidCode(let remaining):
            if mode == .authenticator { lastRefusedCode = submitted }
            error = .invalidCode(attemptsRemaining: remaining)
        case .expired:
            ending = .expired
        case .locked:
            ending = .locked
        case .signInIncomplete(let message):
            ending = .incomplete(message)
        case .rateLimited(let message), .connection(let message), .rejected(let message):
            error = .message(message)
        }
        if let errorText { announce("Error. " + errorText) }
        if ending != nil { announce("Your sign-in needs to start again.") }
    }

    func backToSignIn() async {
        await session.cancelSecondFactor()
    }
}

/// Routed by `RootView` while `session.phase == .secondFactor`.
struct SecondFactorView: View {
    @EnvironmentObject private var session: SessionCoordinator

    init() {}

    var body: some View {
        SecondFactorContent(session: session)
    }
}

private struct SecondFactorContent: View {
    @StateObject private var model: SecondFactorViewModel
    @State private var leaving = false

    init(session: SessionCoordinator) {
        _model = StateObject(wrappedValue: SecondFactorViewModel(session: session))
    }

    var body: some View {
        Group {
            if let ending = model.ending {
                startAgain(ending)
            } else if model.mode == .recovery {
                recovery
            } else {
                authenticator
            }
        }
    }

    private func back() {
        guard !leaving else { return }
        leaving = true
        Task { @MainActor in await model.backToSignIn() }
    }

    // MARK: M7 / M8

    private var authenticator: some View {
        SecurityScreen(title: "Verification", onBack: back) {
            SecurityEmblem(systemImage: "checkmark.shield")
            SecurityHeading("Verify your sign-in", message: "Open your authenticator app and enter the 6-digit code for Crewflow.")
            if !model.email.isEmpty {
                accountChip
            }
            OTPCodeField(
                code: $model.code,
                isError: model.codeIsInvalid,
                identifier: "secondFactor.code",
                autoFocus: true,
                onComplete: { model.codeCompleted() }
            )
            .onChange(of: model.code) { _ in model.codeEdited() }
            if let text = model.errorText {
                SecurityNotice(text, kind: .error, identifier: "secondFactor.error")
            }
        } actions: {
            SecurityButton("Verify", isBusy: model.verifying) {
                Task { @MainActor in await model.verify() }
            }
            .disabled(!model.canVerify)
            .accessibilityIdentifier("secondFactor.verify")
            SecurityLinkButton("Use a recovery code") { model.switchMode(.recovery) }
                .accessibilityIdentifier("secondFactor.useRecovery")
        }
    }

    // MARK: M9

    private var recovery: some View {
        SecurityScreen(title: "Verification", onBack: { model.switchMode(.authenticator) }) {
            SecurityEmblem(systemImage: "key")
            SecurityHeading("Use a recovery code", message: "Enter one of the codes you saved when you turned on two-factor authentication.")
            SecurityField("Recovery code", isError: model.errorText != nil) {
                TextField("XXXX-XXXX-XXXX-XXXX", text: $model.recoveryCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .submitLabel(.go)
                    .onSubmit { Task { @MainActor in await model.verify() } }
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .accessibilityLabel("Recovery code")
                    .accessibilityIdentifier("secondFactor.recoveryField")
            }
            SecurityNotice("Each code can only be used once.")
            if let text = model.errorText {
                SecurityNotice(text, kind: .error, identifier: "secondFactor.error")
            }
        } actions: {
            SecurityButton("Verify recovery code", isBusy: model.verifying) {
                Task { @MainActor in await model.verify() }
            }
            .disabled(!model.canVerify)
            .accessibilityIdentifier("secondFactor.verifyRecovery")
            SecurityLinkButton("Use an authenticator code instead") { model.switchMode(.authenticator) }
                .accessibilityIdentifier("secondFactor.useAuthenticator")
        }
    }

    // MARK: M10 (expired and locked, merged as designed)

    private func startAgain(_ ending: SecondFactorViewModel.Ending) -> some View {
        SecurityScreen(title: "Verification", onBack: back) {
            SecurityEmblem(systemImage: "arrow.clockwise")
            SecurityHeading("Let’s start again", message: Self.endingMessage(ending))
            SecurityNotice(Self.endingNotice(ending), kind: .warning)
        } actions: {
            SecurityButton("Back to sign in", isBusy: leaving, action: back)
                .accessibilityIdentifier("secondFactor.backToSignIn")
            Text("Lost your phone and codes?\nContact your workspace admin or Crewflow support.")
                .scheduleType(SecurityType.caption)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }

    static func endingMessage(_ ending: SecondFactorViewModel.Ending) -> String {
        switch ending {
        case .expired:
            return "Your verification session has expired. Sign in with your password again to continue."
        case .locked:
            return "There were too many incorrect codes. Sign in with your password again to continue."
        case .incomplete:
            return "Your code was accepted, but we couldn’t finish signing you in. Sign in with your password again to continue."
        }
    }

    static func endingNotice(_ ending: SecondFactorViewModel.Ending) -> String {
        switch ending {
        case .expired:
            // The TTL is server configuration and is not sent: no number.
            return "Verification sessions expire after a few minutes."
        case .locked:
            return "For your security, this sign-in was stopped after too many incorrect codes."
        case .incomplete(let message):
            return message
        }
    }

    private var accountChip: some View {
        HStack(spacing: 8) {
            Text(String(model.email.prefix(1)).uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(SecurityTokens.avatarText)
                .frame(width: 24, height: 24)
                .background(Circle().fill(SecurityTokens.avatar))
                .accessibilityHidden(true)
            Text(model.email)
                .scheduleType(SecurityType.caption)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Signing in as \(model.email)")
    }
}

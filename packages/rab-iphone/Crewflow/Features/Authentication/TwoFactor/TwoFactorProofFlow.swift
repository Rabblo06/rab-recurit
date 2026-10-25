import SwiftUI

/// M12 (turn off) and M13 (new recovery codes): both need the current
/// password AND a current code (TOTP or one recovery code) in the same
/// request (`StepUpReauthService.assertIdentityProof`, requireFactor).
@MainActor
final class TwoFactorProofModel: ObservableObject {
    enum Action: Equatable {
        case turnOff
        case regenerate
    }

    enum Outcome: Equatable {
        case turnedOff
        case newCodes([String])
    }

    @Published var password = ""
    @Published var code = ""
    @Published var recoveryCode = ""
    @Published private(set) var useRecoveryCode = false
    @Published var acknowledged = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var outcome: Outcome?

    let action: Action
    let hasPassword: Bool
    private let api: TwoFactorAPI

    init(action: Action, api: TwoFactorAPI, hasPassword: Bool) {
        self.action = action
        self.api = api
        self.hasPassword = hasPassword
    }

    private var trimmedRecovery: String { recoveryCode.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var factor: String? {
        if useRecoveryCode {
            let value = trimmedRecovery
            return value.count >= 6 && value.count <= 64 ? value : nil
        }
        return code.count == OTPCodeField.length ? code : nil
    }

    var canSubmit: Bool {
        hasPassword && !password.isEmpty && factor != nil && !busy && outcome == nil
    }

    func toggleRecoveryCode() {
        guard !busy else { return }
        useRecoveryCode.toggle()
        error = nil
    }

    func submit() async {
        guard canSubmit, let factor = self.factor else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            switch action {
            case .turnOff:
                try await api.disable(currentPassword: password, code: factor)
                finish(.turnedOff)
            case .regenerate:
                let codes = try await api.regenerateRecoveryCodes(currentPassword: password, code: factor)
                acknowledged = false
                finish(.newCodes(codes))
            }
        } catch {
            guard let apiError = error as? APIError else {
                self.error = TwoFactorErrorText.uncertain
                return
            }
            if apiError.isCancellation { return }
            if action == .turnOff, apiError.code == "MFA_NOT_ENABLED" {
                // Already off (another device): the goal is reached.
                finish(.turnedOff)
                return
            }
            // Includes the uncertain outcomes: nothing is resent. Closing
            // reloads the real status.
            self.error = TwoFactorErrorText.message(for: error)
            code = ""
        }
    }

    private func finish(_ result: Outcome) {
        password = ""
        code = ""
        recoveryCode = ""
        outcome = result
    }
}

struct TurnOffTwoFactorView: View {
    private let api: TwoFactorAPI
    private let hasPassword: Bool
    private let onClose: () -> Void

    init(api: TwoFactorAPI, hasPassword: Bool, onClose: @escaping () -> Void) {
        self.api = api
        self.hasPassword = hasPassword
        self.onClose = onClose
    }

    var body: some View {
        TwoFactorProofScreen(action: .turnOff, api: api, email: "", hasPassword: hasPassword, onClose: onClose)
    }
}

struct RegenerateCodesView: View {
    private let api: TwoFactorAPI
    private let email: String
    private let hasPassword: Bool
    private let onClose: () -> Void

    init(api: TwoFactorAPI, email: String, hasPassword: Bool, onClose: @escaping () -> Void) {
        self.api = api
        self.email = email
        self.hasPassword = hasPassword
        self.onClose = onClose
    }

    var body: some View {
        TwoFactorProofScreen(action: .regenerate, api: api, email: email, hasPassword: hasPassword, onClose: onClose)
    }
}

private struct TwoFactorProofScreen: View {
    @StateObject private var model: TwoFactorProofModel
    /// Next on the password keyboard moves to the code field: with the keyboard up, the floating action bar covers the
    /// code field, so it could not be tapped without scrolling first (ci-iphone run 40169603561).
    @State private var focusCode = false
    private let email: String
    private let onClose: () -> Void

    init(action: TwoFactorProofModel.Action, api: TwoFactorAPI, email: String, hasPassword: Bool, onClose: @escaping () -> Void) {
        _model = StateObject(wrappedValue: TwoFactorProofModel(action: action, api: api, hasPassword: hasPassword))
        self.email = email
        self.onClose = onClose
    }

    private var turnOff: Bool { model.action == .turnOff }

    var body: some View {
        Group {
            switch model.outcome {
            case .newCodes(let codes)?:
                RecoveryCodesStep(
                    title: "Save your new recovery codes",
                    showSteps: false,
                    codes: codes,
                    email: email,
                    acknowledged: $model.acknowledged,
                    onDone: onClose
                )
                .sensitiveContentShield()
            case .turnedOff?, .none:
                form
            }
        }
        .interactiveDismissDisabled(model.busy || model.outcome != nil)
        .onChange(of: model.outcome) { outcome in
            if outcome == .turnedOff { onClose() }
        }
    }

    private var form: some View {
        SecurityScreen(title: "Security", onBack: onClose) {
            SecurityEmblem(systemImage: turnOff ? "lock" : "key")
            SecurityHeading(
                turnOff ? "Turn off two-factor authentication?" : "Get new recovery codes",
                message: turnOff
                    ? "Your password will be the only step needed to sign in."
                    : "Confirm your identity to replace your current recovery codes."
            )
            if model.hasPassword {
                SecurityField("Current password", isError: model.error != nil) {
                    PasswordField(
                        placeholder: "Current password",
                        text: $model.password,
                        identifier: "proof.password",
                        submitLabel: model.useRecoveryCode ? .done : .next,
                        onSubmit: { if !model.useRecoveryCode { focusCode = true } }
                    )
                }
            } else {
                SecurityNotice(TwoFactorErrorText.ssoOnly)
            }
            factorInput
            SecurityNotice(
                turnOff
                    ? "Your authenticator and recovery codes will stop working."
                    : "All previous recovery codes will stop working. Save your new set.",
                kind: .warning
            )
            if let error = model.error {
                SecurityNotice(error, kind: .error, identifier: "proof.error")
            }
        } actions: {
            SecurityButton(
                turnOff ? "Turn off 2FA" : "Generate new codes",
                kind: turnOff ? .danger : .primary,
                isBusy: model.busy
            ) {
                Task { @MainActor in await model.submit() }
            }
            .disabled(!model.canSubmit)
            .accessibilityIdentifier("proof.submit")
            SecurityLinkButton("Cancel", action: onClose)
                .disabled(model.busy)
                .accessibilityIdentifier("proof.cancel")
        }
    }

    @ViewBuilder
    private var factorInput: some View {
        if model.useRecoveryCode {
            SecurityField("Recovery code") {
                TextField("XXXX-XXXX-XXXX-XXXX", text: $model.recoveryCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .accessibilityLabel("Recovery code")
                    .accessibilityIdentifier("proof.recoveryCode")
            }
        } else {
            OTPCodeField(code: $model.code, isError: model.error != nil, identifier: "proof.code", requestFocus: $focusCode)
        }
        SecurityLinkButton(model.useRecoveryCode ? "Use an authenticator code instead" : "Use a recovery code instead") {
            model.toggleRecoveryCode()
        }
        .accessibilityIdentifier("proof.toggleRecovery")
    }
}

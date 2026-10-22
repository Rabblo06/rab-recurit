import SwiftUI

/// Returning-user lock screen. Biometrics only decide whether the app may
/// ATTEMPT `/auth/me`; the server's answer decides access.
struct BiometricUnlockView: View {
    @EnvironmentObject private var session: SessionCoordinator
    @State private var authenticating = false
    @State private var failed = false
    @State private var message: String?
    @State private var attemptedOnAppear = false

    init() {}

    private var label: String { session.biometricCapability.label }

    var body: some View {
        AuthScaffold {
            VStack(spacing: 16) {
                Image(systemName: session.biometricCapability.systemImage)
                    .font(.system(size: 52, weight: .regular))
                    .foregroundStyle(ScheduleTokens.ink)
                    .frame(width: 96, height: 96)
                    .background(Circle().fill(Color.white))
                    .accessibilityHidden(true)
                Text("Unlock Crewflow")
                    .scheduleType(ScheduleType.pageTitle)
                    .accessibilityAddTraits(.isHeader)
                if let email = session.rememberedEmail {
                    Text(email)
                        .scheduleType(ScheduleType.secondary)
                        .accessibilityLabel("Account email: \(email)")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 24)

            if let message {
                InlineError(text: message)
            }

            PrimaryButton(
                authenticating ? "Authenticating..." : failed ? "Try again" : "Continue with \(label)",
                systemImage: authenticating ? nil : session.biometricCapability.systemImage,
                isBusy: authenticating,
                action: attempt
            )
            .accessibilityIdentifier("unlock.biometric")

            Button("Use password instead") { session.fallBackToPassword() }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ScheduleTokens.ink)
                .frame(maxWidth: .infinity, minHeight: ScheduleTokens.touchTarget)
                .accessibilityIdentifier("unlock.password")
        }
        .task { @MainActor in
            guard !attemptedOnAppear else { return }
            attemptedOnAppear = true
            await run()
        }
    }

    private func attempt() {
        Task { @MainActor in await run() }
    }

    @MainActor
    private func run() async {
        guard !authenticating else { return }
        authenticating = true
        message = nil
        let outcome = await session.attemptBiometricUnlock()
        authenticating = false
        failed = outcome != .success
        switch outcome {
        case .lockedOut:
            message = "Too many attempts. Use your password or try again shortly."
        case .error:
            message = "Unable to use biometrics. Try again or use your password."
        default:
            message = nil
        }
    }
}

/// Offered once after a fresh password sign-in on capable hardware.
/// Enabling runs one live biometric check before anything is stored.
struct BiometricSetupView: View {
    @EnvironmentObject private var session: SessionCoordinator
    @State private var busy = false
    @State private var message: String?
    @State private var showUnavailable = false

    init() {}

    private var label: String { session.biometricCapability.label }

    var body: some View {
        AuthScaffold {
            Image(systemName: session.biometricCapability.systemImage)
                .font(.system(size: 44))
                .foregroundStyle(ScheduleTokens.ink)
                .frame(width: 84, height: 84)
                .background(Circle().fill(Color.white))
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
            Text("Set up \(label)")
                .scheduleType(ScheduleType.pageTitle)
                .accessibilityAddTraits(.isHeader)
            Text("Sign in with \(label) next time. Your biometric data stays on this device — we never see it.")
                .scheduleType(ScheduleType.body)
            if let message {
                InlineError(text: message)
            }
            PrimaryButton("Enable \(label)", isBusy: busy) { complete(enable: true) }
                .accessibilityIdentifier("biometricSetup.enable")
            PrimaryButton("Skip for now", variant: .light) { complete(enable: false) }
                .disabled(busy)
                .accessibilityIdentifier("biometricSetup.skip")
        }
        .alert("\(label) not available", isPresented: $showUnavailable) {
            Button("Confirm") { complete(enable: false) }
        } message: {
            Text("This device does not support biometric sign-in. You will use your email and password each time.")
        }
    }

    private func complete(enable: Bool) {
        guard !busy else { return }
        busy = true
        message = nil
        Task { @MainActor in
            let outcome = await session.completeBiometricSetup(enable: enable)
            busy = false
            guard enable, let outcome else { return }
            switch outcome {
            case .success: break
            case .cancelled: message = "Setup cancelled. Try again or skip for now."
            case .failed: message = "Biometric confirmation failed. Try again or skip for now."
            case .lockedOut: message = "Biometrics are temporarily locked. Try later or skip for now."
            case .notAvailable: showUnavailable = true
            case .error: message = "Unable to confirm biometrics. Try again or skip for now."
            }
        }
    }
}

/// Forced reset (`mustResetPassword`). Server-enforced: `/auth/set-password`
/// only works while the flag is set. Success requires a fresh sign-in.
struct SetPasswordView: View {
    @EnvironmentObject private var session: SessionCoordinator
    @State private var password = ""
    @State private var confirmation = ""
    @State private var loading = false
    @State private var done = false
    @State private var error: String?

    static let minimumLength = 10

    init() {}

    private var hasLength: Bool { password.count >= Self.minimumLength }
    private var hasNumberOrSymbol: Bool {
        password.unicodeScalars.contains { CharacterSet.decimalDigits.contains($0) || !CharacterSet.alphanumerics.contains($0) }
    }
    private var mismatch: Bool { !confirmation.isEmpty && password != confirmation }
    /// Same gate as Flutter: length and match; the number/symbol row is
    /// guidance (the server's policy is authoritative).
    private var canSubmit: Bool { hasLength && !mismatch && !confirmation.isEmpty && !loading }

    var body: some View {
        AuthScaffold {
            if done {
                VStack(spacing: 16) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 40))
                        .foregroundStyle(ScheduleTokens.successText)
                        .accessibilityHidden(true)
                    Text("Password updated successfully")
                        .scheduleType(ScheduleType.pageTitle)
                        .multilineTextAlignment(.center)
                    PrimaryButton("Go back to login") {
                        Task { @MainActor in await session.logout() }
                    }
                }
                .frame(maxWidth: .infinity)
            } else {
                Text("Set secure password")
                    .scheduleType(ScheduleType.pageTitle)
                    .accessibilityAddTraits(.isHeader)
                Text("You need to set a new password before continuing.")
                    .scheduleType(ScheduleType.secondary)
                AuthField("CREATE PASSWORD") {
                    PasswordField(placeholder: "New password", text: $password, contentType: .newPassword, identifier: "setPassword.new")
                }
                AuthField("CONFIRM PASSWORD") {
                    PasswordField(placeholder: "Confirm password", text: $confirmation, contentType: .newPassword, identifier: "setPassword.confirm")
                }
                VStack(alignment: .leading, spacing: 8) {
                    checklistRow("At least \(Self.minimumLength) characters", met: hasLength)
                    checklistRow("At least one number or symbol", met: hasNumberOrSymbol)
                    checklistRow("Not a password you have used before", met: nil)
                    if mismatch {
                        InlineError(text: "Passwords do not match.")
                    }
                }
                if let error {
                    InlineError(text: error)
                }
                PrimaryButton("Set password", isBusy: loading, action: submit)
                    .disabled(!canSubmit)
                Button("Sign out") { Task { @MainActor in await session.logout() } }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ScheduleTokens.ink)
                    .frame(maxWidth: .infinity, minHeight: ScheduleTokens.touchTarget)
            }
        }
    }

    private func checklistRow(_ text: String, met: Bool?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: met == true ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(met == true ? ScheduleTokens.successText : ScheduleTokens.muted)
                .accessibilityHidden(true)
            Text(text).scheduleType(ScheduleType.caption.colored(ScheduleTokens.ink))
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(met == nil ? "" : (met == true ? "Met" : "Not met"))
    }

    private func submit() {
        guard canSubmit else { return }
        loading = true
        error = nil
        let value = password
        Task { @MainActor in
            do {
                try await session.setPassword(value)
                done = true
                password = ""
                confirmation = ""
            } catch {
                self.error = userMessage(for: error)
            }
            loading = false
        }
    }
}

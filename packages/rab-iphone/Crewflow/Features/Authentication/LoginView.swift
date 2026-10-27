import SwiftUI

/// Login error text. Uniform for wrong email vs wrong password (the server
/// already answers both with one 401); identical rules to Flutter's
/// `LoginSheetContent._signIn`, except that a non-401/5xx server message is
/// only shown when it reads as user-facing (Flutter shows it raw).
enum LoginErrorText {
    static let invalidCredentials = "Invalid email or password."
    static let unreachable = "Unable to reach the server. Check your connection and try again."
    static let unavailable = "Unable to sign in right now. Please try again."

    static func message(for error: Error) -> String {
        guard let apiError = error as? APIError else { return unreachable }
        switch apiError {
        case .unauthorized:
            return invalidCredentials
        case .offline, .timeout:
            return unreachable
        case .server:
            return unavailable
        case .rateLimited:
            return apiError.userMessage
        default:
            return apiError.payload?.userFacingMessage ?? apiError.userMessage
        }
    }
}

/// Email + password sign-in. The ONLY sign-in method on iOS: Google /
/// Microsoft sign-in is browser-only on this backend (cookie-bound PKCE,
/// forced manager_web target), so no SSO buttons are shown.
struct LoginView: View {
    let reauth: Bool
    @EnvironmentObject private var session: SessionCoordinator

    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var loading = false
    @State private var showForgotPassword = false
    /// 409 CLIENT_UPDATE_REQUIRED (M11). Nothing was stored.
    @State private var updateRequired: ClientUpdateRequired?
    @FocusState private var focus: FocusField?

    private enum FocusField { case email, password }

    init(reauth: Bool) {
        self.reauth = reauth
    }

    private func coolingDown(at date: Date) -> Bool {
        (session.loginCooldownUntil ?? .distantPast) > date
    }

    private var canSubmit: Bool {
        !email.trimmed.isEmpty && !password.isEmpty && !loading && !coolingDown(at: Date())
    }

    var body: some View {
        AuthScaffold {
            VStack(alignment: .leading, spacing: 6) {
                Text("Welcome back")
                    .scheduleType(ScheduleType.pageTitle)
                    .accessibilityAddTraits(.isHeader)
                Text("Log in to see your shifts.").scheduleType(ScheduleType.secondary)
            }

            if reauth {
                AuthBanner(text: "For your security, please sign in again.")
            } else if session.sessionExpiredNotice {
                AuthBanner(text: APIMessages.sessionExpired, systemImage: "clock.arrow.circlepath")
            }

            AuthField("EMAIL") {
                TextField("you@example.com", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
                    .accessibilityLabel("Email")
                    .accessibilityIdentifier("login.email")
            }

            AuthField("PASSWORD") {
                PasswordField(placeholder: "Your password", text: $password, identifier: "login.password")
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
            }

            if let error {
                InlineError(text: error)
            }

            if coolingDown(at: Date()) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if let until = session.loginCooldownUntil, until > context.date {
                        Text("Try again in \(Int(until.timeIntervalSince(context.date).rounded(.up))) s")
                            .scheduleType(ScheduleType.caption)
                    }
                }
            }

            PrimaryButton(loading ? "Signing in..." : "Sign In", isBusy: loading, action: submit)
                .disabled(!canSubmit)
                .accessibilityIdentifier("login.submit")

            Button("Forgot password?") { showForgotPassword = true }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ScheduleTokens.ink)
                .frame(maxWidth: .infinity, minHeight: ScheduleTokens.touchTarget)
                .accessibilityIdentifier("login.forgot")
        }
        .sheet(isPresented: $showForgotPassword) {
            ForgotPasswordView(initialEmail: email.trimmed)
        }
        .fullScreenCover(item: $updateRequired) { notice in
            UpdateRequiredView(notice: notice) { updateRequired = nil }
        }
        .onAppear {
            // After "Back to sign in" from the code screen, the email the
            // person typed (memory only); otherwise the remembered account.
            if email.isEmpty { email = session.lastSignInEmail ?? session.rememberedEmail ?? "" }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        error = nil
        loading = true
        focus = nil
        let emailValue = email.trimmed
        let passwordValue = password
        Task { @MainActor in
            do {
                let outcome = try await session.login(email: emailValue, password: passwordValue)
                switch outcome {
                case .signedIn, .secondFactorRequired:
                    // The phase moved on (shell, or the code screen M7).
                    password = ""
                case .updateRequired(let notice):
                    password = ""
                    updateRequired = notice
                case .enrolmentRequired(let message):
                    password = ""
                    self.error = message
                case .superseded:
                    break
                }
            } catch {
                self.error = LoginErrorText.message(for: error)
            }
            loading = false
        }
    }
}

/// `POST /auth/forgot-password`. Always shows the same confirmation whether
/// or not the account exists, and even on a network error (no enumeration).
struct ForgotPasswordView: View {
    let initialEmail: String
    @EnvironmentObject private var session: SessionCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var loading = false
    @State private var sent = false

    init(initialEmail: String) {
        self.initialEmail = initialEmail
    }

    var body: some View {
        VStack(spacing: 0) {
            NavHeader("Reset password", onBack: { dismiss() })
                .padding(.horizontal, 12)
            AuthScaffold {
                if sent {
                    Text("Check your email")
                        .scheduleType(ScheduleType.pageTitle)
                        .accessibilityAddTraits(.isHeader)
                    Text("If an account exists for \(email.trimmed), you'll receive an email with a link to reset your password shortly.")
                        .scheduleType(ScheduleType.body)
                    PrimaryButton("Return to sign in") { dismiss() }
                } else {
                    Text("Enter your email and we'll send you a reset link.")
                        .scheduleType(ScheduleType.body)
                    AuthField("EMAIL") {
                        TextField("you@example.com", text: $email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.send)
                            .onSubmit(submit)
                            .accessibilityLabel("Email")
                    }
                    PrimaryButton("Send reset link", isBusy: loading, action: submit)
                        .disabled(email.trimmed.isEmpty || loading)
                }
            }
        }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .onAppear { if email.isEmpty { email = initialEmail } }
    }

    private func submit() {
        let value = email.trimmed
        guard !value.isEmpty, !loading else { return }
        loading = true
        Task { @MainActor in
            // The outcome is deliberately ignored: success and failure look
            // identical (no account enumeration).
            try? await session.forgotPassword(email: value)
            loading = false
            sent = true
        }
    }
}

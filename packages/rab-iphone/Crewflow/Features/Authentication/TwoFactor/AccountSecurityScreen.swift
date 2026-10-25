import SwiftUI

/// Identity fence for results that arrive after an account switch.
@MainActor
protocol TwoFactorSessionFence: AnyObject {
    var epoch: UInt64 { get }
    func isCurrent(_ candidate: UInt64) -> Bool
}

extension SessionCoordinator: TwoFactorSessionFence {}

/// `GET /auth/mfa` for the Security screen. A failed load shows Retry, never
/// a guessed "Off".
@MainActor
final class TwoFactorSettingsModel: ObservableObject {
    enum State: Equatable {
        case loading
        case loaded(TwoFactorStatus)
        case failed(String)
    }

    @Published private(set) var state: State = .loading
    let api: TwoFactorAPI
    private let fence: TwoFactorSessionFence

    init(api: TwoFactorAPI, fence: TwoFactorSessionFence) {
        self.api = api
        self.fence = fence
    }

    var status: TwoFactorStatus? {
        if case .loaded(let status) = state { return status }
        return nil
    }

    func load(silent: Bool = false) async {
        if !silent || status == nil { state = .loading }
        let epoch = fence.epoch
        do {
            let loaded = try await api.status()
            guard fence.isCurrent(epoch) else { return }
            state = .loaded(loaded)
        } catch {
            guard fence.isCurrent(epoch) else { return }
            if let apiError = error as? APIError, apiError.isCancellation || apiError == .sessionChanged { return }
            // A silent refresh keeps what is on screen.
            if silent, status != nil { return }
            state = .failed(userMessage(for: error, fallback: "Your security settings could not be loaded."))
        }
    }
}

/// Which full-screen flow is open.
enum TwoFactorFlow: String, Identifiable {
    case setUp
    case turnOff
    case regenerate

    var id: String { rawValue }
}

/// M1 / M5 / M6: Profile → Security for Staff and Venue Manager. Pushed on
/// the presenting navigation stack; the back control pops it.
struct AccountSecurityScreen: View {
    @EnvironmentObject private var environment: AppEnvironment
    @EnvironmentObject private var session: SessionCoordinator

    init() {}

    var body: some View {
        AccountSecurityContent(api: TwoFactorAPI(api: environment.api), session: session)
    }
}

private struct AccountSecurityContent: View {
    @ObservedObject private var session: SessionCoordinator
    @StateObject private var model: TwoFactorSettingsModel
    @State private var flow: TwoFactorFlow?
    @State private var biometricBusy = false
    @State private var biometricMessage: String?
    @State private var showPasswordReset = false

    init(api: TwoFactorAPI, session: SessionCoordinator) {
        _session = ObservedObject(wrappedValue: session)
        _model = StateObject(wrappedValue: TwoFactorSettingsModel(api: api, fence: session))
    }

    var body: some View {
        SecurityScreen(title: "Security") {
            if let user = session.user {
                SecurityAccountHeader(name: user.fullName, email: user.email)
            }
            twoFactorCard
            preferencesCard
            Text("Two-factor authentication is optional.\nOnce enabled, it’s required at every sign-in.")
                .scheduleType(SecurityType.caption)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
        .task { await model.load() }
        .refreshable { await model.load(silent: true) }
        .fullScreenCover(item: $flow, onDismiss: { Task { @MainActor in await model.load(silent: true) } }) { flow in
            flowView(flow)
                .environmentObject(session)
        }
        .sheet(isPresented: $showPasswordReset) {
            ForgotPasswordView(initialEmail: session.user?.email ?? "")
                .environmentObject(session)
        }
    }

    @ViewBuilder
    private func flowView(_ flow: TwoFactorFlow) -> some View {
        let email = session.user?.email ?? ""
        let hasPassword = model.status?.hasPassword ?? true
        switch flow {
        case .setUp:
            TwoFactorSetupFlow(api: model.api, email: email, hasPassword: hasPassword) { self.flow = nil }
        case .turnOff:
            TurnOffTwoFactorView(api: model.api, hasPassword: hasPassword) { self.flow = nil }
        case .regenerate:
            RegenerateCodesView(api: model.api, email: email, hasPassword: hasPassword) { self.flow = nil }
        }
    }

    // MARK: Two-factor card

    private var twoFactorCard: some View {
        SecurityCard {
            switch model.state {
            case .loading:
                cardTop(isOn: nil)
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Loading two-factor authentication…").scheduleType(SecurityType.caption)
                }
                .accessibilityElement(children: .combine)
            case .failed(let message):
                cardTop(isOn: nil)
                SecurityNotice(message, kind: .error)
                SecurityButton("Try again", kind: .secondary) { Task { @MainActor in await model.load() } }
                    .accessibilityIdentifier("security.twoFactor.retry")
            case .loaded(let status):
                cardTop(isOn: status.enabled)
                description(status)
                if status.recoveryCodesLow {
                    SecurityNotice(status.lowCodesWarning, kind: .warning, identifier: "security.twoFactor.lowCodes")
                }
                if status.enabled {
                    enabledControls(status)
                } else {
                    disabledControls(status)
                }
            }
        }
    }

    private func cardTop(isOn: Bool?) -> some View {
        HStack {
            SecurityEmblem(systemImage: "checkmark.shield")
            Spacer(minLength: 8)
            if let isOn {
                SecurityBadge(isOn: isOn)
            }
        }
    }

    private func description(_ status: TwoFactorStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Two-factor authentication")
                .scheduleType(SecurityType.cardTitle)
                .accessibilityAddTraits(.isHeader)
            Text(status.enabled
                 ? "Enter a code from your authenticator app each time you sign in on web or mobile."
                 : "Add an extra layer of protection with a code from your authenticator app.")
                .scheduleType(SecurityType.body)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func enabledControls(_ status: TwoFactorStatus) -> some View {
        HStack {
            Text("Recovery codes").scheduleType(SecurityType.row.colored(SecurityTokens.muted))
            Spacer(minLength: 8)
            Text(status.recoveryCodesSummary)
                .scheduleType(SecurityType.rowStrong)
        }
        .padding(.top, 14)
        .overlay(alignment: .top) { Rectangle().fill(SecurityTokens.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("security.twoFactor.codesLeft")
        SecurityButton("Get new recovery codes", kind: .secondary) { flow = .regenerate }
            .accessibilityIdentifier("security.twoFactor.newCodes")
        if status.enforced {
            Text("Two-factor authentication is required for your account and can’t be turned off.")
                .scheduleType(SecurityType.caption)
        } else {
            SecurityLinkButton("Turn off 2FA") { flow = .turnOff }
                .accessibilityIdentifier("security.twoFactor.turnOff")
        }
    }

    @ViewBuilder
    private func disabledControls(_ status: TwoFactorStatus) -> some View {
        if !status.enrolmentAvailable {
            SecurityNotice("Two-factor setup isn’t available right now.")
        } else if !status.hasPassword {
            SecurityNotice(TwoFactorErrorText.ssoOnly)
        }
        SecurityButton("Turn on 2FA") { flow = .setUp }
            .disabled(!status.enrolmentAvailable || !status.hasPassword)
            .accessibilityIdentifier("security.twoFactor.turnOn")
    }

    // MARK: Face ID / password card

    private var showsPasswordReset: Bool {
        model.status?.hasPassword ?? true
    }

    @ViewBuilder
    private var preferencesCard: some View {
        if session.biometricCapability.isAvailable || showsPasswordReset {
            SecurityCard(spacing: 0) {
                if session.biometricCapability.isAvailable {
                    biometricRow
                }
                if session.biometricCapability.isAvailable && showsPasswordReset {
                    Rectangle().fill(SecurityTokens.line).frame(height: 1)
                }
                if showsPasswordReset {
                    passwordRow
                }
            }
        }
    }

    /// The design's "Face ID · On" maps to the app's REAL biometric setting
    /// (a switch, so it stays the one place to turn it on or off).
    private var biometricRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: biometricBinding) {
                Text(session.biometricCapability.label).scheduleType(SecurityType.row)
            }
            .tint(SecurityTokens.action)
            .disabled(biometricBusy)
            .frame(minHeight: 44)
            .accessibilityIdentifier("staff.security.biometric")
            if let biometricMessage {
                Text(biometricMessage).scheduleType(SecurityType.caption.colored(SecurityTokens.red))
            }
        }
        .padding(.vertical, 8)
    }

    /// No change-password route exists: "Reset password" opens the existing
    /// email reset with the account's email (owner decision, UI_PLAN §7 #5).
    private var passwordRow: some View {
        Button {
            showPasswordReset = true
        } label: {
            HStack {
                Text("Reset password").scheduleType(SecurityType.row)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SecurityTokens.muted)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Sends a password reset link to your email")
        .accessibilityIdentifier("security.resetPassword")
    }

    private var biometricBinding: Binding<Bool> {
        Binding(
            get: { session.biometricEnabledForCurrentUser },
            set: { enable in
                biometricMessage = nil
                if enable {
                    biometricBusy = true
                    Task { @MainActor in
                        let ok = await session.enableBiometric()
                        biometricBusy = false
                        if !ok {
                            biometricMessage = "\(session.biometricCapability.label) was not turned on. If you last signed in with your password more than 90 days ago, sign out and sign in again first."
                        }
                    }
                } else {
                    session.disableBiometric()
                }
            }
        )
    }
}

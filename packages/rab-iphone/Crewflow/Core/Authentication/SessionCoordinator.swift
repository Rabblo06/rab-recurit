import Foundation
import Combine

/// Session state for the whole app. Port of the Flutter `AuthProvider`
/// (packages/rab-mobile/lib/core/auth/auth_provider.dart), same phases and
/// the same security semantics:
///
/// - Identity comes from `GET /auth/me` (server-verified), never from a
///   decoded JWT. Routing reads `user.presentation`.
/// - Cold-launch lock: "unlocked" lives only in memory. Every process start
///   is locked; a stored session alone never opens the app. Without a valid
///   biometric binding the user re-enters the password (`reauthRequired`).
/// - Biometrics are a LOCAL presence gate. Success only allows the app to
///   *attempt* `/auth/me`; the server's answer decides. The password is
///   never stored. Trust ends 90 days after the last PASSWORD sign-in
///   (MOB-01/MOB-02), enforced on resume and by one scheduled timer.
/// - Identity epoch: bumped on every login/logout; any response that lands
///   after the epoch moved is dropped (account-switch safety). The API
///   client keeps its own generation for the same purpose at the HTTP layer.
@MainActor
public final class SessionCoordinator: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case loading
        case unauthenticated
        case biometricLocked
        case reauthRequired
        case offeringBiometricSetup
        case mustResetPassword
        case authenticated
    }

    @Published public private(set) var phase: Phase = .loading
    @Published public private(set) var user: CurrentUser?
    @Published public private(set) var capabilities: Capabilities = .none
    @Published public private(set) var biometricEnabledForCurrentUser = false
    @Published public private(set) var biometricCapability: BiometricCapability = .unavailable
    @Published public private(set) var rememberedEmail: String?
    @Published public private(set) var loginCooldownUntil: Date?
    /// True after the server ended the session (refresh rejected); the login
    /// screen explains it instead of a toast. Cleared by the next login.
    @Published public private(set) var sessionExpiredNotice = false

    public private(set) var rememberedUserId: String?
    /// Identity epoch. Capture before an `await`, compare with `isCurrent`.
    public private(set) var epoch: UInt64 = 0

    public let api: APIClient
    /// Called after every sign-out / expiry so app-level state (toasts,
    /// feature caches) resets.
    public var onSignedOut: (() -> Void)?

    private let tokens: TokenStore
    private let biometricStore: BiometricStore
    private let pushDevice: PushDeviceIdentity?
    private let authenticator: any BiometricAuthenticating
    private let now: () -> Date

    private var unlocked = false
    private var started = false
    private var loginPending = false
    private var logoutPending = false
    private var biometricPending = false
    private var deadlineTask: Task<Void, Never>?

    public init(
        api: APIClient,
        tokens: TokenStore,
        biometricStore: BiometricStore,
        pushDevice: PushDeviceIdentity? = nil,
        authenticator: any BiometricAuthenticating,
        now: @escaping () -> Date = { Date() }
    ) {
        self.api = api
        self.tokens = tokens
        self.biometricStore = biometricStore
        self.pushDevice = pushDevice
        self.authenticator = authenticator
        self.now = now
    }

    // MARK: - Derived state

    public var presentation: AppPresentation { user?.presentation ?? .unsupported }

    /// Never persisted: each process starts locked.
    public var canAccessAuthenticatedUI: Bool {
        user != nil && phase == .authenticated && unlocked
    }

    public func isCurrent(_ candidate: UInt64) -> Bool { candidate == epoch }

    // MARK: - Bootstrap

    /// Resolves the launch phase. Safe to call more than once.
    public func start() async {
        guard !started else { return }
        started = true
        await api.setSessionExpiredHandler { [weak self] in
            self?.handleSessionExpired()
        }
        let remembered = biometricStore.rememberedAccount()
        rememberedUserId = remembered?.userId
        rememberedEmail = remembered?.email
        let capability = await authenticator.capability()
        biometricCapability = capability

        guard tokens.hasSession else {
            setPhase(.unauthenticated)
            return
        }
        guard let preference = biometricStore.enabledUserId() else {
            await restore()
            return
        }
        // Missing ownership/confirmation (legacy or tampered state) requires the password.
        let owner = tokens.sessionUserId()
        let bindingOK = bindingValid(confirmedAt: biometricStore.confirmedAt(), lastFullAuthAt: biometricStore.lastFullAuthenticationAt())
        if owner == nil || owner != preference || owner != rememberedUserId || !bindingOK || !capability.isAvailable {
            setPhase(.reauthRequired)
        } else {
            setPhase(.biometricLocked)
        }
    }

    private func restore() async {
        do {
            try await refreshUser()
        } catch {
            user = nil
            // Only a server rejection of the session itself (401 after a
            // failed refresh) clears it. 403 APPLICATION_* denials, 503
            // AUTH_UNAVAILABLE and connectivity failures keep the stored
            // session for the next attempt (AUTH_UNAVAILABLE must never log
            // anyone out). Flutter also cleared on 403; tightened here.
            if let apiError = error as? APIError, apiError.endsSession {
                await api.endSession()
            }
        }
        // A restored server identity is not proof of local presence.
        setPhase(user == nil ? .unauthenticated : .reauthRequired)
    }

    /// Re-reads `/auth/me`; dropped if the identity changed meanwhile.
    public func refreshUser() async throws {
        let captured = epoch
        let current = try await api.get("/auth/me", as: CurrentUser.self)
        guard captured == epoch else { return }
        user = current
    }

    /// `/auth/capabilities` display hints for the mobile presentations.
    /// Failure leaves `.none` (fail closed).
    public func loadCapabilities() async {
        guard let user, user.presentation == .staff || user.presentation == .venueManager else {
            capabilities = .none
            return
        }
        let captured = epoch
        do {
            let loaded = try await api.get("/auth/capabilities", as: Capabilities.self)
            guard captured == epoch else { return }
            capabilities = loaded
        } catch {
            guard captured == epoch else { return }
            capabilities = .none
        }
    }

    // MARK: - Password sign-in

    /// `POST /auth/login` then `GET /auth/me`. No organisation and no
    /// application target are sent: the server resolves the organisation
    /// from the credentials and the mobile target from the account's roles.
    public func login(email: String, password: String) async throws {
        guard !loginPending, !logoutPending else { return }
        if let until = loginCooldownUntil, until > now() {
            let seconds = Int(until.timeIntervalSince(now()).rounded(.up)) + 1
            throw APIError.rateLimited(retryAfterSeconds: seconds, message: "Too many sign-in attempts. Please try again later.")
        }
        loginPending = true
        epoch &+= 1
        let captured = epoch
        var tokensWritten = false
        var completed = false
        defer { loginPending = false }

        do {
            let response = try await api.post(
                "/auth/login",
                body: LoginRequestBody(email: email, password: password),
                as: LoginResponse.self
            )
            if captured == epoch {
                try api.storeTokens(accessToken: response.accessToken, refreshToken: response.refreshToken)
                tokensWritten = true
                let current = try await api.get("/auth/me", as: CurrentUser.self)
                if captured == epoch {
                    user = current
                    try? tokens.setSessionUserId(current.id)
                    try? biometricStore.setRememberedAccount(userId: current.id, email: current.email)
                    rememberedUserId = current.id
                    rememberedEmail = current.email
                    sessionExpiredNotice = false
                    completed = true
                    await afterFreshCredentialAuth(epoch: captured)
                }
            }
        } catch {
            if case .rateLimited(let seconds, _) = error as? APIError {
                loginCooldownUntil = now().addingTimeInterval(TimeInterval(seconds))
            }
            if tokensWritten, !completed { await api.endSession() }
            throw error
        }
        // Superseded by a logout/another login while in flight.
        if tokensWritten, !completed { await api.endSession() }
    }

    /// Password auth records identity; only native confirmation creates trust.
    private func afterFreshCredentialAuth(epoch captured: UInt64) async {
        guard let user else { return }
        // The anchor as it stood BEFORE this login judges the EXISTING
        // confirmation (comparing against the new timestamp would be a
        // tautology that forces re-confirmation on every login).
        let priorFullAuthAt = biometricStore.lastFullAuthenticationAt()
        try? biometricStore.setLastFullAuthenticationAt(now())
        let valid = biometricStore.enabledUserId() == user.id
            && bindingValid(confirmedAt: biometricStore.confirmedAt(), lastFullAuthAt: priorFullAuthAt)
        if !valid { biometricStore.clearEnabledUserId() }
        biometricEnabledForCurrentUser = false
        unlocked = true
        if user.mustResetPassword {
            setPhase(.mustResetPassword)
            return
        }
        let capability = await authenticator.capability()
        guard captured == epoch else { return }
        biometricCapability = capability
        biometricEnabledForCurrentUser = valid && capability.isAvailable
        setPhase(capability.isAvailable && !valid ? .offeringBiometricSetup : .authenticated)
    }

    /// Always "succeeds" from the caller's view whether or not the email has
    /// an account (no enumeration). The server pins mobile requests to the
    /// staff_app reset target.
    public func forgotPassword(email: String) async throws {
        try await api.post("/auth/forgot-password", body: EmailBody(email: email))
    }

    /// Completes the forced-reset flow (server-enforced: only while
    /// `mustResetPassword` is true). Success requires a fresh sign-in.
    public func setPassword(_ newPassword: String) async throws {
        try await api.post("/auth/set-password", body: NewPasswordBody(newPassword: newPassword))
    }

    // MARK: - Biometrics

    /// Post-login offer. `enable: true` runs one live check before anything
    /// is persisted; `false` ("Skip for now") writes nothing.
    public func completeBiometricSetup(enable: Bool) async -> BiometricOutcome? {
        guard phase == .offeringBiometricSetup, let user, !user.mustResetPassword, !biometricPending else { return nil }
        let captured = epoch
        let id = user.id
        biometricPending = true
        defer { biometricPending = false }
        var outcome: BiometricOutcome?
        if enable {
            let result = await authenticator.authenticate(reason: "Confirm biometric sign-in for Crewflow")
            outcome = result
            if result == .success {
                guard captured == epoch, self.user?.id == id else { return result }
                try? biometricStore.confirmBiometric(userId: id, at: now())
                biometricEnabledForCurrentUser = true
            }
        }
        if captured == epoch, self.user?.id == id, !enable || outcome == .success {
            setPhase(.authenticated)
        }
        return outcome
    }

    /// Returning-user unlock. Local success only gates whether the app
    /// ATTEMPTS `/auth/me`; a revoked/expired session or disabled account
    /// still denies access.
    public func attemptBiometricUnlock() async -> BiometricOutcome {
        guard phase == .biometricLocked, !biometricPending else { return .cancelled }
        biometricPending = true
        defer { biometricPending = false }
        let captured = epoch
        guard await canUnlock() else { return .notAvailable }
        let outcome = await authenticator.authenticate(reason: "Unlock Crewflow to continue")
        guard captured == epoch else { return .cancelled }
        guard outcome == .success else { return outcome }
        guard await canUnlock() else { return .notAvailable }
        do {
            let current = try await api.get("/auth/me", as: CurrentUser.self)
            guard captured == epoch else { return .cancelled }
            guard await canUnlock() else { return .notAvailable }
            if current.id != rememberedUserId || current.id != tokens.sessionUserId() {
                await api.endSession()
                handleSessionExpired()
                return .failed
            }
            user = current
            unlocked = true
            biometricEnabledForCurrentUser = true
            setPhase(phaseAfterUserLoaded())
            return .success
        } catch {
            guard captured == epoch else { return .cancelled }
            // Connectivity, 403 and 503 keep the session for a retry.
            if let apiError = error as? APIError, apiError.endsSession {
                await api.endSession()
                handleSessionExpired()
            }
            return .error
        }
    }

    private func canUnlock() async -> Bool {
        guard tokens.hasSession else {
            handleSessionExpired()
            return false
        }
        let preference = biometricStore.enabledUserId()
        let owner = tokens.sessionUserId()
        let bindingOK = bindingValid(confirmedAt: biometricStore.confirmedAt(), lastFullAuthAt: biometricStore.lastFullAuthenticationAt())
        if preference == nil || owner != preference || owner != rememberedUserId || !bindingOK {
            user = nil
            biometricEnabledForCurrentUser = false
            setPhase(.reauthRequired)
            return false
        }
        let capability = await authenticator.capability()
        biometricCapability = capability
        guard capability.isAvailable else {
            fallBackToPassword()
            return false
        }
        return true
    }

    /// "Use password instead": stored tokens and the biometric preference
    /// stay (biometrics may work next launch); this launch uses the password.
    public func fallBackToPassword() {
        setPhase(.unauthenticated)
    }

    /// Profile > Security toggle. Refused once the last PASSWORD sign-in is
    /// older than 90 days, so re-confirming can never extend the deadline.
    public func enableBiometric() async -> Bool {
        guard phase == .authenticated, let user, !biometricPending else { return false }
        guard passwordAuthFresh(biometricStore.lastFullAuthenticationAt()) else { return false }
        let captured = epoch
        let id = user.id
        biometricPending = true
        defer { biometricPending = false }
        let outcome = await authenticator.authenticate(reason: "Confirm biometric sign-in for Crewflow")
        guard outcome == .success, captured == epoch, self.user?.id == id else { return false }
        try? tokens.setSessionUserId(id)
        try? biometricStore.setRememberedAccount(userId: id, email: user.email)
        rememberedUserId = id
        rememberedEmail = user.email
        try? biometricStore.confirmBiometric(userId: id, at: now())
        biometricEnabledForCurrentUser = true
        enforceDeadlineIfAuthenticated()
        return true
    }

    public func disableBiometric() {
        biometricStore.clearEnabledUserId()
        biometricEnabledForCurrentUser = false
        enforceDeadlineIfAuthenticated()
    }

    // MARK: - Sign-out

    /// Revokes the session server-side (best effort, 10 s), then wipes the
    /// Keychain session, cancels in-flight requests and clears per-session
    /// caches/temp files. Normal logout keeps the remembered account and
    /// account-owned biometric trust (Flutter parity).
    public func logout() async {
        guard !logoutPending else { return }
        logoutPending = true
        defer { logoutPending = false }
        epoch &+= 1
        user = nil
        capabilities = .none
        biometricEnabledForCurrentUser = false
        setPhase(.unauthenticated)
        onSignedOut?()
        // Nothing from the old identity may complete after this point.
        await api.cancelAllRequests()
        // Push devices are NOT deactivated by /auth/logout server-side, so
        // stop this phone receiving the old account's notifications first,
        // while the access token is still valid. Best effort.
        if let pushDevice, pushDevice.registeredUserId() != nil {
            let deviceId = pushDevice.deviceId()
            do {
                try await api.post("/push/devices/\(deviceId)/deactivate", options: RequestOptions(retry: .safeToRepeat, timeout: 5))
            } catch {
                Log.session.info("Push deactivate failed before logout")
            }
            pushDevice.clearRegistration()
        }
        if let refreshToken = tokens.refreshToken() {
            // Clearing local storage alone would leave a session that is
            // still valid everywhere else.
            do {
                try await api.requestVoid(
                    .post,
                    "/auth/logout",
                    body: RefreshTokenBody(refreshToken: refreshToken),
                    options: RequestOptions(retry: .never, timeout: 10)
                )
            } catch {
                Log.session.info("Logout revoke failed; local session cleared anyway")
            }
        }
        await api.endSession()
        user = nil
        biometricEnabledForCurrentUser = false
        setPhase(.unauthenticated)
    }

    /// The API client wiped the session after a rejected refresh (forced
    /// logout: revoked family, security-version bump, disabled account).
    public func handleSessionExpired() {
        user = nil
        capabilities = .none
        biometricEnabledForCurrentUser = false
        // Bootstrap owns its final phase after storage cleanup finishes.
        if phase == .loading { return }
        sessionExpiredNotice = true
        setPhase(.unauthenticated)
        onSignedOut?()
    }

    // MARK: - App lifecycle & deep links

    /// Call when the scene becomes active (deadline may have passed while
    /// backgrounded or suspended).
    public func sceneDidBecomeActive() {
        enforceDeadlineIfAuthenticated()
    }

    /// `rab://login` (CF-37). Any app, web page or email can open it, so it
    /// NEVER signs anyone out and never discards a stored session; it only
    /// brings the app forward (and shows sign-in when nobody is signed in).
    public func handleOpenURL(_ url: URL) {
        guard url.scheme?.lowercased() == "rab" else { return }
        guard url.host?.lowercased() == "login" || url.path == "/login" else { return }
        if phase != .loading, user == nil, !tokens.hasSession {
            setPhase(.unauthenticated)
        }
    }

    // MARK: - Internals

    private func phaseAfterUserLoaded() -> Phase {
        guard let user else { return .unauthenticated }
        guard unlocked else { return .reauthRequired }
        return user.mustResetPassword ? .mustResetPassword : .authenticated
    }

    /// The 90-day deadline is anchored to the last PASSWORD sign-in, never
    /// to the biometric confirmation time (MOB-02).
    private func bindingValid(confirmedAt: Date?, lastFullAuthAt: Date?) -> Bool {
        guard let confirmedAt, confirmedAt <= now() else { return false }
        return passwordAuthFresh(lastFullAuthAt)
    }

    private func passwordAuthFresh(_ lastFullAuthAt: Date?) -> Bool {
        guard let lastFullAuthAt, lastFullAuthAt <= now() else { return false }
        return now() < Self.deadline(from: lastFullAuthAt)
    }

    static func deadline(from lastFullAuthAt: Date) -> Date {
        lastFullAuthAt.addingTimeInterval(TimeInterval(biometricFullReauthDays) * 86_400)
    }

    /// MOB-01: keeps the 90-day full-credential deadline enforced while the
    /// app stays open, for sessions that use biometric unlock.
    private func enforceDeadlineIfAuthenticated() {
        deadlineTask?.cancel()
        deadlineTask = nil
        guard phase == .authenticated, biometricEnabledForCurrentUser else { return }
        guard let lastFullAuthAt = biometricStore.lastFullAuthenticationAt(), passwordAuthFresh(lastFullAuthAt) else {
            user = nil
            biometricEnabledForCurrentUser = false
            setPhase(.reauthRequired)
            return
        }
        let delay = max(0, Self.deadline(from: lastFullAuthAt).timeIntervalSince(now()))
        deadlineTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.enforceDeadlineIfAuthenticated()
        }
    }

    private func setPhase(_ newPhase: Phase) {
        switch newPhase {
        case .loading, .unauthenticated, .reauthRequired, .biometricLocked:
            unlocked = false
        default:
            break
        }
        phase = newPhase
        enforceDeadlineIfAuthenticated()
        if newPhase == .authenticated {
            Task { [weak self] in await self?.loadCapabilities() }
        }
    }
}

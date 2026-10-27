# Crewflow iPhone — architecture and shared core API

Status: source implemented, **not compiled** (written on Windows; see README).

The core in this package is the **single implementation** every feature
reuses. Features never build their own HTTP client, token storage, session
logic, toast system or colour tokens.

```
Crewflow/
  App/                 CrewflowApp, AppEnvironment (DI + config), RootView (routing), Shells
  Core/
    Networking/        APIClient, SessionGate (single-flight refresh), APIError, JSON coding
    SecureStorage/     SecureStore (Keychain / in-memory), TokenStore, FreshInstallGuard
    Authentication/    SessionCoordinator, Biometrics (LocalAuthentication + BiometricStore),
                       PushDeviceIdentity
    Support/           Log (os.Logger rules), Deadline, TemporaryFiles, ContentDisposition
  Models/              CurrentUser/AppPresentation/ApplicationTarget/Capabilities/PermissionFlag,
                       auth DTOs, Money, CrewflowDateFormat, CalendarDay, ShiftVisualStyle(+registry)
  DesignSystem/        Tokens (RGBA, SchedulePalette, ScheduleTokens, ScheduleType),
                       Components: Actions (PrimaryButton, BottomAction, NavHeader),
                       Cards (StatusBadge, PastelShiftCard, InitialsAvatar, MessageCard, ...),
                       States (LoadingView, EmptyStateView, FeaturePlaceholderView), Toast
  Features/
    Authentication/    LoginView, ForgotPasswordView, SetPasswordView, BiometricUnlockView,
                       BiometricSetupView
      TwoFactor/       SecondFactorView, UpdateRequiredView, AccountSecurityScreen, TwoFactorSetupFlow,
                       TwoFactorProofFlow, TwoFactorAPI, Components/ (design kit), Testing/ (DEBUG stub)
    <Domain>/          (feature agents add one folder per domain, e.g. Offers/, Attendance/)
  Resources/           Info.plist, entitlements, assets
CrewflowTests/         unit tests + URLProtocol stub + JSON fixtures
CrewflowUITests/       launch smoke test
```

Feature code is **feature-per-folder** (repo rule): `Features/<domain>/`
holds that domain's repository, view models, views and feature-local
components. Something used by three or more features moves to
`DesignSystem/` or `Core/`; nothing moves pre-emptively.

## Routing

`RootView` → `AppRoute.resolve(phase:presentation:canAccessAuthenticatedUI:)`
(pure, unit-tested):

| Session phase | Route |
|---|---|
| loading | `LoadingView` |
| unauthenticated / reauthRequired | `LoginView(reauth:)` |
| secondFactor (409 SECOND_FACTOR_REQUIRED; nothing stored) | `SecondFactorView` |
| biometricLocked | `BiometricUnlockView` |
| offeringBiometricSetup | `BiometricSetupView` |
| mustResetPassword | `SetPasswordView` |
| authenticated + unlocked | `presentation`: staff → `StaffShell`, venueManager → `VenueManagerShell`, manager/admin → `ConsoleEntryView`, unsupported → `ConsoleEntryView(unsupported: true)` |

`presentation` comes from `/auth/me.roles` + `isPlatformAdmin`, never from
JWT claims. Each shell is `.id(...)`-keyed to `userId:presentation:epoch`, so
an account switch rebuilds every screen and view model from scratch.

## Public API (signatures)

### APIClient (`Core/Networking/APIClient.swift`)

```swift
final class APIClient: @unchecked Sendable {
  static let requestTimeout: TimeInterval   // 30 s total per request
  static let refreshTimeout: TimeInterval   // 20 s
  let baseURL: URL                          // includes /rest/v1

  func request<T: Decodable>(_ method: HTTPMethod, _ path: String, body: (any Encodable)? = nil,
                             options: RequestOptions? = nil, as: T.Type) async throws -> T
  func requestOptional<T: Decodable>(... as: T.Type) async throws -> T?   // empty 2xx / null → nil
  func requestVoid(_ method: HTTPMethod, _ path: String, body: (any Encodable)? = nil,
                   options: RequestOptions? = nil) async throws
  func get<T>(_ path: String, options: RequestOptions? = nil, as: T.Type) async throws -> T
  func getOptional<T>(_ path: String, options: RequestOptions? = nil, as: T.Type) async throws -> T?
  func post<T>(_ path: String, body: (any Encodable)? = nil, options: RequestOptions? = nil, as: T.Type) async throws -> T
  func post(_ path: String, body: (any Encodable)? = nil, options: RequestOptions? = nil) async throws
  func patch<T>(...) / put<T>(...)
  func getBytes(_ path: String, options: RequestOptions? = nil) async throws -> Data      // GET /files/:id
  func downloadFile(_ path: String) async throws -> DownloadedFile                      // follows 302 WITHOUT bearer
  func healthCheck() async -> Bool                                                      // GET /healthz (no /rest/v1)
  func currentGeneration() async -> UInt64
  func isCurrent(generation: UInt64) async -> Bool
  // used by SessionCoordinator only:
  func setSessionExpiredHandler(_: (@MainActor @Sendable () -> Void)?) async
  func storeTokens(accessToken:refreshToken:) throws
  func cancelAllRequests() async
  func endSession() async
}

enum RetryPolicy { case never, safeToRepeat }
struct RequestOptions { var retry: RetryPolicy; var timeout: TimeInterval; var background: Bool
  static func `default`(for: HTTPMethod) -> RequestOptions   // GET → .safeToRepeat, mutations → .never
  static let repeatSafeMutation, backgroundPoll }
struct DownloadedFile { let data: Data; let filename: String?; let mimeType: String?; var isPDF: Bool }
```

Rules built in (do not re-implement in a feature):

- Headers on every request: `Content-Type`/`Accept: application/json`,
  `X-Client-Platform: mobile`, `X-Client-Capabilities: mfa-verify`,
  `Authorization: Bearer …` when a token is held.
  Never `X-Application-Target`, never `organisationId`.
- 401 on a non-`/auth/*` path (plus `/auth/me`, `/auth/logout`) → one shared
  refresh (`SessionGate`, single-flight) → one replay under the same
  identity generation. Refresh 401/403 → session wiped, `SessionCoordinator`
  routes to sign-in. Refresh timeout/5xx → session kept.
- **No Idempotency-Key exists.** Mutations default to `RetryPolicy.never`.
  Pass `options: .repeatSafeMutation` only for routes the contract map lists
  as repeat-safe (check-in, finalise, attendance-review, confirm-no-show,
  push deactivate). On `error.isUncertainOutcome` (timeout, offline, 5xx)
  after clock-in/clock-out/accept/decline/`/shifts/request`: **reload the
  state, never resend.**
- Use `options: .backgroundPoll` for automatic polling (sends
  `X-Crewflow-Background: 1`, so polling does not keep an idle session alive).
- A response that arrives after sign-out/account switch throws
  `APIError.sessionChanged`; ignore it (the toast centre already does).
- Date-times decode from ISO-8601 with or without fractional seconds. Payroll
  date-only fields use `CalendarDay`. `attendanceVersion` is an opaque
  `String`; echo it back unchanged. Money is `Int64` pence.

### APIError (`Core/Networking/APIError.swift`)

```swift
enum APIError: Error, Equatable {
  case unauthorized(message:), forbidden(ServerErrorPayload), notFound(ServerErrorPayload),
       conflict(ServerErrorPayload), validation(status:, ServerErrorPayload),
       rateLimited(retryAfterSeconds:, message:), server(status:), http(status:, ServerErrorPayload),
       offline, timeout(message:), decoding(String), sessionChanged, cancelled, invalidRequest(String)
  var statusCode: Int; var code: String?; var payload: ServerErrorPayload?; var fieldErrors: [String]
  var userMessage: String          // identical rules to Flutter ApiException.userMessage
  var isTransient, isUncertainOutcome, endsSession, isCancellation: Bool
}
struct ServerErrorPayload { let message: String; let code: String?; let messages: [String]; let body: [String: JSONValue]? }
func userMessage(for error: Error, fallback: String? = nil) -> String   // Flutter userMessageFor
enum UserFacingText { static func isUserFacing(_: String) -> Bool }
```

Branch on `error.code` (e.g. `CLOCK_IN_TOO_EARLY`) and read extras from
`error.payload?.body?["availableAt"]`; show `error.userMessage`.

### SessionCoordinator (`Core/Authentication/SessionCoordinator.swift`)

```swift
@MainActor final class SessionCoordinator: ObservableObject {
  enum Phase { loading, unauthenticated, biometricLocked, reauthRequired, offeringBiometricSetup,
               mustResetPassword, authenticated, secondFactor }
  @Published private(set) var phase: Phase, user: CurrentUser?, capabilities: Capabilities,
    biometricEnabledForCurrentUser: Bool, biometricCapability: BiometricCapability,
    rememberedEmail: String?, loginCooldownUntil: Date?, sessionExpiredNotice: Bool
  private(set) var epoch: UInt64                 // identity epoch
  let api: APIClient
  var onSignedOut: (() -> Void)?
  var presentation: AppPresentation
  var canAccessAuthenticatedUI: Bool
  func isCurrent(_ epoch: UInt64) -> Bool

  func start() async
  @discardableResult func login(email: String, password: String) async throws -> SignInOutcome
      // .signedIn | .secondFactorRequired | .updateRequired(ClientUpdateRequired) | .enrolmentRequired | .superseded
  func verifySecondFactor(code: String, method: SecondFactorMethod) async -> SecondFactorVerifyResult
  func cancelSecondFactor() async
  @Published secondFactorChallenge: SecondFactorChallenge?, lastSignInEmail: String?   // memory only
  func refreshUser() async throws
  func loadCapabilities() async
  func forgotPassword(email: String) async throws
  func setPassword(_ newPassword: String) async throws
  func completeBiometricSetup(enable: Bool) async -> BiometricOutcome?
  func attemptBiometricUnlock() async -> BiometricOutcome
  func fallBackToPassword()
  func enableBiometric() async -> Bool
  func disableBiometric()
  func logout() async
  func handleSessionExpired()
  func sceneDidBecomeActive()
  func handleOpenURL(_ url: URL)
}
```

`capabilities` (17 flags from `/auth/capabilities`) are **display hints
only**: `session.capabilities.allows(.attendanceEdit)` decides whether to
show a button; the server still enforces every action.

### Design system (`DesignSystem/`)

```swift
// Tokens
struct RGBA { init(argb: UInt32); func lerp(to:_:) -> RGBA; var color: Color }
enum SchedulePalette { static let ink, muted, accent, navy, mint, peach, lavender, ... : RGBA }
enum ScheduleTokens  { static let ink, accent, navy, ... : Color; cardRadius, actionHeight(54), touchTarget(48), ... }
enum ScheduleType    { static let pageTitle, navTitle, cardTitle, heading, body, bodyStrong, secondary,
                       caption, overline, badge, button, timer, timerLabel : ScheduleTextStyle }
extension View { func scheduleType(_ style: ScheduleTextStyle) -> some View }   // Dynamic Type scaled

// Components
PrimaryButton(_ title: String, systemImage: String? = nil, variant: .primary | .light,
              isBusy: Bool = false, background: Color? = nil, action: () -> Void)
BottomAction(top: CGFloat = 8, horizontal: CGFloat = 20) { content }       // use in .safeAreaInset(edge: .bottom)
NavHeader(_ title: String, showBack: Bool = true, centerTitle: Bool = true, backgroundColor:, foreground:,
          onBack: (() -> Void)? = nil) { trailing }
StatusBadge(_ label: String, style: ShiftVisualStyle?, warning: Bool = false)
PastelShiftCard(style:, badge:, badgeWarning:, role:, venue:, startsAt:, endsAt:, onOpen:) { footer } [actions: { }]
ShiftMetaItem(systemImage:label:), ShiftCardFooterLine(_ text:, color:)
InitialsAvatar(name: String, size: CGFloat = 44, background: Color = lavender)
MessageCard(title:, message:, kind: FeedbackKind, actionTitle:, action:)   // persistent states
LoadingView(_ label:), EmptyStateView(systemImage:title:message:actionTitle:action:),
FeaturePlaceholderView(title:systemImage:detail:)
ShiftVisualStyle.forShift(_ id:) / registerGroup(_ ids:)                   // stable pastel per shift

// Toasts — temporary RESULT feedback only, errors only in this app
@MainActor final class ToastCenter: ObservableObject {
  @discardableResult func show(_ message: String, kind: FeedbackKind = .info, title: String? = nil,
                               duration: TimeInterval? = nil) -> Bool
  @discardableResult func showError(_ error: Error, fallback: String? = nil) -> Bool
  func dismiss(_ id: UUID); func dismissAll()
}
```

Toast policy: `ToastPolicy.errorsOnly` — a success shows its result in
place, never a toast. Load failures, field errors and confirmations use
`MessageCard`/sheets, not toasts.

## Adding a feature (repository → view model → view)

Example: Staff offers (`Features/Offers/`).

```swift
// Features/Offers/OffersRepository.swift — the ONLY place the routes live.
struct OfferSummary: Decodable, Identifiable, Equatable {
    let id: String
    let shiftId: String
    let startsAt: Date
    let endsAt: Date
    let hourlyRatePence: Int64
}

struct OffersRepository {
    let api: APIClient
    func mine() async throws -> [OfferSummary] {
        try await api.get("/offers/mine", as: [OfferSummary].self)
    }
    func accept(_ id: String) async throws {
        // Not idempotent: default RetryPolicy.never. Uncertain outcome → reload.
        try await api.post("/offers/\(id)/accept")
    }
}

// Features/Offers/OffersViewModel.swift
@MainActor final class OffersViewModel: ObservableObject {
    enum State: Equatable { case loading, loaded([OfferSummary]), failed(String) }
    @Published private(set) var state: State = .loading
    private let repository: OffersRepository
    private let session: SessionCoordinator
    private let toasts: ToastCenter

    init(repository: OffersRepository, session: SessionCoordinator, toasts: ToastCenter) { ... }

    func load() async {
        let epoch = session.epoch
        do {
            let offers = try await repository.mine()
            guard session.isCurrent(epoch) else { return }      // account switched meanwhile
            ShiftVisualStyle.registerGroup(offers.map(\.shiftId))
            state = .loaded(offers)
        } catch {
            guard session.isCurrent(epoch), (error as? APIError)?.isCancellation != true else { return }
            state = .failed(userMessage(for: error))           // persistent card with Retry
        }
    }

    func accept(_ offer: OfferSummary) async {
        do {
            try await repository.accept(offer.id)
            await load()                                        // success shows in place; no toast
        } catch let error as APIError where error.isUncertainOutcome {
            await load()                                        // never resend; reload and let the person decide
        } catch {
            toasts.showError(error)                             // errors only
        }
    }
}

// Features/Offers/OffersView.swift
struct OffersView: View {
    @EnvironmentObject private var environment: AppEnvironment
    @StateObject private var model: OffersViewModel
    init(environment: AppEnvironment) {
        _model = StateObject(wrappedValue: OffersViewModel(
            repository: OffersRepository(api: environment.api),
            session: environment.session, toasts: environment.toasts))
    }
    var body: some View { ... PastelShiftCard(style: .forShift(offer.shiftId), ...) ... }
        // .task { await model.load() }
}
```

Then replace the placeholder (`StaffHomeView`, etc. in `App/Shells.swift`)
with the feature's view. Add unit tests with the `URLProtocolStub` in
`CrewflowTests/Support/TestSupport.swift` (fixtures copied from real server
shapes into `CrewflowTests/Fixtures/`).

Server time: any running timer renders `serverNow − clockInAt` with
`serverNow` from the API anchored to a monotonic clock — never device time
(CLAUDE.md). Worked minutes are never computed on the client.

## Not implemented in this build (seams exist)

- Push: `PushDeviceIdentity` (UUID device id, deactivate-before-logout) is
  wired; APNs registration, the `aps-environment` entitlement and
  notification handling are not.
- Realtime SSE (`GET /realtime/stream`): optional. A future
  `RealtimeConnection` should use `URLSession.bytes(for:)` with the bearer
  header only, treat 204 as "off", fence on `api.currentGeneration()`,
  back off 1→30 s with jitter, and on 401/403 call `session.refreshUser()`
  once (which drives the single-flight refresh) before giving up.
  Correctness never depends on it (polling + reload on foreground).
- Shift colour persistence across launches (`ShiftColourRegistry.onAssigned`
  / `restore` hooks exist; keys are one-way hashes).
- Welcome/onboarding carousel (Flutter shows it once per install).
- Pop-to-root on re-tapping the active tab.

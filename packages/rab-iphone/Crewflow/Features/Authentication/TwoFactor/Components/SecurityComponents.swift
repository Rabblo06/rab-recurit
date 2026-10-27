import Combine
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// `emblem()`: 58 pt mint tile with a green symbol.
struct SecurityEmblem: View {
    let systemImage: String

    init(systemImage: String = "checkmark.shield") {
        self.systemImage = systemImage
    }

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 25, weight: .regular))
            .foregroundStyle(SecurityTokens.greenText)
            .frame(width: SecurityTokens.emblemSize, height: SecurityTokens.emblemSize)
            .background(RoundedRectangle(cornerRadius: SecurityTokens.emblemRadius, style: .continuous).fill(SecurityTokens.mint))
            .accessibilityHidden(true)
    }
}

/// `badge()`: On / Off pill with a dot. The state is in the text, never in
/// the colour alone.
struct SecurityBadge: View {
    let isOn: Bool

    init(isOn: Bool) {
        self.isOn = isOn
    }

    private var foreground: Color { isOn ? SecurityTokens.greenText : SecurityTokens.mutedOnTint }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(foreground).frame(width: 5, height: 5)
            Text(isOn ? "On" : "Off").scheduleType(SecurityType.badge.colored(foreground))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Capsule().fill(isOn ? SecurityTokens.mint : SecurityTokens.quiet))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isOn ? "On" : "Off")
        .accessibilityIdentifier("security.twoFactor.status")
    }
}

enum SecurityNoticeKind: Equatable {
    case info
    case warning
    case error
    case success
}

/// `notice()`: icon + text on a tinted panel. Errors are announced to
/// VoiceOver when they appear (`announce`).
struct SecurityNotice: View {
    let text: String
    let kind: SecurityNoticeKind
    let identifier: String?

    init(_ text: String, kind: SecurityNoticeKind = .info, identifier: String? = nil) {
        self.text = text
        self.kind = kind
        self.identifier = identifier
    }

    private var fill: Color {
        switch kind {
        case .info: return SecurityTokens.quiet
        case .warning: return SecurityTokens.amber
        case .error: return SecurityTokens.softRed
        case .success: return SecurityTokens.mint
        }
    }

    private var foreground: Color {
        switch kind {
        case .info: return SecurityTokens.mutedOnTint
        case .warning: return SecurityTokens.amberText
        case .error: return SecurityTokens.red
        case .success: return SecurityTokens.greenText
        }
    }

    private var icon: String {
        switch kind {
        case .info, .warning, .error: return "info.circle"
        case .success: return "checkmark"
        }
    }

    private var spokenPrefix: String {
        switch kind {
        case .info: return ""
        case .warning: return "Warning. "
        case .error: return "Error. "
        case .success: return ""
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .regular))
                .padding(.top, 1)
                .accessibilityHidden(true)
            Text(text)
                .scheduleType(SecurityType.notice.colored(foreground))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(foreground)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(fill))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenPrefix + text)
        .accessibilityIdentifier(identifier ?? "security.notice")
    }

    /// Posts a VoiceOver announcement (iOS 16: `UIAccessibility.post`).
    @MainActor
    static func announce(_ text: String) {
        UIAccessibility.post(notification: .announcement, argument: text)
    }
}

/// `steps(n)`: Confirm identity → Connect app → Save codes.
struct StepIndicator: View {
    static let titles = ["Confirm identity", "Connect app", "Save codes"]
    let current: Int

    init(current: Int) {
        self.current = current
    }

    static func style(active: Bool, current: Bool) -> ScheduleTextStyle {
        ScheduleTextStyle(
            size: 11,
            lineHeight: 1.3,
            weight: current ? .semibold : .regular,
            color: active ? SecurityTokens.ink : SecurityTokens.muted,
            relativeTo: .caption
        )
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(Array(Self.titles.enumerated()), id: \.offset) { index, title in
                let step = index + 1
                VStack(alignment: .leading, spacing: 0) {
                    Rectangle()
                        .fill(step <= current ? SecurityTokens.action : SecurityTokens.line)
                        .frame(height: 3)
                    Text(title)
                        .scheduleType(Self.style(active: step <= current, current: step == current))
                        .lineLimit(2)
                        .padding(.top, 10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(current) of \(Self.titles.count): \(Self.titles[max(0, min(current, Self.titles.count) - 1)])")
        .accessibilityIdentifier("security.steps")
    }
}

/// `field()`: a label above a 48 pt white field.
struct SecurityField<Field: View>: View {
    let label: String
    let isError: Bool
    private let field: Field

    init(_ label: String, isError: Bool = false, @ViewBuilder field: () -> Field) {
        self.label = label
        self.isError = isError
        self.field = field()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .scheduleType(SecurityType.label)
                .accessibilityHidden(true)
            field
                .scheduleType(SecurityType.row)
                .padding(.horizontal, 12)
                .frame(minHeight: SecurityTokens.fieldHeight)
                .background(RoundedRectangle(cornerRadius: SecurityTokens.fieldRadius, style: .continuous).fill(SecurityTokens.surface))
                .overlay(
                    RoundedRectangle(cornerRadius: SecurityTokens.fieldRadius, style: .continuous)
                        .stroke(isError ? SecurityTokens.red : SecurityTokens.line, lineWidth: 1)
                )
        }
    }
}

/// `.phone .card`: white, 22 pt radius, 20 pt padding.
struct SecurityCard<Content: View>: View {
    private let spacing: CGFloat
    private let content: Content

    init(spacing: CGFloat = 20, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            content
        }
        .padding(SecurityTokens.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: SecurityTokens.cardRadius, style: .continuous).fill(SecurityTokens.surface))
        .overlay(RoundedRectangle(cornerRadius: SecurityTokens.cardRadius, style: .continuous).stroke(SecurityTokens.cardLine, lineWidth: 1))
    }
}

/// A real, labelled checkbox (the design's `<label class="check">`).
struct SecurityCheckbox: View {
    let title: String
    @Binding var isOn: Bool
    let identifier: String

    init(_ title: String, isOn: Binding<Bool>, identifier: String) {
        self.title = title
        self._isOn = isOn
        self.identifier = identifier
    }

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(isOn ? SecurityTokens.action : SecurityTokens.muted)
                Text(title)
                    .scheduleType(SecurityType.row)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(isOn ? "Checked" : "Not checked")
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(identifier)
    }
}

/// The signed-in account (`.mobile-account`): initials avatar, name, email.
struct SecurityAccountHeader: View {
    let name: String
    let email: String

    init(name: String, email: String) {
        self.name = name
        self.email = email
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(InitialsAvatar.initials(for: name))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SecurityTokens.avatarText)
                .frame(width: 46, height: 46)
                .background(Circle().fill(SecurityTokens.avatar))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).scheduleType(SecurityType.name).lineLimit(2)
                Text(email).scheduleType(SecurityType.caption).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Clipboard

/// Copies a secret (setup key, recovery codes) to THIS device's pasteboard
/// only: never Handoff/Universal Clipboard, and it expires after 5 minutes.
enum SecurePasteboard {
    static let lifetime: TimeInterval = 300

    @MainActor
    static func copy(_ text: String) {
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: text]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(lifetime)]
        )
    }
}

// MARK: - Privacy

/// Whether any screen showing this app is being recorded, mirrored or
/// AirPlayed. Read through the window scenes (no deprecated `UIScreen.main`).
enum ScreenCapture {
    @MainActor
    static var isCaptured: Bool {
        UIApplication.shared.connectedScenes.contains { scene in
            (scene as? UIWindowScene)?.screen.isCaptured == true
        }
    }
}

/// Covers a secret (TOTP setup key, recovery codes) whenever the app is not
/// active — so the app-switcher snapshot never contains it — and while the
/// screen is being recorded, mirrored or AirPlayed
/// (`UIScreen.capturedDidChangeNotification`). iOS cannot block a
/// screenshot; `SecurityScreenshotNotice` reacts to one instead.
struct SensitiveContentShield: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @State private var captured = false

    init() {}

    private var hidden: Bool { scenePhase != .active || captured }

    func body(content: Content) -> some View {
        content
            .accessibilityHidden(hidden)
            .overlay {
                if hidden {
                    SecurityPrivacyCover(recording: captured)
                }
            }
            .onAppear { captured = ScreenCapture.isCaptured }
            .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { _ in
                captured = ScreenCapture.isCaptured
            }
    }
}

struct SecurityPrivacyCover: View {
    let recording: Bool

    init(recording: Bool) {
        self.recording = recording
    }

    var body: some View {
        VStack(spacing: 14) {
            SecurityEmblem(systemImage: "eye.slash")
            Text("Hidden for your security")
                .scheduleType(SecurityType.cardTitle)
                .multilineTextAlignment(.center)
            Text(recording
                 ? "Your setup key and recovery codes are hidden while your screen is being recorded or shared."
                 : "Your setup key and recovery codes are hidden while Crewflow is in the background.")
                .scheduleType(SecurityType.body)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SecurityTokens.canvas.ignoresSafeArea())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("security.privacyCover")
    }
}

extension View {
    /// See `SensitiveContentShield`.
    func sensitiveContentShield() -> some View {
        modifier(SensitiveContentShield())
    }
}

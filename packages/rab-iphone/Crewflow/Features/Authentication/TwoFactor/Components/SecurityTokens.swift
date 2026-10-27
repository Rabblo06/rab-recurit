import SwiftUI

/// Account-security colours from the owner's design
/// (docs/design/crewflow-account-security.html, `:root` + `.phone`), with
/// the owner's contrast decision (2026-10-24): green TEXT #007256 and muted
/// text on tinted panels #5a6c84; the fills are unchanged. Light only, like
/// the rest of the app (`.preferredColorScheme(.light)`).
enum SecurityPalette {
    static let canvas = RGBA(argb: 0xFFF7F7F9)
    static let surface = RGBA(argb: 0xFFFFFFFF)
    static let ink = RGBA(argb: 0xFF102235)
    static let muted = RGBA(argb: 0xFF647892)
    static let mutedOnTint = RGBA(argb: 0xFF5A6C84)
    static let line = RGBA(argb: 0xFFE1E4EB)
    static let cardLine = RGBA(argb: 0xFFE6E9EB)
    static let action = RGBA(argb: 0xFF161916)
    static let quiet = RGBA(argb: 0xFFF0F1F4)
    static let red = RGBA(argb: 0xFFBB3438)
    static let redLine = RGBA(argb: 0xFFEABFC1)
    static let softRed = RGBA(argb: 0xFFFCEFF0)
    static let greenText = RGBA(argb: 0xFF007256)
    static let mint = RGBA(argb: 0xFFE9F7F0)
    static let amber = RGBA(argb: 0xFFFFF3DD)
    static let amberText = RGBA(argb: 0xFF8C580B)
    static let emptyDigit = RGBA(argb: 0xFFA4ADBB)
    static let avatar = RGBA(argb: 0xFFDEDFFE)
    static let avatarText = RGBA(argb: 0xFF3F3E91)
}

enum SecurityTokens {
    static let canvas = SecurityPalette.canvas.color
    static let surface = SecurityPalette.surface.color
    static let ink = SecurityPalette.ink.color
    static let muted = SecurityPalette.muted.color
    static let mutedOnTint = SecurityPalette.mutedOnTint.color
    static let line = SecurityPalette.line.color
    static let cardLine = SecurityPalette.cardLine.color
    static let action = SecurityPalette.action.color
    static let quiet = SecurityPalette.quiet.color
    static let red = SecurityPalette.red.color
    static let redLine = SecurityPalette.redLine.color
    static let softRed = SecurityPalette.softRed.color
    static let greenText = SecurityPalette.greenText.color
    static let mint = SecurityPalette.mint.color
    static let amber = SecurityPalette.amber.color
    static let amberText = SecurityPalette.amberText.color
    static let emptyDigit = SecurityPalette.emptyDigit.color
    static let avatar = SecurityPalette.avatar.color
    static let avatarText = SecurityPalette.avatarText.color

    // `.phone` metrics (points).
    static let bodyInset: CGFloat = 24
    static let sectionGap: CGFloat = 24
    static let cardRadius: CGFloat = 22
    static let cardPadding: CGFloat = 20
    static let fieldRadius: CGFloat = 8
    static let fieldHeight: CGFloat = 48
    static let buttonHeight: CGFloat = 48
    static let emblemSize: CGFloat = 58
    static let emblemRadius: CGFloat = 20
}

/// The design's phone type scale, on the system font (owner decision: no
/// font files). Every role scales with Dynamic Type via `scheduleType`.
enum SecurityType {
    static let title = ScheduleTextStyle(size: 25, lineHeight: 1.2, weight: .semibold, color: SecurityTokens.ink, tracking: -0.7, relativeTo: .title)
    static let cardTitle = ScheduleTextStyle(size: 19, lineHeight: 1.3, weight: .semibold, color: SecurityTokens.ink, tracking: -0.3, relativeTo: .title3)
    static let name = ScheduleTextStyle(size: 15, lineHeight: 1.3, weight: .semibold, color: SecurityTokens.ink, relativeTo: .headline)
    static let navTitle = ScheduleTextStyle(size: 15, lineHeight: 1.25, weight: .semibold, color: SecurityTokens.ink, relativeTo: .headline)
    static let body = ScheduleTextStyle(size: 13, lineHeight: 1.7, color: SecurityTokens.muted, relativeTo: .subheadline)
    static let row = ScheduleTextStyle(size: 14, lineHeight: 1.35, color: SecurityTokens.ink, relativeTo: .body)
    static let rowStrong = ScheduleTextStyle(size: 14, lineHeight: 1.35, weight: .semibold, color: SecurityTokens.ink, relativeTo: .body)
    static let label = ScheduleTextStyle(size: 12, lineHeight: 1.3, weight: .medium, color: SecurityTokens.muted, relativeTo: .footnote)
    static let notice = ScheduleTextStyle(size: 12, lineHeight: 1.45, relativeTo: .footnote)
    static let caption = ScheduleTextStyle(size: 12, lineHeight: 1.5, color: SecurityTokens.muted, relativeTo: .footnote)
    static let step = ScheduleTextStyle(size: 11, lineHeight: 1.3, color: SecurityTokens.muted, relativeTo: .caption)
    static let badge = ScheduleTextStyle(size: 12, lineHeight: 1.2, weight: .medium, relativeTo: .caption)
    static let button = ScheduleTextStyle(size: 14, lineHeight: 1.2, weight: .semibold, relativeTo: .body)
    static let link = ScheduleTextStyle(size: 13, lineHeight: 1.2, weight: .medium, color: SecurityTokens.ink, relativeTo: .subheadline)
}

// MARK: - Buttons

enum SecurityButtonKind: Equatable {
    case primary
    case secondary
    case danger
}

/// The visual of a security action: 48 pt pill (`.phone .btn`). Shared by
/// `SecurityButton` and the `ShareLink` label so both look identical.
struct SecurityButtonLabel: View {
    let title: String
    var systemImage: String?
    var kind: SecurityButtonKind = .primary
    var isBusy = false
    var isEnabled = true

    private var foreground: Color {
        switch kind {
        case .primary: return .white
        case .secondary: return SecurityTokens.ink
        case .danger: return SecurityTokens.red
        }
    }

    private var fill: Color {
        kind == .primary ? SecurityTokens.action : SecurityTokens.surface
    }

    private var stroke: Color {
        switch kind {
        case .primary: return SecurityTokens.action
        case .secondary: return SecurityTokens.line
        case .danger: return SecurityTokens.redLine
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            if isBusy {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(foreground)
                    .controlSize(.small)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .semibold))
                    .accessibilityHidden(true)
            }
            Text(isBusy ? "Please wait…" : title)
                .scheduleType(SecurityType.button.colored(foreground))
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: SecurityTokens.buttonHeight)
        .background(Capsule().fill(fill))
        .overlay(Capsule().stroke(stroke, lineWidth: 1))
        .opacity(isEnabled ? 1 : 0.55)
        .contentShape(Capsule())
    }
}

struct SecurityButton: View {
    let title: String
    let systemImage: String?
    let kind: SecurityButtonKind
    let isBusy: Bool
    let action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    init(_ title: String, systemImage: String? = nil, kind: SecurityButtonKind = .primary, isBusy: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.kind = kind
        self.isBusy = isBusy
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            SecurityButtonLabel(title: title, systemImage: systemImage, kind: kind, isBusy: isBusy, isEnabled: isEnabled && !isBusy)
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(isBusy)
        .accessibilityLabel(title)
        .accessibilityValue(isBusy ? "Please wait" : "")
    }
}

/// The design's text link (`.link`), with a 44 pt touch target.
struct SecurityLinkButton: View {
    let title: String
    let color: Color
    let action: () -> Void

    init(_ title: String, color: Color = SecurityTokens.ink, action: @escaping () -> Void) {
        self.title = title
        self.color = color
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .scheduleType(SecurityType.link.colored(color))
                .multilineTextAlignment(.center)
                .frame(minHeight: 44)
                .padding(.horizontal, 8)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Screen frame

/// The design's mobile header (`.mobile-nav`): a 36 pt rounded back control,
/// a centred 15 pt title and a balancing spacer.
struct SecurityNavBar: View {
    let title: String
    let showBack: Bool
    let onBack: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    init(title: String, showBack: Bool = true, onBack: (() -> Void)? = nil) {
        self.title = title
        self.showBack = showBack
        self.onBack = onBack
    }

    var body: some View {
        ZStack {
            Text(title)
                .scheduleType(SecurityType.navTitle)
                .lineLimit(1)
                .padding(.horizontal, 56)
                .accessibilityAddTraits(.isHeader)
            HStack {
                if showBack {
                    Button {
                        if let onBack { onBack() } else { dismiss() }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(SecurityTokens.ink)
                            .frame(width: 36, height: 36)
                            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(SecurityTokens.surface))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(SecurityTokens.line, lineWidth: 1))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle())
                    .accessibilityLabel("Back")
                    .accessibilityIdentifier("security.back")
                }
                Spacer(minLength: 0)
            }
        }
        .frame(height: 56)
        .padding(.horizontal, 16)
    }
}

/// One account-security screen: header, scrolling body (24 pt inset, 24 pt
/// gaps) and an optional sticky action area (`.mobile-actions`) that stays
/// above the keyboard and the home indicator.
struct SecurityScreen<Content: View, Actions: View>: View {
    let title: String
    let showBack: Bool
    let onBack: (() -> Void)?
    private let hasActions: Bool
    private let content: Content
    private let actions: Actions

    init(
        title: String,
        showBack: Bool = true,
        onBack: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content,
        @ViewBuilder actions: () -> Actions
    ) {
        self.title = title
        self.showBack = showBack
        self.onBack = onBack
        self.hasActions = Actions.self != EmptyView.self
        self.content = content()
        self.actions = actions()
    }

    var body: some View {
        VStack(spacing: 0) {
            SecurityNavBar(title: title, showBack: showBack, onBack: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: SecurityTokens.sectionGap) {
                    content
                }
                .padding(SecurityTokens.bodyInset)
                .frame(maxWidth: ScheduleTokens.contentMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if hasActions {
                VStack(spacing: 12) {
                    actions
                }
                .padding(EdgeInsets(top: 16, leading: SecurityTokens.bodyInset, bottom: 18, trailing: SecurityTokens.bodyInset))
                .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                .frame(maxWidth: .infinity)
                .background(SecurityTokens.canvas)
            }
        }
        .background(SecurityTokens.canvas.ignoresSafeArea())
    }
}

extension SecurityScreen where Actions == EmptyView {
    init(title: String, showBack: Bool = true, onBack: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, showBack: showBack, onBack: onBack, content: content) { EmptyView() }
    }
}

/// Heading + muted body copy of each step (`<h1>` + `.body-copy`).
struct SecurityHeading: View {
    let title: String
    let message: String?

    init(_ title: String, message: String? = nil) {
        self.title = title
        self.message = message
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .scheduleType(SecurityType.title)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let message {
                Text(message)
                    .scheduleType(SecurityType.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

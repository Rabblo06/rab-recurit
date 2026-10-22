import SwiftUI

/// The app's primary action (Flutter `SchedulePrimaryButton`): 54 pt
/// capsule, black accent by default (navy for Venue Manager report screens
/// via `background`), or the white `.light` secondary beside it. Busy state
/// disables activation, shows "Please wait…" and keeps the label for
/// VoiceOver. Content grows with Dynamic Type.
public struct PrimaryButton: View {
    public enum Variant: Sendable {
        case primary
        case light
    }

    private let title: String
    private let systemImage: String?
    private let variant: Variant
    private let isBusy: Bool
    private let background: Color?
    private let action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    public init(
        _ title: String,
        systemImage: String? = nil,
        variant: Variant = .primary,
        isBusy: Bool = false,
        background: Color? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.variant = variant
        self.isBusy = isBusy
        self.background = background
        self.action = action
    }

    private var enabled: Bool { isEnabled && !isBusy }

    private var foreground: Color {
        guard enabled else { return ScheduleTokens.muted }
        return variant == .light ? ScheduleTokens.ink : .white
    }

    private var fill: Color {
        switch variant {
        case .light:
            return enabled ? .white : Color.white.opacity(0.6)
        case .primary:
            return enabled ? (background ?? ScheduleTokens.accent) : SchedulePalette.disabledFill.color
        }
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(foreground)
                        .controlSize(.small)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 18, weight: .semibold))
                        .accessibilityHidden(true)
                }
                Text(isBusy ? "Please wait…" : title)
                    .scheduleType(ScheduleType.button)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: ScheduleTokens.actionHeight)
            .background(Capsule().fill(fill))
            .overlay {
                if variant == .light {
                    Capsule().stroke(ScheduleTokens.border, lineWidth: 1)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(isBusy)
        .accessibilityLabel(title)
        .accessibilityValue(isBusy ? "Please wait" : "")
    }
}

/// Subtle press feedback without changing layout.
public struct PressableButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Sticky bottom action area (Flutter `ScheduleBottomAction`): equal side
/// margins, centred content capped at 520 pt, clear of the home indicator
/// and the keyboard. Use with `.safeAreaInset(edge: .bottom)`.
public struct BottomAction<Content: View>: View {
    private let top: CGFloat
    private let horizontal: CGFloat
    private let content: Content

    public init(top: CGFloat = 8, horizontal: CGFloat = ScheduleTokens.actionInset, @ViewBuilder content: () -> Content) {
        self.top = top
        self.horizontal = horizontal
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, horizontal)
            .padding(.top, top)
            .padding(.bottom, 12)
    }
}

/// Centred-title header with the round back control (Flutter
/// `ScheduleNavHeader`). The title is centred on the screen, not between the
/// controls, and ellipsizes before reaching them. `centerTitle: false` puts
/// it beside the back control (Venue Manager list screens).
public struct NavHeader<Trailing: View>: View {
    private let title: String
    private let showBack: Bool
    private let centerTitle: Bool
    private let backgroundColor: Color
    private let foreground: Color
    private let onBack: (() -> Void)?
    private let trailing: Trailing

    @Environment(\.dismiss) private var dismiss

    public static var height: CGFloat { 56 }
    private let control: CGFloat = 48

    public init(
        _ title: String,
        showBack: Bool = true,
        centerTitle: Bool = true,
        backgroundColor: Color = .white,
        foreground: Color = ScheduleTokens.ink,
        onBack: (() -> Void)? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.showBack = showBack
        self.centerTitle = centerTitle
        self.backgroundColor = backgroundColor
        self.foreground = foreground
        self.onBack = onBack
        self.trailing = trailing()
    }

    private var titleView: some View {
        Text(title)
            .scheduleType(ScheduleType.navTitle.colored(foreground))
            .lineLimit(1)
            .truncationMode(.tail)
            .multilineTextAlignment(centerTitle ? .center : .leading)
            .accessibilityAddTraits(.isHeader)
    }

    private var backButton: some View {
        Button {
            if let onBack { onBack() } else { dismiss() }
        } label: {
            ZStack {
                Circle().fill(backgroundColor)
                if backgroundColor == .white {
                    Circle().stroke(ScheduleTokens.border, lineWidth: 1)
                }
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(foreground)
            }
            .frame(width: 40, height: 40)
            .frame(width: control, height: control)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel("Back")
    }

    public var body: some View {
        if centerTitle {
            ZStack {
                titleView.padding(.horizontal, control + 8)
                HStack {
                    if showBack { backButton }
                    Spacer(minLength: 0)
                    trailing
                }
            }
            .frame(height: Self.height)
        } else {
            HStack(spacing: 4) {
                if showBack { backButton }
                titleView.frame(maxWidth: .infinity, alignment: .leading)
                trailing
            }
            .frame(minHeight: Self.height)
        }
    }
}

public extension NavHeader where Trailing == EmptyView {
    init(
        _ title: String,
        showBack: Bool = true,
        centerTitle: Bool = true,
        backgroundColor: Color = .white,
        foreground: Color = ScheduleTokens.ink,
        onBack: (() -> Void)? = nil
    ) {
        self.init(title, showBack: showBack, centerTitle: centerTitle, backgroundColor: backgroundColor, foreground: foreground, onBack: onBack) {
            EmptyView()
        }
    }
}

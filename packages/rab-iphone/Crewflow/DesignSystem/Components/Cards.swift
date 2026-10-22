import SwiftUI

/// Semantic kind shared by message cards and toasts. State is always
/// conveyed by text AND an icon, never by colour alone.
public enum FeedbackKind: String, Sendable, CaseIterable {
    case info
    case success
    case warning
    case error
}

/// Status pill in the shift's identity colour ("New Offer", "Confirmed").
/// `warning` switches to the shared danger tone; the text always states the
/// status.
public struct StatusBadge: View {
    private let label: String
    private let style: ShiftVisualStyle?
    private let warning: Bool

    public init(_ label: String, style: ShiftVisualStyle?, warning: Bool = false) {
        self.label = label
        self.style = style
        self.warning = warning
    }

    private var surface: Color {
        if warning { return ScheduleTokens.dangerSoft }
        return style?.badgeSurface ?? ScheduleTokens.border
    }

    private var text: Color {
        if warning { return ScheduleTokens.errorText }
        return style?.badgeText ?? ScheduleTokens.ink
    }

    public var body: some View {
        Text(label)
            .scheduleType(ScheduleType.badge.colored(text))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(surface))
    }
}

/// Icon + text metadata on shift cards (date, time).
public struct ShiftMetaItem: View {
    private let systemImage: String
    private let label: String

    public init(systemImage: String, label: String) {
        self.systemImage = systemImage
        self.label = label
    }

    public var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 15))
                .foregroundStyle(ScheduleTokens.muted)
                .accessibilityHidden(true)
            Text(label).scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
        }
    }
}

/// Pay / outcome line under a card divider, with the reference's leading bar.
public struct ShiftCardFooterLine: View {
    private let text: String
    private let color: Color

    public init(_ text: String, color: Color = ScheduleTokens.muted) {
        self.text = text
        self.color = color
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle()
                .fill(ScheduleTokens.muted.opacity(0.5))
                .frame(width: 2)
            Text(text).scheduleType(ScheduleType.secondary.colored(color))
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The shared Offers / Confirmed / History shift card (Flutter
/// `ShiftPastelCard`): identity-coloured surface, status badge, role, venue,
/// date and time, a divider, then caller-supplied footer and actions. Owns
/// no data loading, rule or navigation; `onOpen` is the caller's.
/// (Venue photo is not rendered yet: it needs the authenticated
/// `/files/:id` image loader a feature agent will add.)
public struct PastelShiftCard<Footer: View, Actions: View>: View {
    private let style: ShiftVisualStyle
    private let badge: String
    private let badgeWarning: Bool
    private let role: String
    private let venue: String
    private let startsAt: Date
    private let endsAt: Date
    private let onOpen: (() -> Void)?
    private let footer: Footer
    private let actions: Actions

    public init(
        style: ShiftVisualStyle,
        badge: String,
        badgeWarning: Bool = false,
        role: String,
        venue: String,
        startsAt: Date,
        endsAt: Date,
        onOpen: (() -> Void)? = nil,
        @ViewBuilder footer: () -> Footer,
        @ViewBuilder actions: () -> Actions
    ) {
        self.style = style
        self.badge = badge
        self.badgeWarning = badgeWarning
        self.role = role
        self.venue = venue
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.onOpen = onOpen
        self.footer = footer()
        self.actions = actions()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                StatusBadge(badge, style: style, warning: badgeWarning)
                Spacer(minLength: 8)
                if let onOpen {
                    Button(action: onOpen) {
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(ScheduleTokens.ink)
                            .frame(width: 38, height: 38)
                            .background(Circle().fill(Color.white))
                            .frame(width: ScheduleTokens.touchTarget, height: ScheduleTokens.touchTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle())
                    .accessibilityLabel("Open \(role)")
                }
            }
            Text(role).scheduleType(ScheduleType.cardTitle)
            Text(venue).scheduleType(ScheduleType.secondary)
            HStack(spacing: 16) {
                ShiftMetaItem(systemImage: "calendar", label: CrewflowDateFormat.weekdayDay(startsAt))
                ShiftMetaItem(systemImage: "clock", label: CrewflowDateFormat.timeRange(startsAt, endsAt))
            }
            Divider().overlay(style.cardBorder)
            footer
            actions
        }
        .padding(EdgeInsets(top: 16, leading: 18, bottom: 18, trailing: 14))
        .background(
            RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous)
                .fill(style.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous)
                .stroke(style.cardBorder, lineWidth: 1)
        )
        .shadow(color: style.shadowColor, radius: 9, x: 0, y: 5)
        .accessibilityElement(children: .contain)
    }
}

public extension PastelShiftCard where Actions == EmptyView {
    init(
        style: ShiftVisualStyle,
        badge: String,
        badgeWarning: Bool = false,
        role: String,
        venue: String,
        startsAt: Date,
        endsAt: Date,
        onOpen: (() -> Void)? = nil,
        @ViewBuilder footer: () -> Footer
    ) {
        self.init(style: style, badge: badge, badgeWarning: badgeWarning, role: role, venue: venue, startsAt: startsAt, endsAt: endsAt, onOpen: onOpen, footer: footer) {
            EmptyView()
        }
    }
}

/// Round initials avatar for people lists and profile headers.
public struct InitialsAvatar: View {
    private let name: String
    private let size: CGFloat
    private let background: Color

    public init(name: String, size: CGFloat = 44, background: Color = ScheduleTokens.lavender) {
        self.name = name
        self.size = size
        self.background = background
    }

    /// Up to two initials from the first and last words; "?" when empty.
    public static func initials(for name: String) -> String {
        let words = name.split(whereSeparator: { $0.isWhitespace }).filter { !$0.isEmpty }
        guard let first = words.first?.first else { return "?" }
        guard words.count > 1, let last = words.last?.first else { return String(first).uppercased() }
        return (String(first) + String(last)).uppercased()
    }

    public var body: some View {
        Text(Self.initials(for: name))
            .font(.system(size: size * 0.38, weight: .semibold))
            .foregroundStyle(ScheduleTokens.ink)
            .frame(width: size, height: size)
            .background(Circle().fill(background))
            .accessibilityLabel(name)
    }
}

/// Persistent feedback card (Flutter `ScheduleMessageCard`): a state that
/// must be read or resolved (load failure + Retry, confirmation, inline
/// form error). Temporary results use the toast system instead.
public struct MessageCard: View {
    private let title: String
    private let message: String?
    private let kind: FeedbackKind
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(title: String, message: String? = nil, kind: FeedbackKind = .info, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.message = message
        self.kind = kind
        self.actionTitle = actionTitle
        self.action = action
    }

    private var surface: Color {
        switch kind {
        case .info: return ScheduleTokens.lavender
        case .success: return ScheduleTokens.homeMint
        case .warning: return ScheduleTokens.homePeach
        case .error: return ScheduleTokens.dangerSoft
        }
    }

    private var foreground: Color {
        switch kind {
        case .error: return ScheduleTokens.errorText
        case .success: return ScheduleTokens.successText
        case .warning: return ScheduleTokens.warningText
        case .info: return ScheduleTokens.ink
        }
    }

    private var icon: String {
        switch kind {
        case .info: return "info.circle"
        case .success: return "checkmark.circle"
        case .warning: return "exclamationmark.triangle"
        case .error: return "exclamationmark.circle"
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .foregroundStyle(foreground)
                    .accessibilityLabel(kind.rawValue.capitalized)
                // A separate heading stays neutral; without a body the title
                // IS the message and takes the semantic colour.
                Text(title)
                    .scheduleType(ScheduleType.bodyStrong.colored(message == nil ? foreground : ScheduleTokens.ink))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let message {
                Text(message).scheduleType(ScheduleType.body.colored(foreground))
            }
            if let actionTitle, let action {
                PrimaryButton(actionTitle, action: action).padding(.top, 4)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).fill(surface)
        )
        .accessibilityElement(children: .contain)
    }
}

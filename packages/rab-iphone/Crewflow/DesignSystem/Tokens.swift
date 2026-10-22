import SwiftUI

/// sRGB colour value used for tokens that must be blended (Flutter's
/// `Color.lerp`), compared in tests, or converted to `Color`.
public struct RGBA: Equatable, Hashable, Sendable {
    public var red: Double
    public var green: Double
    public var blue: Double
    public var alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    /// `0xAARRGGBB`, the same literal form as Flutter's `Color(0xFF...)`.
    public init(argb: UInt32) {
        alpha = Double((argb >> 24) & 0xFF) / 255
        red = Double((argb >> 16) & 0xFF) / 255
        green = Double((argb >> 8) & 0xFF) / 255
        blue = Double(argb & 0xFF) / 255
    }

    /// Linear interpolation per channel, like Flutter's `Color.lerp`.
    public func lerp(to other: RGBA, _ t: Double) -> RGBA {
        func mix(_ a: Double, _ b: Double) -> Double { min(max(a + (b - a) * t, 0), 1) }
        return RGBA(red: mix(red, other.red), green: mix(green, other.green), blue: mix(blue, other.blue), alpha: mix(alpha, other.alpha))
    }

    public func withAlpha(_ value: Double) -> RGBA {
        RGBA(red: red, green: green, blue: blue, alpha: value)
    }

    /// `0xAARRGGBB` rounded back to 8-bit channels (test helper).
    public var argb: UInt32 {
        func byte(_ v: Double) -> UInt32 { UInt32((min(max(v, 0), 1) * 255).rounded()) }
        return byte(alpha) << 24 | byte(red) << 16 | byte(green) << 8 | byte(blue)
    }

    public var color: Color {
        Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
}

/// Raw palette, ported 1:1 from `ScheduleTokens`
/// (packages/rab-mobile/lib/core/theme/schedule_tokens.dart).
public enum SchedulePalette {
    public static let homeBackground = RGBA(argb: 0xFFF7F7F9)
    public static let homePeach = RGBA(argb: 0xFFF8ECDF)
    public static let homeMint = RGBA(argb: 0xFFE2F2EC)
    public static let background = RGBA(argb: 0xFFF7F6FB)
    public static let surface = RGBA(argb: 0xFFFFFFFF)
    public static let ink = RGBA(argb: 0xFF171B19)
    public static let muted = RGBA(argb: 0xFF62666B)
    public static let accent = RGBA(argb: 0xFF050908)
    public static let navy = RGBA(argb: 0xFF0D1B33)
    public static let peach = RGBA(argb: 0xFFFFF2E9)
    public static let mint = RGBA(argb: 0xFFECFCF5)
    public static let lavender = RGBA(argb: 0xFFDFE2FF)
    public static let yellow = RGBA(argb: 0xFFFFDA79)
    public static let paleBlue = RGBA(argb: 0xFFDCEAFB)
    public static let danger = RGBA(argb: 0xFFC9604F)
    public static let dangerSoft = RGBA(argb: 0xFFF6E4E0)
    public static let errorText = RGBA(argb: 0xFFC62828)
    public static let successText = RGBA(argb: 0xFF18713B)
    public static let toastBorder = RGBA(argb: 0x1F171B19)
    public static let toastErrorFill = RGBA(argb: 0xFFFDECEC)
    public static let toastSuccessFill = RGBA(argb: 0xFFE7F6EC)
    public static let toastWarningFill = RGBA(argb: 0xFFFFF3DC)
    public static let toastInfoFill = RGBA(argb: 0xFFE8F0FE)
    public static let warningText = RGBA(argb: 0xFFB54708)
    public static let warningIcon = RGBA(argb: 0xFFDC8A06)
    public static let infoIcon = RGBA(argb: 0xFF2563EB)
    public static let successIcon = RGBA(argb: 0xFF1F8A4C)
    public static let border = RGBA(argb: 0x22797B80)
    public static let disabledFill = RGBA(argb: 0xFFD9DADF)
}

/// Colours and metrics. Names match the Flutter tokens so a screen can be
/// ported by reading the Dart source side by side.
public enum ScheduleTokens {
    // Colours
    public static let homeBackground = SchedulePalette.homeBackground.color
    public static let homePeach = SchedulePalette.homePeach.color
    public static let homeMint = SchedulePalette.homeMint.color
    public static let background = SchedulePalette.background.color
    public static let surface = SchedulePalette.surface.color
    public static let ink = SchedulePalette.ink.color
    public static let muted = SchedulePalette.muted.color
    public static let accent = SchedulePalette.accent.color
    public static let navy = SchedulePalette.navy.color
    public static let peach = SchedulePalette.peach.color
    public static let mint = SchedulePalette.mint.color
    public static let lavender = SchedulePalette.lavender.color
    public static let danger = SchedulePalette.danger.color
    public static let dangerSoft = SchedulePalette.dangerSoft.color
    public static let errorText = SchedulePalette.errorText.color
    public static let successText = SchedulePalette.successText.color
    public static let warningText = SchedulePalette.warningText.color
    public static let border = SchedulePalette.border.color

    // Metrics (points; Flutter logical pixels map 1:1)
    public static let homeInset: CGFloat = 24
    public static let homeSectionGap: CGFloat = 20
    public static let touchTarget: CGFloat = 48
    public static let cardRadius: CGFloat = 28
    public static let panelRadius: CGFloat = 24
    public static let rowRadius: CGFloat = 20
    public static let fieldRadius: CGFloat = 12
    public static let badgeRadius: CGFloat = 16
    public static let cardInset: CGFloat = 16
    public static let sheetRadius: CGFloat = 32
    public static let sheetInset: CGFloat = 24
    public static let actionHeight: CGFloat = 54
    public static let actionInset: CGFloat = 20
    public static let contentMaxWidth: CGFloat = 520
    public static let toastRadius: CGFloat = 12

    // Floating tab bar
    public static let navigationWidthFactor: CGFloat = 0.90
    public static let navigationMaxWidth: CGFloat = 440
    public static let navigationHeight: CGFloat = 72
    public static let navigationPadding: CGFloat = 8
    public static let navigationActiveSize: CGFloat = 54
    public static let navigationIconSize: CGFloat = 24
    public static let navigationBottom: CGFloat = 12

    // Motion
    public static let segmentMotion: Double = 0.30
    public static let styleMotion: Double = 0.25
}

/// One text role of the schedule type scale.
public struct ScheduleTextStyle {
    public let size: CGFloat
    public let lineHeight: CGFloat
    public let weight: Font.Weight
    public let color: Color?
    public let tracking: CGFloat
    public let monospacedDigits: Bool
    /// Dynamic Type curve this role scales with.
    public let relativeTo: Font.TextStyle

    public init(size: CGFloat, lineHeight: CGFloat, weight: Font.Weight = .regular, color: Color? = nil, tracking: CGFloat = 0, monospacedDigits: Bool = false, relativeTo: Font.TextStyle) {
        self.size = size
        self.lineHeight = lineHeight
        self.weight = weight
        self.color = color
        self.tracking = tracking
        self.monospacedDigits = monospacedDigits
        self.relativeTo = relativeTo
    }

    public func colored(_ color: Color) -> ScheduleTextStyle {
        ScheduleTextStyle(size: size, lineHeight: lineHeight, weight: weight, color: color, tracking: tracking, monospacedDigits: monospacedDigits, relativeTo: relativeTo)
    }
}

/// The app's single type scale (Flutter `ScheduleType`). Sizes scale with
/// the user's Dynamic Type setting; screens pick a role, never a raw size.
public enum ScheduleType {
    public static let pageTitle = ScheduleTextStyle(size: 26, lineHeight: 1.2, weight: .bold, color: ScheduleTokens.ink, relativeTo: .title)
    public static let navTitle = ScheduleTextStyle(size: 19, lineHeight: 1.25, weight: .semibold, color: ScheduleTokens.ink, relativeTo: .headline)
    public static let venueTitle = ScheduleTextStyle(size: 19, lineHeight: 1.25, weight: .semibold, color: ScheduleTokens.ink, relativeTo: .headline)
    public static let cardTitle = ScheduleTextStyle(size: 18, lineHeight: 1.25, weight: .bold, color: ScheduleTokens.ink, relativeTo: .headline)
    public static let heading = ScheduleTextStyle(size: 20, lineHeight: 1.25, weight: .semibold, color: ScheduleTokens.ink, relativeTo: .title3)
    public static let body = ScheduleTextStyle(size: 15, lineHeight: 1.4, color: ScheduleTokens.ink, relativeTo: .body)
    public static let bodyStrong = ScheduleTextStyle(size: 15, lineHeight: 1.4, weight: .semibold, color: ScheduleTokens.ink, relativeTo: .body)
    public static let secondary = ScheduleTextStyle(size: 14, lineHeight: 1.4, color: ScheduleTokens.muted, relativeTo: .subheadline)
    public static let caption = ScheduleTextStyle(size: 13, lineHeight: 1.35, color: ScheduleTokens.muted, relativeTo: .footnote)
    public static let overline = ScheduleTextStyle(size: 12, lineHeight: 1.3, weight: .semibold, color: ScheduleTokens.muted, tracking: 0.6, relativeTo: .caption)
    public static let badge = ScheduleTextStyle(size: 13, lineHeight: 1.2, weight: .semibold, relativeTo: .footnote)
    public static let button = ScheduleTextStyle(size: 16, lineHeight: 1.2, weight: .semibold, relativeTo: .body)
    public static let timer = ScheduleTextStyle(size: 52, lineHeight: 1.05, color: ScheduleTokens.ink, monospacedDigits: true, relativeTo: .largeTitle)
    public static let timerLabel = ScheduleTextStyle(size: 12, lineHeight: 1.2, weight: .semibold, color: ScheduleTokens.muted, tracking: 0.8, relativeTo: .caption)
}

struct ScheduleTextModifier: ViewModifier {
    let style: ScheduleTextStyle
    @ScaledMetric private var size: CGFloat

    init(style: ScheduleTextStyle) {
        self.style = style
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: style.relativeTo)
    }

    func body(content: Content) -> some View {
        let base = Font.system(size: size, weight: style.weight)
        // SF's natural line height is ~1.2x the point size; add the rest.
        let extra = max(0, (style.lineHeight - 1.2) * size)
        return content
            .font(style.monospacedDigits ? base.monospacedDigit() : base)
            .tracking(style.tracking)
            .lineSpacing(extra)
            .modifier(OptionalForeground(color: style.color))
    }
}

private struct OptionalForeground: ViewModifier {
    let color: Color?
    @ViewBuilder
    func body(content: Content) -> some View {
        if let color {
            content.foregroundStyle(color)
        } else {
            content
        }
    }
}

public extension View {
    /// Applies a schedule type role (scaled with Dynamic Type).
    func scheduleType(_ style: ScheduleTextStyle) -> some View {
        modifier(ScheduleTextModifier(style: style))
    }
}

/// Soft card shadow (`ScheduleTokens.shadows`).
public extension View {
    func scheduleCardShadow() -> some View {
        shadow(color: RGBA(argb: 0x0D27213C).color, radius: 9, x: 0, y: 6)
    }
}

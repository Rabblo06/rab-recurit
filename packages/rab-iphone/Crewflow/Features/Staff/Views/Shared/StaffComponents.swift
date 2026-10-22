import SwiftUI
import UIKit

// Staff-feature UI pieces used by several Staff screens. Prefixed `Staff` so
// they never collide with the Venue Manager feature. Candidates to move to
// DesignSystem/ once a third feature needs them (see the report).

// MARK: - Screen chrome

extension View {
    /// Pushed Staff screens draw their own `NavHeader`; the system bar stays hidden.
    func staffPushedScreen() -> some View {
        self
            .toolbar(.hidden, for: .navigationBar)
            .navigationBarBackButtonHidden(true)
    }

    /// At least a 44 pt hit area (HIG) without changing the visual size.
    func staffTouchTarget() -> some View {
        frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

/// Header + scrolling content used by most pushed Staff screens.
struct StaffScreenHeader<Trailing: View>: View {
    let title: String
    var onBack: (() -> Void)?
    var centerTitle = true
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        NavHeader(title, centerTitle: centerTitle, onBack: onBack, trailing: trailing)
            .padding(.horizontal, 8)
            .padding(.top, 4)
    }
}

extension StaffScreenHeader where Trailing == EmptyView {
    init(title: String, onBack: (() -> Void)? = nil, centerTitle: Bool = true) {
        self.title = title
        self.onBack = onBack
        self.centerTitle = centerTitle
        self.trailing = { EmptyView() }
    }
}

// MARK: - Venue photo

/// A venue's profile photo, fetched with the signed-in session from
/// `GET /files/:id` (the server decides who may read it; a 404 for finished
/// work is by design). Without a photo, while loading, or after any failure it
/// shows the same-sized storefront placeholder, never a broken image.
struct StaffVenuePhoto: View {
    let fileId: String?
    let size: CGFloat
    var circle = false
    var radius: CGFloat = 12
    var placeholder: Color = ScheduleTokens.lavender
    var iconScale: CGFloat = 0.5
    let label: String

    @EnvironmentObject private var store: StaffStore
    @State private var image: UIImage?

    var body: some View {
        content
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: circle ? size / 2 : radius, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isImage)
            .task(id: fileId) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                placeholder
                Image(systemName: "storefront")
                    .font(.system(size: size * iconScale * 0.8))
                    .foregroundStyle(ScheduleTokens.ink.opacity(0.55))
            }
        }
    }

    private func load() async {
        guard let fileId, !fileId.isEmpty else {
            image = nil
            return
        }
        let bytes = await store.photos.data(for: fileId)
        guard !Task.isCancelled else { return }
        image = bytes.flatMap(UIImage.init(data:))
    }
}

// MARK: - Pills, badges and small pieces

/// Metadata pill on Job Details (pay rate, date, time).
struct StaffPill: View {
    let systemImage: String
    let label: String
    let style: ShiftVisualStyle

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .staffFont(15, .semibold)
                .accessibilityHidden(true)
            Text(label).scheduleType(ScheduleType.bodyStrong)
        }
        .foregroundStyle(ScheduleTokens.ink)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Capsule().fill(style.staffMetadataSurface))
        .overlay(Capsule().stroke(style.cardBorder, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// Green "Clocked In" / red "Clock-in overdue" status capsule.
struct StaffClockStatusBadge: View {
    let label: String
    var warning = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: warning ? "clock" : "checkmark")
                .staffFont(13, .bold)
                .accessibilityHidden(true)
            Text(label)
                .scheduleType(ScheduleType.badge.colored(warning ? StaffPalette.red : StaffPalette.green))
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(warning ? StaffPalette.red : StaffPalette.green)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Capsule().fill(warning ? StaffPalette.pink : StaffPalette.mintSurface))
        .accessibilityElement(children: .combine)
    }
}

/// Server `offerKind` tag (replacement / standby). Nothing is shown for a
/// standard offer or an older server.
struct StaffOfferKindTag: View {
    let offer: StaffOfferSummary

    var body: some View {
        if let tag = StaffShiftRules.offerKindTag(offer) {
            VStack(alignment: .leading, spacing: 2) {
                Text(tag.title)
                    .scheduleType(ScheduleType.badge.colored(StaffPalette.amberText))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(StaffPalette.amberSurface))
                if let detail = tag.detail {
                    Text(detail).scheduleType(ScheduleType.caption)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// White "NOTE" tab + note card, or the compact empty row (Job Details, clock).
struct StaffNoteCard: View {
    let notes: String?
    let style: ShiftVisualStyle

    var body: some View {
        VStack(spacing: 0) {
            Text("NOTE")
                .scheduleType(ScheduleType.overline)
                .frame(width: 168)
                .padding(.vertical, 10)
                .background(
                    StaffTopRoundedRectangle(radius: 16).fill(style.staffNoteChip)
                )
                .accessibilityAddTraits(.isHeader)
            Group {
                if let text = notes?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                    Text(text)
                        .scheduleType(ScheduleType.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(spacing: 10) {
                        Image(systemName: "text.alignleft")
                            .foregroundStyle(ScheduleTokens.muted)
                            .accessibilityHidden(true)
                        Text("No shift notes provided.").scheduleType(ScheduleType.secondary)
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(22)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).fill(Color.white))
            .scheduleCardShadow()
        }
    }
}

/// Top-only rounded rectangle (iOS 16 has no UnevenRoundedRectangle).
struct StaffTopRoundedRectangle: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        let r = min(radius, rect.height / 2, rect.width / 2)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// White grouped list container with hairline dividers (Profile, Payslips).
struct StaffGroup<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0, content: content)
            .background(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).stroke(ScheduleTokens.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous))
    }
}

/// Small initials stack for the clock card's "Your team" link.
struct StaffAvatarStack: View {
    let names: [String]

    var body: some View {
        HStack(spacing: -8) {
            ForEach(Array(names.prefix(4).enumerated()), id: \.offset) { index, name in
                InitialsAvatar(name: name, size: 28, background: StaffPalette.teamTones[index % StaffPalette.teamTones.count])
                    .overlay(Circle().stroke(Color.white, lineWidth: 2))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(names.count) \(names.count == 1 ? "person" : "people") on this shift")
    }
}

// MARK: - Countdown (Teams) — Flutter core/widgets/shift_countdown_panel.dart

/// HOURS / MINUTES / SECONDS panel. `seconds` is computed by the caller from
/// the server-anchored clock; nil renders "—" (no device-clock fallback).
struct StaffCountdownPanel: View {
    let heading: String
    let seconds: Int?
    let warning: Bool

    init(phase: StaffCountdownPhase, seconds: Int?) {
        heading = phase.heading
        self.seconds = phase == .ended ? nil : seconds
        warning = phase.warning
    }

    init(heading: String, seconds: Int?, warning: Bool = false) {
        self.heading = heading
        self.seconds = seconds
        self.warning = warning
    }

    var body: some View {
        let value = seconds.map { min(max($0, 0), 999_999_999) }
        let digits = warning ? StaffPalette.red : StaffPalette.green
        VStack(spacing: 6) {
            Text(heading)
                .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
                .multilineTextAlignment(.center)
            if let value {
                HStack(spacing: 0) {
                    cell(String(format: "%02d", value / 3600), "HOURS", digits)
                    cell(String(format: "%02d", (value / 60) % 60), "MINUTES", digits)
                    cell(String(format: "%02d", value % 60), "SECONDS", digits)
                }
            } else {
                Text("—").scheduleType(ScheduleType.timer.colored(digits))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(warning ? StaffPalette.pink : StaffPalette.mintSurface))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(value.map { "\(heading) \($0 / 3600) hours \(($0 / 60) % 60) minutes \($0 % 60) seconds" } ?? heading)
        .accessibilityIdentifier("staff.countdown")
    }

    private func cell(_ text: String, _ unit: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(text)
                .font(.system(size: 44, weight: .semibold).monospacedDigit())
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .foregroundStyle(color)
            Text(unit)
                .scheduleType(ScheduleType.timerLabel.colored(color.opacity(0.8)))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Navy Teams card: venue tile + name, "Today · HH:mm – HH:mm", countdown.
struct StaffNavySummaryCard<Countdown: View>: View {
    let venue: String
    let schedule: String?
    let photoFileId: String?
    let placeholder: Color
    @ViewBuilder var countdown: () -> Countdown

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                StaffVenuePhoto(fileId: photoFileId, size: 44, radius: 14, placeholder: placeholder, label: "\(venue) photo")
                VStack(alignment: .leading, spacing: 2) {
                    Text(venue)
                        .scheduleType(ScheduleType.venueTitle.colored(.white))
                        .lineLimit(2)
                    if let schedule {
                        Text(schedule).scheduleType(ScheduleType.secondary.colored(Color.white.opacity(0.75)))
                    }
                }
                Spacer(minLength: 0)
            }
            countdown()
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(ScheduleTokens.navy))
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Colours used only by Staff screens

enum StaffPalette {
    static let green = RGBA(argb: 0xFF087B5D).color
    static let mintSurface = RGBA(argb: 0xFFE5F5EE).color
    static let pink = RGBA(argb: 0xFFF8E8E8).color
    static let red = RGBA(argb: 0xFFAD2525).color
    static let amberSurface = RGBA(argb: 0xFFFFE9C7).color
    static let amberText = RGBA(argb: 0xFF8A4B00).color
    static let youSurface = RGBA(argb: 0xFFEFF8F3).color
    static let youAvatar = RGBA(argb: 0xFFD6EFE2).color
    static let neutralTone = RGBA(argb: 0xFFEDEEF2).color
    static let calendarBackground = RGBA(argb: 0xFFF7F8FA).color
    static let calendarGreen = RGBA(argb: 0xFF13836B).color
    static let calendarStatusSurface = RGBA(argb: 0xFFE0F2EC).color
    static let selectedDay = RGBA(argb: 0xFF0D0D0B).color
    static let docGreenSurface = RGBA(argb: 0xFFDDF3E8).color
    static let docGreen = RGBA(argb: 0xFF0B6B47).color
    static let profileBorder = RGBA(argb: 0xFFCDEBDD).color
    static let teamTones: [Color] = [ScheduleTokens.mint, ScheduleTokens.lavender, RGBA(argb: 0xFFEDEEF2).color]
}

extension ShiftVisualStyle {
    /// Job Details / clock surfaces derived from the identity colour (Flutter
    /// `ShiftVisualStyle` detail getters, approximated by blending).
    var staffMetadataSurface: Color { cardRGBA.lerp(to: SchedulePalette.surface, 0.35).color }
    var staffNoteChip: Color { strongBackgroundRGBA.lerp(to: SchedulePalette.surface, 0.35).color }
    var staffDetailGradientTop: Color { strongBackgroundRGBA.lerp(to: cardRGBA, 0.4).color }
    var staffIconTile: Color { badgeSurfaceRGBA.color }
}

// MARK: - Dynamic Type for fixed reference sizes

/// A reference point size (from the Flutter design) that still scales with
/// the person's Dynamic Type setting, like `scheduleType`.
struct StaffScaledFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight

    init(size: CGFloat, weight: Font.Weight, relativeTo: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: relativeTo)
        self.weight = weight
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight))
    }
}

extension View {
    func staffFont(_ size: CGFloat, _ weight: Font.Weight = .regular) -> some View {
        modifier(StaffScaledFont(size: size, weight: weight, relativeTo: size >= 20 ? .title3 : .body))
    }
}

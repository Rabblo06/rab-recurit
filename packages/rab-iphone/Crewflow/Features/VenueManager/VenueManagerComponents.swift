import PDFKit
import SwiftUI
import UIKit

// Feature-local UI pieces for the Venue Manager screens (used only here, so
// they live in this folder, not in DesignSystem/). Built on the core design
// tokens; every interactive element is at least 44 pt and labelled for
// VoiceOver; text uses the Dynamic Type scaled `scheduleType` roles.

// MARK: - Page scaffold

/// Pushed-screen scaffold: the design system's round-back header, the page
/// colour, the system navigation bar hidden (as on every Crewflow screen).
struct VMPage<Content: View, Trailing: View>: View {
    let title: String
    var showBack = true
    var background: Color = ScheduleTokens.homeBackground
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            NavHeader(title, showBack: showBack, centerTitle: false, backgroundColor: .white) { trailing() }
                .padding(.horizontal, 8)
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}

extension VMPage where Trailing == EmptyView {
    init(title: String, showBack: Bool = true, background: Color = ScheduleTokens.homeBackground, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.showBack = showBack
        self.background = background
        self.trailing = { EmptyView() }
        self.content = content
    }
}

/// A screen that could not load: persistent card with Retry (never an empty
/// list on failure).
struct VMLoadFailure: View {
    let message: String
    var title = "Unable to load"
    let retry: () -> Void

    var body: some View {
        MessageCard(title: title, message: message, kind: .error, actionTitle: "Retry", action: retry)
            .padding(ScheduleTokens.homeInset)
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
    }
}

/// Spinner with a VoiceOver label for an in-page section.
struct VMInlineLoading: View {
    var label = "Loading"
    var body: some View {
        ProgressView()
            .tint(ScheduleTokens.accent)
            .frame(maxWidth: .infinity, minHeight: 80)
            .accessibilityLabel(label)
    }
}

// MARK: - Destination helper (iOS 16 programmatic push with reload-on-return)

private struct VMDestinationModifier<Item, Destination: View>: ViewModifier {
    @Binding var item: Item?
    let onReturn: (() -> Void)?
    let destination: (Item) -> Destination
    @State private var shown: Item?

    func body(content: Content) -> some View {
        content
            .navigationDestination(isPresented: Binding(
                get: { item != nil },
                set: { presented in
                    if !presented, item != nil {
                        item = nil
                        onReturn?()
                    }
                }
            )) {
                if let value = item ?? shown { destination(value) }
            }
            .onChange(of: item != nil) { presented in
                if presented { shown = item }
            }
    }
}

extension View {
    /// Pushes `destination` while `item` is non-nil; `onReturn` runs when
    /// the person comes back (screens reload the server state then).
    func vmDestination<Item, Destination: View>(
        _ item: Binding<Item?>,
        onReturn: (() -> Void)? = nil,
        @ViewBuilder destination: @escaping (Item) -> Destination
    ) -> some View {
        modifier(VMDestinationModifier(item: item, onReturn: onReturn, destination: destination))
    }
}

/// Identifiable wrapper for sheet(item:) payloads.
struct VMSheetItem<Value>: Identifiable {
    let id = UUID()
    let value: Value
}

// MARK: - Pills, rows, headers

struct VMPill: View {
    let label: String
    let background: Color
    let foreground: Color

    init(_ label: String, background: Color, foreground: Color) {
        self.label = label
        self.background = background
        self.foreground = foreground
    }

    init(tone: VMTone) {
        self.init(tone.label, background: tone.pill.color, foreground: tone.pillText.color)
    }

    static func booking(_ member: ConfirmedStaffMember) -> VMPill {
        let tone = member.bookingTone
        return VMPill(member.bookingLabel, background: tone.background, foreground: tone.foreground)
    }

    var body: some View {
        Text(label)
            .scheduleType(ScheduleType.badge.colored(foreground))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(background))
    }
}

/// Light initials circle (Users, Sent shift, Event Details rows).
struct VMInitialsCircle: View {
    let name: String
    var size: CGFloat = 40
    var fill: Color = VMColor.avatarFill

    var body: some View {
        Text(InitialsAvatar.initials(for: name))
            .font(.system(size: size * 0.33, weight: .bold))
            .foregroundStyle(ScheduleTokens.ink)
            .frame(width: size, height: size)
            .background(Circle().fill(fill))
            .accessibilityHidden(true)
    }
}

/// White staff row: optional leading control, initials, name (+ suffix
/// icons), role and a trailing badge that moves under the role when the row
/// is too narrow (small phone / large text).
struct VMStaffRow<Leading: View, Suffix: View, Trailing: View>: View {
    let name: String
    let role: String?
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var suffix: () -> Suffix
    @ViewBuilder var trailing: () -> Trailing

    private var text: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(name).scheduleType(ScheduleType.bodyStrong).lineLimit(2)
                suffix()
            }
            if let role { Text(role).scheduleType(ScheduleType.caption).lineLimit(1) }
        }
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                leading()
                VMInitialsCircle(name: name)
                text.frame(maxWidth: .infinity, alignment: .leading)
                trailing()
            }
            HStack(alignment: .top, spacing: 12) {
                leading()
                VMInitialsCircle(name: name)
                VStack(alignment: .leading, spacing: 6) {
                    text
                    trailing()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .frame(minHeight: 44)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(VMColor.rowBorder, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

extension VMStaffRow where Leading == EmptyView, Suffix == EmptyView {
    init(name: String, role: String?, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.name = name
        self.role = role
        self.leading = { EmptyView() }
        self.suffix = { EmptyView() }
        self.trailing = trailing
    }
}

/// Section title with an optional right-aligned count.
struct VMSectionHeader<Count: View>: View {
    let title: String
    @ViewBuilder var count: () -> Count

    var body: some View {
        HStack {
            Text(title)
                .scheduleType(ScheduleType.cardTitle)
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity, alignment: .leading)
            count()
        }
        .padding(.vertical, 6)
    }
}

extension VMSectionHeader where Count == EmptyView {
    init(_ title: String) {
        self.title = title
        self.count = { EmptyView() }
    }
}

/// Round icon button with a 44 pt target.
struct VMCircleButton: View {
    let systemImage: String
    let label: String
    var diameter: CGFloat = 44
    var background: Color = .white
    var foreground: Color = ScheduleTokens.ink
    var showsDot = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: systemImage)
                    .font(.system(size: diameter * 0.4, weight: .semibold))
                    .foregroundStyle(foreground)
                    .frame(width: diameter, height: diameter)
                    .background(Circle().fill(background))
                    .overlay(Circle().stroke(VMColor.rowBorder, lineWidth: background == .white ? 1 : 0))
                if showsDot {
                    Circle().fill(VMColor.navy).frame(width: 7, height: 7).offset(x: -10, y: 10)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(label)
    }
}

/// White capsule text button ("Edit", "Done").
struct VMPillButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .scheduleType(ScheduleType.bodyStrong.colored(VMColor.navy))
                .padding(.horizontal, 16)
                .frame(minWidth: 64, minHeight: 44)
                .background(Capsule().fill(Color.white))
                .overlay(Capsule().stroke(VMColor.rowBorder, lineWidth: 1))
        }
        .buttonStyle(PressableButtonStyle())
    }
}

/// Filter chip (All / Favourite / Emergency, Sent Shifts views).
struct VMChip: View {
    let label: String
    let selected: Bool
    var removable = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(label).scheduleType(ScheduleType.badge.colored(selected ? .white : VMColor.navy))
                if removable {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(VMColor.navy)
                        .accessibilityLabel("Clear filter")
                }
            }
            .padding(.horizontal, 13)
            .frame(minHeight: 44)
            .background(Capsule().fill(selected ? Color.black : Color.white).padding(.vertical, 6))
            .overlay(Capsule().stroke(selected ? Color.black : VMColor.rowBorder, lineWidth: 1).padding(.vertical, 6))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Report visual language (Flutter report_ui.dart)

struct ReportBadge: View {
    let state: ReportBadgeState
    var systemImage: String?

    init(_ state: ReportBadgeState, systemImage: String? = nil) {
        self.state = state
        self.systemImage = systemImage
    }

    init(_ label: String, tone: ReportBadgeTone, systemImage: String? = nil) {
        self.init(ReportBadgeState(label: label, tone: tone), systemImage: systemImage)
    }

    var body: some View {
        let colors = state.tone.colors
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage).font(.system(size: 12, weight: .bold)).accessibilityHidden(true)
            }
            Text(state.label).scheduleType(ScheduleType.badge.colored(colors.foreground))
        }
        .foregroundStyle(colors.foreground)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(Capsule().fill(colors.background))
    }
}

/// Amber notice: bold title + supporting line.
struct ReportNotice: View {
    let title: String
    var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).scheduleType(ScheduleType.bodyStrong.colored(VMColor.noticeText))
            if let message { Text(message).scheduleType(ScheduleType.caption.colored(VMColor.noticeText)) }
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(VMColor.noticeSurface))
        .accessibilityElement(children: .combine)
    }
}

struct ReportCard<Content: View>: View {
    var padding = EdgeInsets(top: 16, leading: 18, bottom: 16, trailing: 18)
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white))
    }
}

/// "Label    value" row.
struct ReportField: View {
    let label: String
    let value: String
    var valueColor: Color?

    init(_ label: String, _ value: String, valueColor: Color? = nil) {
        self.label = label
        self.value = value
        self.valueColor = valueColor
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(label).scheduleType(ScheduleType.caption.colored(VMColor.reportMuted)).frame(width: 104, alignment: .leading)
                valueText.frame(maxWidth: .infinity, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label).scheduleType(ScheduleType.caption.colored(VMColor.reportMuted))
                valueText
            }
        }
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
    }

    private var valueText: some View {
        Text(value).scheduleType((valueColor == nil ? ScheduleType.body : ScheduleType.bodyStrong).colored(valueColor ?? VMColor.reportInk))
    }
}

/// Full-width navy pill (primary) or white pill (secondary); disabled
/// primary turns light grey.
struct ReportButton: View {
    let title: String
    var secondary = false
    var busy = false
    var enabled = true
    var systemImage: String?
    let action: () -> Void

    private var active: Bool { enabled && !busy }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy {
                    ProgressView().tint(secondary ? VMColor.reportInk : .white)
                } else {
                    Text(title).scheduleType(ScheduleType.button).multilineTextAlignment(.center)
                    if let systemImage { Image(systemName: systemImage).accessibilityHidden(true) }
                }
            }
            .foregroundStyle(secondary ? VMColor.reportInk : (active || busy ? Color.white : VMColor.disabledInk))
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 12)
            .background(Capsule().fill(secondary ? Color.white : (active || busy ? VMColor.reportNavy : VMColor.disabledFill)))
            .overlay(Capsule().stroke(secondary ? VMColor.divider : .clear, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(!active)
        .accessibilityLabel(title)
        .accessibilityValue(busy ? "Please wait" : "")
    }
}

/// Two/three-way segmented control: the selected segment is a navy pill.
struct ReportSegments<Value: Hashable>: View {
    let values: [Value]
    let label: (Value) -> String
    @Binding var selection: Value
    var enabled = true

    var body: some View {
        HStack(spacing: 0) {
            ForEach(values, id: \.self) { value in
                let selected = value == selection
                Button { selection = value } label: {
                    Text(label(value))
                        .scheduleType((selected ? ScheduleType.bodyStrong : ScheduleType.body).colored(selected ? .white : VMColor.reportMuted))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(selected ? VMColor.reportNavy : .clear))
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white))
    }
}

/// Red error panel (sheets).
struct VMErrorPanel: View {
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle").font(.system(size: 20)).foregroundStyle(ScheduleTokens.errorText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).scheduleType(ScheduleType.bodyStrong.colored(ScheduleTokens.errorText))
                Text(message).scheduleType(ScheduleType.secondary.colored(ScheduleTokens.errorText))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(VMColor.errorPanel))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(VMColor.errorPanelBorder, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error. \(title). \(message)")
    }
}

/// Field caption + content + inline error.
struct VMField<Content: View>: View {
    let label: String
    var error: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).scheduleType(ScheduleType.caption)
            content()
            if let error {
                Text(error).scheduleType(ScheduleType.caption.colored(ScheduleTokens.errorText))
            }
        }
    }
}

/// White bordered box used around inputs and pickers.
struct VMInputBox: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(VMColor.divider, lineWidth: 1))
    }
}

extension View {
    func vmInputBox() -> some View { modifier(VMInputBox()) }
}

/// A date-time that stays EMPTY until the manager confirms one: the picker
/// only STARTS at `anchor` (a dial position, never a stored value).
struct VMOptionalDateTimeField: View {
    let label: String
    @Binding var value: Date?
    let anchor: Date
    let range: ClosedRange<Date>
    var components: DatePickerComponents = [.date, .hourAndMinute]
    var placeholder = "Select date and time"
    var enabled = true
    var error: String?

    @State private var editing = false
    @State private var draft = Date()

    var body: some View {
        VMField(label: label, error: error) {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    draft = clamp(value ?? anchor)
                    editing.toggle()
                } label: {
                    HStack {
                        Text(value.map(display) ?? placeholder)
                            .scheduleType(value == nil ? ScheduleType.secondary : ScheduleType.body)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "clock").foregroundStyle(VMColor.reportMuted).accessibilityHidden(true)
                    }
                    .vmInputBox()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .accessibilityLabel(label)
                .accessibilityValue(value.map(display) ?? "Not set")
                .accessibilityHint("Opens a picker")

                if editing {
                    Group {
                        if components.contains(.date) {
                            DatePicker(label, selection: $draft, in: range, displayedComponents: components)
                                .datePickerStyle(.graphical)
                        } else {
                            DatePicker(label, selection: $draft, in: range, displayedComponents: components)
                                .datePickerStyle(.wheel)
                        }
                    }
                    .labelsHidden()
                    .environment(\.timeZone, CrewflowDateFormat.displayTimeZone)
                    .environment(\.locale, CrewflowDateFormat.locale)
                    HStack(spacing: 12) {
                        ReportButton(title: "Cancel", secondary: true) { editing = false }
                        ReportButton(title: "Use this time") {
                            value = draft
                            editing = false
                        }
                    }
                }
            }
        }
    }

    private func clamp(_ date: Date) -> Date { min(max(date, range.lowerBound), range.upperBound) }

    private func display(_ date: Date) -> String {
        components.contains(.date) ? VMDate.long(date) : VMDate.hm(date)
    }
}

// MARK: - Venue photo (authenticated GET /files/:id)

/// Venue photo or a neutral placeholder. Any failure (404 for a venue
/// without live work is by design) shows the placeholder, never an error.
/// Bytes live only in this view's state (nothing cached across identities).
struct VMVenuePhoto: View {
    let fileId: String?
    var size: CGFloat = 44
    var circle = false
    var placeholder: Color = ScheduleTokens.lavender
    var label: String

    @EnvironmentObject private var environment: AppEnvironment
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                placeholder
                Image(systemName: "building.2").font(.system(size: size * 0.42)).foregroundStyle(ScheduleTokens.ink)
            }
        }
        .frame(width: size, height: size)
        .clipShape(circle ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)))
        .accessibilityElement()
        .accessibilityLabel(label)
        .task(id: fileId) { await loadImage() }
    }

    @MainActor
    private func loadImage() async {
        image = nil
        guard let fileId else { return }
        let repository = VenueManagerRepository(api: environment.api)
        if let data = try? await repository.imageBytes(fileId), let loaded = UIImage(data: data) {
            image = loaded
        }
    }
}

// MARK: - PDF + share

/// PDFKit viewer: pinch to zoom, scroll pages. Bytes are already verified
/// as a PDF (`DownloadedFile.isPDF`).
struct VMPDFView: UIViewRepresentable {
    let data: Data

    final class Coordinator {
        var shown: Data?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .white
        view.document = PDFDocument(data: data)
        context.coordinator.shown = data
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        guard context.coordinator.shown != data else { return }
        view.document = PDFDocument(data: data)
        context.coordinator.shown = data
    }
}

/// The system share sheet for an explicit "Download PDF" (the only way a
/// document leaves the app).
struct VMShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    let completion: (Bool) -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, completed, _, _ in completion(completed) }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Countdown (Teams)

/// HOURS / MINUTES / SECONDS panel. `seconds` comes from server-anchored
/// time only; nil shows "—".
struct VMCountdownPanel: View {
    let heading: String
    let seconds: Int?
    var warning = false

    var body: some View {
        let digits = warning ? VMColor.countdownRed : VMColor.countdownGreen
        VStack(spacing: 6) {
            Text(heading).scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
            if let value = seconds.map({ min(max($0, 0), 999_999_999) }) {
                HStack {
                    cell(String(format: "%02d", value / 3600), "HOURS", digits)
                    cell(String(format: "%02d", value / 60 % 60), "MINUTES", digits)
                    cell(String(format: "%02d", value % 60), "SECONDS", digits)
                }
            } else {
                Text("—").scheduleType(ScheduleType.timer.colored(digits))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(warning ? VMColor.countdownPink : VMColor.countdownMint))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        guard let s = seconds.map({ max($0, 0) }) else { return heading }
        return "\(heading) \(s / 3600) hours \(s / 60 % 60) minutes \(s % 60) seconds"
    }

    private func cell(_ text: String, _ unit: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(text).font(.system(size: 44, weight: .semibold).monospacedDigit()).foregroundStyle(color)
                .minimumScaleFactor(0.5).lineLimit(1)
            Text(unit).scheduleType(ScheduleType.timerLabel.colored(color.opacity(0.8))).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Sheet chrome

/// Content padding + scroll for bottom sheets (keyboard-safe).
struct VMSheet<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.horizontal, ScheduleTokens.sheetInset)
                .padding(.top, 24)
                .padding(.bottom, 16)
                .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.white.ignoresSafeArea())
        .presentationDragIndicator(.visible)
    }
}

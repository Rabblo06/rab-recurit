import SwiftUI
import UIKit

/// Which toast kinds this app shows. The mobile product rule: NO success
/// toasts — a successful action shows its result in place; only failures
/// get a temporary toast.
public enum ToastPolicy: Sendable {
    case all
    case errorsOnly

    public func allows(_ kind: FeedbackKind) -> Bool {
        switch self {
        case .all: return true
        case .errorsOnly: return kind == .error
        }
    }
}

public struct Toast: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let title: String?
    public let message: String
    public let kind: FeedbackKind
    public let duration: TimeInterval
}

/// Temporary feedback for an action's RESULT ("The PDF could not be
/// saved."). Persistent states — a screen that cannot load, inline field
/// errors, confirmations — use `MessageCard` / sheets instead.
///
/// Port of Flutter `ScheduleToast`: at most 3 visible, FIFO queue, an
/// identical message+kind already showing or queued is ignored, error and
/// warning stay 7 s, others 4.5 s, press-and-hold pauses, ✕ dismisses, a
/// light semantic fill drains with the remaining time, every toast is
/// announced to VoiceOver. Drawn in a pass-through window above sheets and
/// never over bottom primary actions (top-aligned).
@MainActor
public final class ToastCenter: ObservableObject {
    public static let maxVisible = 3
    public static let shortDuration: TimeInterval = 4.5
    public static let longDuration: TimeInterval = 7

    public static func duration(for kind: FeedbackKind) -> TimeInterval {
        kind == .warning || kind == .error ? longDuration : shortDuration
    }

    @Published public private(set) var visible: [Toast] = []
    public private(set) var queued: [Toast] = []
    public let policy: ToastPolicy

    private struct Clock {
        var elapsed: TimeInterval = 0
        var resumedAt: Date?
        var task: Task<Void, Never>?
    }

    private var clocks: [UUID: Clock] = [:]
    private let announcer: ((String) -> Void)?
    private let now: () -> Date

    /// - Parameter announcer: test seam; nil posts a VoiceOver announcement.
    public init(policy: ToastPolicy = .errorsOnly, announcer: ((String) -> Void)? = nil, now: @escaping () -> Date = { Date() }) {
        self.policy = policy
        self.announcer = announcer
        self.now = now
    }

    /// Returns false when nothing was shown (empty text, kind blocked by the
    /// policy, or a duplicate of a toast already visible/queued).
    @discardableResult
    public func show(_ message: String, kind: FeedbackKind = .info, title: String? = nil, duration: TimeInterval? = nil) -> Bool {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, policy.allows(kind) else { return false }
        let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTitle = (trimmedTitle?.isEmpty ?? true) ? nil : trimmedTitle
        let duplicate = (visible + queued).contains { $0.message == text && $0.title == cleanTitle && $0.kind == kind }
        guard !duplicate else { return false }
        let toast = Toast(id: UUID(), title: cleanTitle, message: text, kind: kind, duration: duration ?? Self.duration(for: kind))
        if visible.count < Self.maxVisible {
            present(toast)
        } else {
            queued.append(toast)
        }
        return true
    }

    /// Error toast for a caught failure, through the single API normaliser.
    /// Cancellations and responses dropped after an identity change are
    /// never shown (they belong to a screen or person no longer present).
    @discardableResult
    public func showError(_ error: Error, fallback: String? = nil) -> Bool {
        if let apiError = error as? APIError, apiError == .cancelled || apiError == .sessionChanged {
            return false
        }
        if error is CancellationError { return false }
        return show(userMessage(for: error, fallback: fallback), kind: .error)
    }

    public func dismiss(_ id: UUID) {
        clocks[id]?.task?.cancel()
        clocks[id] = nil
        guard let index = visible.firstIndex(where: { $0.id == id }) else {
            queued.removeAll { $0.id == id }
            return
        }
        visible.remove(at: index)
        if !queued.isEmpty {
            present(queued.removeFirst())
        }
    }

    /// Removes every toast, visible and queued (sign-out, account switch).
    public func dismissAll() {
        clocks.values.forEach { $0.task?.cancel() }
        clocks.removeAll()
        visible.removeAll()
        queued.removeAll()
    }

    public func pause(_ id: UUID) {
        guard var clock = clocks[id], let resumedAt = clock.resumedAt else { return }
        clock.elapsed += now().timeIntervalSince(resumedAt)
        clock.resumedAt = nil
        clock.task?.cancel()
        clock.task = nil
        clocks[id] = clock
    }

    public func resume(_ id: UUID) {
        guard var clock = clocks[id], clock.resumedAt == nil,
              let toast = visible.first(where: { $0.id == id })
        else { return }
        clock.resumedAt = now()
        let remaining = max(0, toast.duration - clock.elapsed)
        clock.task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.dismiss(id)
        }
        clocks[id] = clock
    }

    /// Share of display time left (1 → 0), for the draining fill.
    public func remainingFraction(for id: UUID, at date: Date) -> Double {
        guard let clock = clocks[id], let toast = visible.first(where: { $0.id == id }), toast.duration > 0 else { return 0 }
        var elapsed = clock.elapsed
        if let resumedAt = clock.resumedAt { elapsed += date.timeIntervalSince(resumedAt) }
        return min(max(1 - elapsed / toast.duration, 0), 1)
    }

    private func present(_ toast: Toast) {
        visible.append(toast)
        clocks[toast.id] = Clock()
        resume(toast.id)
        let spoken = [ToastCard.accessibilityName(for: toast.kind), toast.title, toast.message]
            .compactMap { $0 }
            .joined(separator: ". ")
        if let announcer {
            announcer(spoken)
        } else {
            UIAccessibility.post(notification: .announcement, argument: spoken)
        }
    }
}

/// The toast surface: white card, thin border, soft shadow, left semantic
/// icon, a very light semantic fill that drains with the remaining time,
/// and a 48 pt ✕. Text stays neutral; icon and fill carry the meaning.
public struct ToastCard: View {
    private let toast: Toast
    private let remaining: Double
    private let onDismiss: () -> Void

    public init(toast: Toast, remaining: Double = 1, onDismiss: @escaping () -> Void) {
        self.toast = toast
        self.remaining = remaining
        self.onDismiss = onDismiss
    }

    static func accessibilityName(for kind: FeedbackKind) -> String {
        switch kind {
        case .error: return "Error"
        case .success: return "Success"
        case .warning: return "Warning"
        case .info: return "Information"
        }
    }

    private var style: (fill: Color, icon: String, iconColor: Color) {
        switch toast.kind {
        case .error: return (SchedulePalette.toastErrorFill.color, "exclamationmark.circle", SchedulePalette.errorText.color)
        case .success: return (SchedulePalette.toastSuccessFill.color, "checkmark.circle", SchedulePalette.successIcon.color)
        case .warning: return (SchedulePalette.toastWarningFill.color, "exclamationmark.triangle", SchedulePalette.warningIcon.color)
        case .info: return (SchedulePalette.toastInfoFill.color, "info.circle", SchedulePalette.infoIcon.color)
        }
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: ScheduleTokens.toastRadius, style: .continuous)
        HStack(spacing: 10) {
            Image(systemName: style.icon)
                .font(.system(size: 20))
                .foregroundStyle(style.iconColor)
                .accessibilityLabel(Self.accessibilityName(for: toast.kind))
            VStack(alignment: .leading, spacing: 2) {
                if let title = toast.title {
                    Text(title).scheduleType(ScheduleType.bodyStrong)
                }
                Text(toast.message)
                    .scheduleType(toast.title == nil ? ScheduleType.bodyStrong : ScheduleType.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ScheduleTokens.muted)
                    .frame(width: ScheduleTokens.touchTarget, height: ScheduleTokens.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("toast.dismiss")
        }
        .padding(.leading, 14)
        .background(alignment: .leading) {
            GeometryReader { proxy in
                Rectangle()
                    .fill(style.fill)
                    .frame(width: proxy.size.width * min(max(remaining, 0), 1))
            }
        }
        .background(Color.white)
        .clipShape(shape)
        .overlay(shape.stroke(SchedulePalette.toastBorder.color, lineWidth: 1))
        .shadow(color: RGBA(argb: 0x1A101828).color, radius: 8, x: 0, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("toast.\(toast.kind.rawValue)")
    }
}

// MARK: - Hosting (pass-through window above sheets)

@MainActor
final class ToastHitRegion {
    var rect: CGRect = .zero
}

private struct ToastFrameKey: PreferenceKey {
    static let defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = value.union(nextValue())
    }
}

struct ToastStack: View {
    @ObservedObject var center: ToastCenter
    let region: ToastHitRegion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(center: ToastCenter, region: ToastHitRegion) {
        self.center = center
        self.region = region
    }

    var body: some View {
        VStack(spacing: 8) {
            ForEach(center.visible) { toast in
                ToastRow(toast: toast, center: center, reduceMotion: reduceMotion)
                    .transition(reduceMotion ? .identity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .frame(maxWidth: ScheduleTokens.contentMaxWidth)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: ToastFrameKey.self, value: center.visible.isEmpty ? .zero : proxy.frame(in: .global))
            }
        )
        .onPreferenceChange(ToastFrameKey.self) { rect in
            region.rect = rect
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: center.visible)
    }
}

private struct ToastRow: View {
    let toast: Toast
    @ObservedObject var center: ToastCenter
    let reduceMotion: Bool
    @State private var pressing = false

    init(toast: Toast, center: ToastCenter, reduceMotion: Bool) {
        self.toast = toast
        self.center = center
        self.reduceMotion = reduceMotion
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion || pressing)) { context in
            ToastCard(
                toast: toast,
                // Reduced motion: no slide/fade and the fill holds still.
                remaining: reduceMotion ? 1 : center.remainingFraction(for: toast.id, at: context.date),
                onDismiss: { center.dismiss(toast.id) }
            )
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !pressing else { return }
                    pressing = true
                    center.pause(toast.id)
                }
                .onEnded { _ in
                    pressing = false
                    center.resume(toast.id)
                }
        )
    }
}

/// Touches outside the visible toasts fall through to the app window.
final class ToastPassthroughWindow: UIWindow {
    var region: ToastHitRegion?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let region, region.rect.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// Owns the toast window for one scene.
@MainActor
public final class ToastPresenter {
    private var window: ToastPassthroughWindow?
    private let center: ToastCenter

    public init(center: ToastCenter) {
        self.center = center
    }

    func install(in scene: UIWindowScene) {
        guard window == nil else { return }
        let region = ToastHitRegion()
        let host = UIHostingController(rootView: ToastStack(center: center, region: region))
        host.view.backgroundColor = .clear
        let window = ToastPassthroughWindow(windowScene: scene)
        window.region = region
        window.rootViewController = host
        window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 1)
        window.backgroundColor = .clear
        window.overrideUserInterfaceStyle = .light
        window.isHidden = false
        self.window = window
    }
}

/// Finds the hosting `UIWindowScene` once the SwiftUI root is on screen.
struct WindowSceneReader: UIViewRepresentable {
    let onScene: @MainActor (UIWindowScene) -> Void

    func makeUIView(context: Context) -> SceneProbeView {
        let view = SceneProbeView()
        view.onScene = onScene
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: SceneProbeView, context: Context) {}

    final class SceneProbeView: UIView {
        var onScene: (@MainActor (UIWindowScene) -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let scene = window?.windowScene { onScene?(scene) }
        }
    }
}

public extension View {
    /// Install once on the root view: toasts from `center` render above
    /// every screen and sheet of this scene.
    @MainActor
    func toastHost(_ presenter: ToastPresenter) -> some View {
        background(WindowSceneReader { scene in presenter.install(in: scene) }.frame(width: 0, height: 0))
    }
}

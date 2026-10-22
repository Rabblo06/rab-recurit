import SwiftUI

/// Full-area loading state with a VoiceOver label.
public struct LoadingView: View {
    private let label: String

    public init(_ label: String = "Loading") {
        self.label = label
    }

    public var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .progressViewStyle(.circular)
                .tint(ScheduleTokens.accent)
                .controlSize(.large)
            Text(label).scheduleType(ScheduleType.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Empty or not-available state: icon, title, message, optional action.
public struct EmptyStateView: View {
    private let systemImage: String
    private let title: String
    private let message: String?
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(systemImage: String, title: String, message: String? = nil, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        VStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(ScheduleTokens.muted)
                .frame(width: 72, height: 72)
                .background(Circle().fill(Color.white))
                .accessibilityHidden(true)
            Text(title)
                .scheduleType(ScheduleType.cardTitle)
                .multilineTextAlignment(.center)
            if let message {
                Text(message)
                    .scheduleType(ScheduleType.secondary)
                    .multilineTextAlignment(.center)
            }
            if let actionTitle, let action {
                PrimaryButton(actionTitle, variant: .light, action: action)
                    .frame(maxWidth: 280)
                    .padding(.top, 6)
            }
        }
        .padding(.horizontal, ScheduleTokens.homeInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
    }
}

/// A real screen type for a tab whose feature is not in this build. Shows an
/// honest state and NO sample data.
public struct FeaturePlaceholderView: View {
    private let title: String
    private let systemImage: String
    private let detail: String?

    public init(title: String, systemImage: String, detail: String? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.detail = detail
    }

    public static let notImplementedMessage = "Not yet implemented in this build"

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title)
                    .scheduleType(ScheduleType.pageTitle)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
            }
            .padding(.horizontal, ScheduleTokens.homeInset)
            .padding(.top, 12)
            EmptyStateView(
                systemImage: systemImage,
                title: Self.notImplementedMessage,
                message: detail
            )
            .accessibilityIdentifier("placeholder.\(title.lowercased())")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
    }
}

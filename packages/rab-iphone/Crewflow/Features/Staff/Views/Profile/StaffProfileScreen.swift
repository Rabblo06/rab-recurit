import SwiftUI

/// Staff Profile (Flutter `ProfileScreen`): identity card with initials
/// (Flutter shows no photo and has no avatar upload; not ported), WORK →
/// Payslips (staff only), ACCOUNT → Inbox (unread badge) and Security, and
/// Log out. Only rows with a real destination are listed.
struct StaffProfileScreen: View {
    @EnvironmentObject private var session: SessionCoordinator
    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var navigator: StaffNavigator
    @State private var signingOut = false

    var body: some View {
        let user = session.user
        let fullName = user?.fullName.trimmingCharacters(in: .whitespaces) ?? ""
        let initials = StaffFormat.initials(first: user?.firstName ?? "", last: user?.lastName ?? "")
        VStack(spacing: 0) {
            StaffScreenHeader(title: "Profile", onBack: { navigator.select(.home) })
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    StaffGroup {
                        HStack(spacing: 16) {
                            Text(initials.isEmpty ? "·" : initials)
                                .staffFont(22, .bold)
                                .foregroundStyle(StaffPalette.docGreen)
                                .frame(width: 64, height: 64)
                                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(ScheduleTokens.mint))
                                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(StaffPalette.profileBorder, lineWidth: 1))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(fullName.isEmpty ? "Loading…" : fullName)
                                    .scheduleType(ScheduleType.cardTitle)
                                    .lineLimit(2)
                                Text(user?.email ?? "").scheduleType(ScheduleType.secondary).lineLimit(1)
                                if user?.presentation == .staff {
                                    Text("Staff account").scheduleType(ScheduleType.caption.colored(ScheduleTokens.successText))
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(18)
                        .accessibilityElement(children: .combine)
                    }
                    // Payslips belong to staff only (the payslip API is staff-app scoped).
                    if user?.presentation == .staff {
                        sectionLabel("WORK")
                        StaffGroup {
                            row(icon: "doc.text", label: "Payslips", identifier: "staff.profile.payslips") { navigator.push(.payslips) }
                        }
                    }
                    sectionLabel("ACCOUNT")
                    StaffGroup {
                        row(icon: "envelope", label: "Inbox", badge: store.unreadCount, identifier: "staff.profile.inbox") { navigator.push(.inbox) }
                        Divider().overlay(ScheduleTokens.border).padding(.leading, 56)
                        row(icon: "shield", label: "Security", identifier: "staff.profile.security") { navigator.push(.security) }
                    }
                    Button {
                        guard !signingOut else { return }
                        signingOut = true
                        Task { @MainActor in await session.logout() }
                    } label: {
                        Text(signingOut ? "Signing out…" : "Log out")
                            .scheduleType(ScheduleType.button.colored(ScheduleTokens.errorText))
                            .frame(maxWidth: .infinity, minHeight: ScheduleTokens.actionHeight)
                            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ScheduleTokens.dangerSoft))
                    }
                    .buttonStyle(PressableButtonStyle())
                    .disabled(signingOut)
                    .padding(.top, 24)
                    .accessibilityIdentifier("profile.signOut")
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .accessibilityIdentifier("staff.profile")
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .scheduleType(ScheduleType.overline)
            .padding(EdgeInsets(top: 24, leading: 4, bottom: 10, trailing: 4))
            .accessibilityAddTraits(.isHeader)
    }

    private func row(icon: String, label: String, badge: Int = 0, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Image(systemName: icon).staffFont(19).foregroundStyle(ScheduleTokens.ink).frame(width: 22).accessibilityHidden(true)
                Text(label).scheduleType(ScheduleType.body)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .scheduleType(ScheduleType.badge.colored(ScheduleTokens.errorText))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(ScheduleTokens.dangerSoft))
                        .accessibilityLabel("\(badge) unread")
                }
                Image(systemName: "chevron.right").foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

/// Profile > Security: the biometric toggle, through `SessionCoordinator`
/// (which refuses to enable it once the last password sign-in is > 90 days old).
struct StaffSecurityScreen: View {
    @EnvironmentObject private var session: SessionCoordinator
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        VStack(spacing: 0) {
            StaffScreenHeader(title: "Security")
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if session.biometricCapability.isAvailable {
                        StaffGroup {
                            Toggle(isOn: binding) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(session.biometricCapability.label).scheduleType(ScheduleType.body)
                                    Text(session.biometricEnabledForCurrentUser ? "Enabled" : "Off").scheduleType(ScheduleType.caption)
                                }
                            }
                            .tint(ScheduleTokens.accent)
                            .disabled(busy)
                            .padding(16)
                            .accessibilityIdentifier("staff.security.biometric")
                        }
                        if let message {
                            Text(message).scheduleType(ScheduleType.caption.colored(ScheduleTokens.errorText))
                        }
                    } else {
                        MessageCard(title: "Biometric authentication is not available on this device.")
                    }
                }
                .padding(20)
            }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .staffPushedScreen()
    }

    private var binding: Binding<Bool> {
        Binding(
            get: { session.biometricEnabledForCurrentUser },
            set: { enable in
                message = nil
                if enable {
                    busy = true
                    Task { @MainActor in
                        let ok = await session.enableBiometric()
                        busy = false
                        if !ok {
                            message = "\(session.biometricCapability.label) was not turned on. If you last signed in with your password more than 90 days ago, sign out and sign in again first."
                        }
                    }
                } else {
                    session.disableBiometric()
                }
            }
        )
    }
}

/// Inbox (Flutter `NotificationsScreen`): the 50 newest, mark one read on
/// tap, "Mark all read". A load failure shows Retry, never "No notifications".
@MainActor
final class StaffInboxModel: ObservableObject {
    @Published private(set) var items: [StaffNotification] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?

    private let repository: StaffRepository
    private let fence: StaffSessionFence
    private let onUnread: @MainActor (Int) -> Void

    init(repository: StaffRepository, fence: StaffSessionFence, onUnread: @escaping @MainActor (Int) -> Void) {
        self.repository = repository
        self.fence = fence
        self.onUnread = onUnread
    }

    var unread: Int { items.filter(\.isUnread).count }

    func load(silent: Bool = false) async {
        if !silent { loading = true }
        let epoch = fence.epoch
        do {
            let rows = try await repository.notifications()
            guard fence.isCurrent(epoch) else { return }
            items = rows
            error = nil
            onUnread(unread)
        } catch {
            guard fence.isCurrent(epoch), !StaffStore.ignorable(error) else { return }
            self.error = userMessage(for: error, fallback: "Your notifications could not be loaded.")
        }
        loading = false
    }

    /// Best effort and silent on failure (Flutter); the list is reloaded.
    func markRead(_ item: StaffNotification) async {
        guard item.isUnread else { return }
        try? await repository.markRead(notificationId: item.id)
        await load(silent: true)
    }

    func markAllRead() async {
        try? await repository.markAllRead()
        await load(silent: true)
    }
}

struct StaffInboxScreen: View {
    @EnvironmentObject private var store: StaffStore

    var body: some View {
        StaffInboxContent(store: store)
    }
}

private struct StaffInboxContent: View {
    @StateObject private var model: StaffInboxModel

    init(store: StaffStore) {
        _model = StateObject(wrappedValue: StaffInboxModel(
            repository: store.repository,
            fence: store.sessionFence,
            onUnread: { [weak store] count in store?.setUnreadCount(count) }
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            StaffScreenHeader(title: "Notifications", centerTitle: true) {
                if model.unread > 0 {
                    Button("Mark all read") { Task { await model.markAllRead() } }
                        .staffFont(14, .semibold)
                        .foregroundStyle(ScheduleTokens.ink)
                        .frame(minHeight: 44)
                }
            }
            Group {
                if model.loading && model.items.isEmpty {
                    LoadingView("Loading notifications")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            if let error = model.error {
                                MessageCard(title: "Notifications unavailable", message: error, kind: .error, actionTitle: "Retry") {
                                    Task { await model.load() }
                                }
                            } else if model.items.isEmpty {
                                EmptyStateView(systemImage: "bell", title: "No notifications yet.")
                                    .frame(minHeight: 280)
                            }
                            ForEach(model.items) { item in
                                tile(item)
                            }
                        }
                        .padding(20)
                    }
                    .refreshable { await model.load(silent: true) }
                }
            }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .task { await model.load() }
        .staffPushedScreen()
        .accessibilityIdentifier("staff.inbox")
    }

    private func tile(_ item: StaffNotification) -> some View {
        Button { Task { await model.markRead(item) } } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top) {
                    Text(item.title).scheduleType(ScheduleType.bodyStrong)
                    Spacer(minLength: 8)
                    if item.isUnread {
                        Circle().fill(ScheduleTokens.errorText).frame(width: 8, height: 8).accessibilityHidden(true)
                    }
                }
                Text(item.message).scheduleType(ScheduleType.secondary)
                Text(CrewflowDateFormat.dayTime(item.createdAt)).scheduleType(ScheduleType.caption)
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(item.isUnread ? ScheduleTokens.lavender.opacity(0.45) : Color.white)
            )
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(ScheduleTokens.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!item.isUnread)
        .accessibilityElement(children: .combine)
        .accessibilityValue(item.isUnread ? "Unread" : "Read")
        .accessibilityHint(item.isUnread ? "Marks it as read" : "")
    }
}

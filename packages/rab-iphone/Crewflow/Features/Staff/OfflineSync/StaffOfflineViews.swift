import SwiftUI

/// Words for actions saved on this phone (DESIGN §3.6). Every time shown is
/// the server-anchored estimate of the button press (`estimatedAt`), never
/// the phone's wall clock, and nothing here ticks: a saved action is not
/// confirmed until the server answers (D10).
enum StaffOfflinePresentation {
    static func time(_ punch: OfflineQueuedPunch) -> String {
        CrewflowDateFormat.time(punch.estimatedAt)
    }

    /// The card that replaces the running timer while a clock-in is only on
    /// this phone (D10: fixed text, no timer).
    static func savedClockIn(_ punch: OfflineQueuedPunch) -> String {
        "Clocked in \(time(punch)), saved on this phone, not yet confirmed"
    }

    static func title(_ punch: OfflineQueuedPunch) -> String {
        switch punch.state {
        case .pending: return "\(punch.type.label) saved on this phone at \(time(punch))"
        case .rejected: return "\(punch.type.label) at \(time(punch)) was not accepted"
        case .tooOld: return "\(punch.type.label) at \(time(punch)) was not sent"
        case .undeliverable: return "\(punch.type.label) at \(time(punch)) could not be sent"
        }
    }

    static func detail(_ punch: OfflineQueuedPunch) -> String {
        switch punch.state {
        case .pending: return "No connection. It will be sent when you're back online."
        case .rejected: return OfflineSyncMessages.reason(punch.rejectionCode) + " " + OfflineSyncMessages.managerCanSee
        case .tooOld: return OfflineSyncMessages.tooOld
        case .undeliverable: return OfflineSyncMessages.undeliverable
        }
    }

    static func signOutTitle(_ count: Int) -> String {
        count == 1 ? "1 action is saved on this phone and not sent yet" : "\(count) actions are saved on this phone and not sent yet"
    }

    static let signOutMessage = "Connect to send them before you log out. If you discard them they are never sent and your manager is not told."
    /// The stored queue could not be read: it is never discarded.
    static let signOutUnreadableMessage = "They could not be read, so they cannot be discarded. If you log out they stay on this phone and are sent the next time you sign in and connect."
    static let sendSavedFirst = "Actions saved on this phone must be sent first. Connect, then tap Send now."
}

/// The saved actions as message cards: amber while waiting to send, red (with
/// Dismiss) once refused, too old or undeliverable. "Send now" while any wait.
struct StaffSavedActionsList: View {
    let items: [OfflineQueuedPunch]
    let sending: Bool
    let onSend: () -> Void
    let onDismiss: (String) -> Void

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(items) { punch in
                    card(punch)
                }
                if items.contains(where: { $0.state == .pending }) {
                    PrimaryButton("Send now", systemImage: "arrow.up.circle", variant: .light, isBusy: sending, action: onSend)
                        .accessibilityIdentifier("staff.offline.sendNow")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("staff.offline.saved")
        }
    }

    @ViewBuilder
    private func card(_ punch: OfflineQueuedPunch) -> some View {
        if punch.state == .pending {
            MessageCard(
                title: StaffOfflinePresentation.title(punch),
                message: StaffOfflinePresentation.detail(punch),
                kind: .warning
            )
        } else {
            MessageCard(
                title: StaffOfflinePresentation.title(punch),
                message: StaffOfflinePresentation.detail(punch),
                kind: .error,
                actionTitle: "Dismiss"
            ) {
                onDismiss(punch.id)
            }
        }
    }
}

/// Replaces the hero timer while the clock-in is only on this phone.
struct StaffSavedClockInCard: View {
    let punch: OfflineQueuedPunch

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("NOT YET CONFIRMED").scheduleType(ScheduleType.timerLabel)
            Text(StaffOfflinePresentation.savedClockIn(punch))
                .scheduleType(ScheduleType.bodyStrong)
                .fixedSize(horizontal: false, vertical: true)
            StaffClockStatusBadge(label: "Saved on this phone", warning: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("staff.clock.savedClockIn")
    }
}

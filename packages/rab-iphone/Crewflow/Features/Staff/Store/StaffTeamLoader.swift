import Foundation

/// The confirmed team of ONE shift for the Clock / Teams screens (Flutter
/// `ScheduleClockScreen` team list). Phase C1 policy: a refresh of the SAME
/// shift never empties the list first and never replaces it with an error —
/// a failure while rows are on screen only marks them `stale` (non-blocking
/// notice). Only a first load with nothing to show yet reports `error`, and a
/// permanent refusal (401/403/404/410: no longer on this shift) drops the rows.
@MainActor
final class StaffTeamLoader: ObservableObject {
    @Published private(set) var members: [StaffTeamMember] = []
    @Published private(set) var shiftId: String?
    /// True only while a shift's FIRST load is running (no rows yet).
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    /// A refresh failed; `members` are the last good answer.
    @Published private(set) var stale = false

    private var loaded = false
    private var inFlight = false

    init() {}

    /// Loads (or refreshes) the team of `shiftId`. A call while a load is in
    /// flight is skipped (the running one answers). Throws the failure so a
    /// poller can back off; the screen state is already updated.
    ///
    /// - Parameter background: only the timer's reads are background traffic.
    func load(shiftId: String, background: Bool = false, using store: StaffStore) async throws {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }
        if self.shiftId != shiftId {
            // Another shift: nothing of the previous one may stay on screen.
            self.shiftId = shiftId
            members = []
            loaded = false
            stale = false
            error = nil
        }
        if !loaded {
            loading = true
            error = nil
        }
        do {
            let rows = try await store.loadTeam(shiftId: shiftId, background: background)
            guard self.shiftId == shiftId else { return }
            members = rows
            loaded = true
            stale = false
            error = nil
            loading = false
        } catch {
            guard self.shiftId == shiftId else { throw error }
            loading = false
            if !StaffStore.ignorable(error) {
                if Self.isPermanentRefusal(error) {
                    // Never keep showing coworkers the server has just refused.
                    members = []
                    loaded = false
                    stale = false
                    self.error = "Unable to load your team. Please try again."
                } else if loaded {
                    stale = true
                } else {
                    self.error = "Unable to load your team. Please try again."
                }
            }
            throw error
        }
    }

    /// A refusal that will not change by asking again (web `isPermanentRefusal`).
    static func isPermanentRefusal(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return false }
        return [401, 403, 404, 410].contains(apiError.statusCode)
    }
}

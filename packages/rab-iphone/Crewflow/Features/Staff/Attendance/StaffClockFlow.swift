import Foundation
import SwiftUI

/// The UI steps the attendance flow waits on. The screen presents them; the
/// flow awaits the answer. A protocol so tests drive the flow without UI.
protocol StaffAttendancePrompting: AnyObject {
    /// Explain-first sheet before the system location prompt. true = Continue.
    @MainActor func explainLocation() async -> Bool
    /// "Location unavailable" with Open Settings.
    @MainActor func locationUnavailable() async
    /// "End your shift?" confirmation. true = Clock out.
    @MainActor func confirmClockOut() async -> Bool
    /// "Your shift hasn't started yet" (server-derived opening instant).
    @MainActor func showEarly(availableAt: Date, checkIn: Bool) async
    /// Native QR scanner. The scanned text verbatim, or nil when cancelled.
    @MainActor func scanQR() async -> String?
}

/// Presentation state for `StaffAttendancePrompting`: one sheet or the
/// scanner at a time; every continuation is resumed exactly once (a swipe
/// dismissal resumes with the "cancel" answer).
@MainActor
final class StaffAttendancePrompts: ObservableObject, StaffAttendancePrompting {
    enum Sheet: Identifiable, Equatable {
        case explainLocation
        case locationUnavailable
        case confirmClockOut
        case early(availableAt: Date, checkIn: Bool)

        var id: String {
            switch self {
            case .explainLocation: return "explain-location"
            case .locationUnavailable: return "location-unavailable"
            case .confirmClockOut: return "confirm-clock-out"
            case .early: return "early"
            }
        }
    }

    @Published var sheet: Sheet?
    @Published var scannerVisible = false

    private var answer: CheckedContinuation<Bool, Never>?
    /// The sheet the pending `answer` belongs to. A late `onDisappear` of an
    /// earlier sheet must never answer the next one.
    private var pendingSheet: Sheet?
    private var token: CheckedContinuation<String?, Never>?

    func explainLocation() async -> Bool { await ask(.explainLocation) }

    func locationUnavailable() async { _ = await ask(.locationUnavailable) }

    func confirmClockOut() async -> Bool { await ask(.confirmClockOut) }

    func showEarly(availableAt: Date, checkIn: Bool) async {
        _ = await ask(.early(availableAt: availableAt, checkIn: checkIn))
    }

    func scanQR() async -> String? {
        resolveToken(nil)
        await waitForDismissal()
        return await withCheckedContinuation { continuation in
            token = continuation
            scannerVisible = true
        }
    }

    /// A sheet button answered.
    func resolve(_ value: Bool) {
        let continuation = answer
        answer = nil
        pendingSheet = nil
        if sheet != nil {
            sheet = nil
            lastClosedUptime = ProcessInfo.processInfo.systemUptime
        }
        continuation?.resume(returning: value)
    }

    /// UIKit refuses to present while a sheet is still animating away (the
    /// continuation would then never resume). Wait out the dismissal first.
    private var lastClosedUptime: TimeInterval?
    private static let dismissalDuration: TimeInterval = 0.6

    private func waitForDismissal() async {
        guard let closed = lastClosedUptime else { return }
        let remaining = Self.dismissalDuration - (ProcessInfo.processInfo.systemUptime - closed)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
    }

    /// A sheet disappeared (swipe down, or after an answer). Only answers
    /// "cancel" if that same sheet is still waiting.
    func sheetDisappeared(_ disappeared: Sheet) {
        guard answer != nil, pendingSheet == disappeared else { return }
        resolve(false)
    }

    /// The scanner delivered (or was cancelled / dismissed).
    func resolveToken(_ value: String?) {
        let continuation = token
        token = nil
        if scannerVisible {
            scannerVisible = false
            lastClosedUptime = ProcessInfo.processInfo.systemUptime
        }
        continuation?.resume(returning: value)
    }

    private func ask(_ next: Sheet) async -> Bool {
        resolve(false)
        await waitForDismissal()
        return await withCheckedContinuation { continuation in
            answer = continuation
            pendingSheet = next
            sheet = next
        }
    }
}

/// The Check In → Clock In → Clock Out sequences (Flutter
/// `_ScheduleClockScreenState._checkIn/_clockIn/_clockOut`). Business rules
/// stay server-side; this only orders the steps and asks for evidence.
@MainActor
final class StaffClockFlow: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var confirming = false
    /// Set after a confirmed clock-out (the screen shows "completed" even if
    /// history is temporarily unavailable).
    @Published private(set) var completedAttendanceId: String?

    private let store: StaffStore
    private let location: StaffLocationProviding
    private let prompts: StaffAttendancePrompting
    private let deviceNow: () -> Date

    init(store: StaffStore, location: StaffLocationProviding, prompts: StaffAttendancePrompting, deviceNow: @escaping () -> Date = { Date() }) {
        self.store = store
        self.location = location
        self.prompts = prompts
        self.deviceNow = deviceNow
    }

    /// Location evidence only where the venue enforces its geofence.
    /// `false` → NO permission prompt and NO fix at all. Unknown (older
    /// server) keeps the previous behaviour and asks. `ok == false` = the
    /// person backed out or no fix was possible (nothing is sent).
    func evidence(geofenceEnforced: Bool?) async -> (ok: Bool, fix: StaffLocationFix?) {
        if geofenceEnforced == false { return (true, nil) }
        var status = location.authorization()
        if status == .notDetermined {
            guard await prompts.explainLocation() else { return (false, nil) }
            status = await location.requestWhenInUse()
        }
        guard status == .authorized else {
            await prompts.locationUnavailable()
            return (false, nil)
        }
        guard let raw = await location.currentFix() else {
            await prompts.locationUnavailable()
            return (false, nil)
        }
        return (true, StaffLocationFix.make(
            latitude: raw.latitude,
            longitude: raw.longitude,
            accuracy: raw.horizontalAccuracy,
            timestamp: raw.timestamp,
            trustedNow: store.attendanceNow,
            deviceNow: deviceNow()
        ))
    }

    /// "I am at the venue": obeys the server window (early sheet before it
    /// opens), no QR, success only after the server answers.
    func checkIn(_ offer: StaffOfferSummary) async {
        guard !busy, !store.attendanceBusy else { return }
        busy = true
        defer { busy = false }
        var known = store.checkInState(for: offer)
        if known == nil { known = await store.loadCheckIn(shiftId: offer.shiftId) }
        if known?.checkedIn == true { return }
        if let now = store.attendanceNow,
           let opensAt = StaffCheckInRules.opensAt(offer: offer, state: known, clockInEarlyMinutes: store.clockInEarlyMinutes),
           now < opensAt {
            await prompts.showEarly(availableAt: opensAt, checkIn: true)
            return
        }
        let (ok, fix) = await evidence(geofenceEnforced: store.geofenceEnforced(shiftId: offer.shiftId, offer: offer))
        guard ok else { return }
        if await store.checkIn(shiftId: offer.shiftId, location: fix) {
            await store.loadOffers(silent: true)
        }
    }

    /// Clock In: early check against the SERVER clock (UX only; the server
    /// enforces the window), evidence, QR scan, one POST. Never retried.
    func clockIn(_ offer: StaffOfferSummary) async {
        guard !busy, !store.attendanceBusy, !store.needsCheckIn(offer) else { return }
        if let now = store.attendanceNow, let early = store.clockInEarlyMinutes {
            let availableAt = store.checkInState(for: offer)?.opensAt
                ?? offer.startsAt.addingTimeInterval(-TimeInterval(early) * 60)
            if now < availableAt {
                await prompts.showEarly(availableAt: availableAt, checkIn: false)
                return
            }
        }
        busy = true
        defer { busy = false }
        let (ok, fix) = await evidence(geofenceEnforced: store.geofenceEnforced(shiftId: offer.shiftId, offer: offer))
        guard ok else { return }
        guard let token = await prompts.scanQR() else { return }
        if await store.clockIn(shiftId: offer.shiftId, qrToken: token, location: fix) {
            await store.loadOffers(silent: true)
        }
    }

    /// Clock Out: confirmation, evidence, QR scan, one POST. Never retried.
    func clockOut() async {
        guard !busy, !confirming, !store.attendanceBusy, let active = store.liveAttendance else { return }
        confirming = true
        let confirmed = await prompts.confirmClockOut()
        confirming = false
        guard confirmed, store.liveAttendance?.id == active.id else { return }
        busy = true
        defer { busy = false }
        let offer = store.offer(forShift: active.shiftId)
        let (ok, fix) = await evidence(geofenceEnforced: store.geofenceEnforced(shiftId: active.shiftId, offer: offer))
        guard ok else { return }
        guard let token = await prompts.scanQR() else { return }
        if await store.clockOut(qrToken: token, location: fix) {
            completedAttendanceId = active.id
            await store.loadOffers(silent: true)
        }
    }

    func resetCompletion() {
        completedAttendanceId = nil
    }
}

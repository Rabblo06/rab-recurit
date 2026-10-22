import CoreLocation
import Foundation

/// Location authorisation as the attendance flow needs it.
enum StaffLocationAuthorization: Equatable {
    case notDetermined
    case denied
    case authorized
}

/// One raw device fix (kept free of CoreLocation types for tests).
struct StaffRawFix: Equatable {
    let latitude: Double
    let longitude: Double
    let horizontalAccuracy: Double
    let timestamp: Date
}

/// One-shot, when-in-use location for Check In / Clock In / Clock Out.
/// There is NO background location, no continuous updates and no "Always"
/// request anywhere in the Staff app (the Flutter geofence-exit stream is
/// not ported; see the parity matrix S19).
protocol StaffLocationProviding: AnyObject {
    @MainActor func authorization() -> StaffLocationAuthorization
    /// Shows the system prompt only when not yet determined.
    @MainActor func requestWhenInUse() async -> StaffLocationAuthorization
    /// nil on denial, timeout, services off or any failure (never throws).
    @MainActor func currentFix() async -> StaffRawFix?
}

/// CoreLocation implementation. Created and used on the main thread (the
/// manager delivers its delegate callbacks on the thread that created it).
final class StaffCoreLocationProvider: NSObject, CLLocationManagerDelegate, StaffLocationProviding {
    static let fixTimeout: TimeInterval = 20

    private let manager: CLLocationManager
    private var authorizationContinuation: CheckedContinuation<StaffLocationAuthorization, Never>?
    private var fixContinuation: CheckedContinuation<StaffRawFix?, Never>?
    private var timeoutTask: Task<Void, Never>?

    override init() {
        manager = CLLocationManager()
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.pausesLocationUpdatesAutomatically = true
    }

    static func map(_ status: CLAuthorizationStatus) -> StaffLocationAuthorization {
        switch status {
        case .notDetermined: return .notDetermined
        case .authorizedWhenInUse, .authorizedAlways: return .authorized
        default: return .denied
        }
    }

    @MainActor func authorization() -> StaffLocationAuthorization {
        Self.map(manager.authorizationStatus)
    }

    @MainActor func requestWhenInUse() async -> StaffLocationAuthorization {
        let current = authorization()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            authorizationContinuation = continuation
            manager.requestWhenInUseAuthorization()
        }
    }

    @MainActor func currentFix() async -> StaffRawFix? {
        guard authorization() == .authorized else { return nil }
        // `locationServicesEnabled` must not run on the main thread.
        let servicesOn = await Task.detached { CLLocationManager.locationServicesEnabled() }.value
        guard servicesOn else { return nil }
        finishFix(nil) // never two one-shot requests at once
        return await withCheckedContinuation { continuation in
            fixContinuation = continuation
            manager.requestLocation()
            timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.fixTimeout * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.manager.stopUpdatingLocation()
                self?.finishFix(nil)
            }
        }
    }

    private func finishFix(_ fix: StaffRawFix?) {
        timeoutTask?.cancel()
        timeoutTask = nil
        let continuation = fixContinuation
        fixContinuation = nil
        continuation?.resume(returning: fix)
    }

    // MARK: CLLocationManagerDelegate (main thread)

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = Self.map(manager.authorizationStatus)
        guard status != .notDetermined, let continuation = authorizationContinuation else { return }
        authorizationContinuation = nil
        continuation.resume(returning: status)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        finishFix(StaffRawFix(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            horizontalAccuracy: location.horizontalAccuracy,
            timestamp: location.timestamp
        ))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finishFix(nil)
    }
}

import Foundation

/// Tokens returned by `/auth/refresh` (and the token half of `/auth/login`).
public struct TokenPair: Sendable, Equatable {
    public let accessToken: String
    public let refreshToken: String
}

/// Serialises everything that must be atomic with respect to the stored
/// session: the identity generation counter, the single in-flight refresh,
/// writing rotated tokens, and wiping them.
///
/// - Concurrent 401s share ONE `/auth/refresh` (a second rotation of the
///   same refresh token is reuse-detected server-side and revokes the whole
///   session family — rab-workforce-architecture.md §8.1).
/// - Every sign-out / account switch bumps `generation`. A refresh that
///   completes after that is discarded (its tokens are never written), and
///   requests dispatched under the old generation are never replayed with
///   the new identity's token (Flutter CF-36 / P0.1 #9).
actor SessionGate {
    private let tokens: TokenStore
    private(set) var generation: UInt64 = 0
    private var inFlight: Task<Bool, Error>?
    private var expiryHandler: (@MainActor @Sendable () -> Void)?

    init(tokens: TokenStore) {
        self.tokens = tokens
    }

    func isCurrent(_ candidate: UInt64) -> Bool {
        candidate == generation
    }

    func setExpiryHandler(_ handler: (@MainActor @Sendable () -> Void)?) {
        expiryHandler = handler
    }

    /// Single-flight refresh. `fetch` performs the network call with the
    /// presented refresh token and returns new tokens, or nil when the server
    /// rejected the refresh token (401/403). Throws for transport/5xx
    /// failures, which leave the stored session untouched.
    ///
    /// `presentedAccessToken` is the bearer the failed request carried: if a
    /// different access token is already stored, another caller refreshed
    /// meanwhile and this one simply replays (no second rotation).
    func refresh(
        presentedAccessToken: String? = nil,
        _ fetch: @escaping @Sendable (String) async throws -> TokenPair?
    ) async throws -> Bool {
        if let running = inFlight {
            return try await running.value
        }
        if let presentedAccessToken, let current = tokens.accessToken(), current != presentedAccessToken {
            return true
        }
        let start = generation
        let task = Task<Bool, Error> { try await self.performRefresh(from: start, fetch: fetch) }
        inFlight = task
        defer {
            if inFlight == task { inFlight = nil }
        }
        return try await task.value
    }

    private func performRefresh(from start: UInt64, fetch: @Sendable (String) async throws -> TokenPair?) async throws -> Bool {
        guard let refreshToken = tokens.refreshToken() else { return false }
        guard let pair = try await fetch(refreshToken) else { return false }
        // Back on the actor: nothing can interleave between this check and
        // the write below, so a logout that happened while the refresh was
        // on the wire always wins.
        guard generation == start else { throw APIError.sessionChanged }
        try tokens.store(accessToken: pair.accessToken, refreshToken: pair.refreshToken)
        return true
    }

    /// Ends the current identity: bumps the generation, forgets any in-flight
    /// refresh (its late result is discarded) and wipes stored tokens.
    func invalidate() {
        generation &+= 1
        inFlight = nil
        tokens.clear()
    }

    /// Ends the session only if `candidate` is still the current identity
    /// (a 401 from an old identity must never sign out the new one).
    /// Returns the expiry handler to call when it did.
    func expireIfCurrent(_ candidate: UInt64) -> (@MainActor @Sendable () -> Void)? {
        guard candidate == generation else { return nil }
        invalidate()
        return expiryHandler
    }
}

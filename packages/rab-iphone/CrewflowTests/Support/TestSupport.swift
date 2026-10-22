import Foundation
import XCTest
@testable import Crewflow

let testBaseURL = URL(string: "https://api.test/rest/v1")!

// MARK: - Fixtures

enum Fixture {
    private final class Token {}

    /// Raw bytes of a JSON fixture in CrewflowTests/Fixtures.
    static func data(_ name: String) -> Data {
        let bundle = Bundle(for: Token.self)
        guard let url = bundle.url(forResource: name, withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else {
            fatalError("Missing fixture \(name).json in the test bundle")
        }
        return data
    }
}

// MARK: - URLProtocol stub

/// What the stub server answers for one request.
struct StubResponse {
    var status: Int = 200
    var headers: [String: String] = ["Content-Type": "application/json"]
    var body: Data = Data()
    var error: URLError?

    static func json(_ status: Int, _ text: String, headers: [String: String] = [:]) -> StubResponse {
        var all = ["Content-Type": "application/json"]
        all.merge(headers) { _, new in new }
        return StubResponse(status: status, headers: all, body: Data(text.utf8))
    }

    static func fixture(_ name: String, status: Int = 200) -> StubResponse {
        StubResponse(status: status, body: Fixture.data(name))
    }

    static func empty(_ status: Int) -> StubResponse {
        StubResponse(status: status, headers: [:], body: Data())
    }

    static func failure(_ code: URLError.Code) -> StubResponse {
        StubResponse(error: URLError(code))
    }
}

/// Records every request and answers through a test-provided handler. The
/// handler runs on a background queue and MAY block (to hold a response
/// while the test signs out, for example).
final class StubServer: @unchecked Sendable {
    typealias Handler = (URLRequest) -> StubResponse

    private let lock = NSLock()
    private var handler: Handler = { _ in .json(404, #"{"message":"Not found."}"#) }
    private var recorded: [URLRequest] = []

    func reset() {
        lock.lock(); defer { lock.unlock() }
        handler = { _ in .json(404, #"{"message":"Not found."}"#) }
        recorded = []
    }

    func setHandler(_ handler: @escaping Handler) {
        lock.lock(); defer { lock.unlock() }
        self.handler = handler
    }

    func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        recorded.append(request)
    }

    func respond(to request: URLRequest) -> StubResponse {
        lock.lock()
        let current = handler
        lock.unlock()
        return current(request)
    }

    var requests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    /// Requests whose path ends with `suffix` (e.g. "/auth/refresh").
    func requests(to suffix: String) -> [URLRequest] {
        requests.filter { ($0.url?.path ?? "").hasSuffix(suffix) }
    }
}

final class URLProtocolStub: URLProtocol {
    static let server = StubServer()

    private var clientThread: Thread?
    private var stopped = false
    private var pending: (StubResponse, URLRequest)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        clientThread = Thread.current
        var captured = request
        if captured.httpBody == nil, let stream = request.httpBodyStream {
            captured.httpBody = Self.read(stream)
        }
        let server = Self.server
        server.record(captured)
        DispatchQueue.global().async { [weak self] in
            let response = server.respond(to: captured)
            guard let self, let thread = self.clientThread else { return }
            self.pending = (response, captured)
            self.perform(#selector(self.deliver), on: thread, with: nil, waitUntilDone: false, modes: [RunLoop.Mode.common.rawValue])
        }
    }

    override func stopLoading() {
        stopped = true
    }

    @objc private func deliver() {
        guard !stopped, let pending, let url = pending.1.url else { return }
        let response = pending.0
        if let error = response.error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let http = HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: response.headers)!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: size)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = APIClient.defaultConfiguration()
        configuration.protocolClasses = [URLProtocolStub.self]
        return configuration
    }
}

extension URLRequest {
    var jsonBody: [String: Any]? {
        guard let body = httpBody, !body.isEmpty else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }

    var bearer: String? {
        value(forHTTPHeaderField: "Authorization")
    }
}

// MARK: - Test doubles

/// In-memory secure store that also records the ORDER of writes.
final class RecordingSecureStore: SecureStore, @unchecked Sendable {
    private let inner = InMemorySecureStore()
    private let lock = NSLock()
    private var log: [String] = []

    func string(for key: String) -> String? { inner.string(for: key) }

    func set(_ value: String, for key: String) throws {
        lock.lock(); log.append(key); lock.unlock()
        try inner.set(value, for: key)
    }

    func remove(_ key: String) { inner.remove(key) }
    func removeAll() { inner.removeAll() }

    var writes: [String] {
        lock.lock(); defer { lock.unlock() }
        return log
    }
}

struct FakeBiometrics: BiometricAuthenticating {
    var available: BiometricCapability = .unavailable
    var result: BiometricOutcome = .notAvailable

    func capability() async -> BiometricCapability { available }
    func authenticate(reason: String) async -> BiometricOutcome { result }
}

/// One-shot async gate for deterministic interleavings.
actor Latch {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

/// Builds an APIClient wired to the stub server.
func makeClient(store: any SecureStore = InMemorySecureStore()) -> (APIClient, TokenStore) {
    let tokens = TokenStore(store: store)
    let client = APIClient(
        baseURL: testBaseURL,
        tokens: tokens,
        temporaryFiles: TemporaryFiles(directory: FileManager.default.temporaryDirectory.appendingPathComponent("crewflow-tests-\(UUID().uuidString)")),
        configuration: URLProtocolStub.configuration()
    )
    return (client, tokens)
}

struct Probe: Decodable, Equatable {
    let ok: Bool
}

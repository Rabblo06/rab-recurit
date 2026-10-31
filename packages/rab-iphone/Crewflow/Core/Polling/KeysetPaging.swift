import Foundation

/// One keyset page (API contract §3): `{ data: [...], nextCursor }`.
struct KeysetPage<Item: Decodable>: Decodable {
    let data: [Item]
    let nextCursor: String?
}

/// A keyset endpoint's answer: the page shape, or the legacy bare array an
/// older server returns (it ignores `limit`/`cursor`/`scope`).
enum KeysetListOrPage<Item: Decodable>: Decodable {
    case list([Item])
    case page(KeysetPage<Item>)

    init(from decoder: Decoder) throws {
        if let items = try? decoder.singleValueContainer().decode([Item].self) {
            self = .list(items)
            return
        }
        self = .page(try KeysetPage<Item>(from: decoder))
    }
}

enum KeysetPagingError: Error, Equatable {
    /// A later page answered in the legacy shape: the server changed mid-walk.
    case listChanged
    /// The server handed back a cursor it already gave (never loop).
    case repeatedPage
    /// More pages than `maxPages` (a defensive bound).
    case tooLong
}

/// Reads every page of a keyset-paged list (`?limit=&cursor=` →
/// `{data, nextCursor}`), first page without a cursor, until `nextCursor` is
/// null. Nothing is truncated: the walk only ends at the server's own end.
/// Port of Flutter `fetchAllKeysetPages` (core/polling/keyset_pages.dart).
///
/// Rollout (a server without keyset paging yet): a 400 on the first page
/// (unknown parameter) or a bare-array answer that may have been cut at
/// `limit` falls back to ONE legacy call of `path` with no parameters, which
/// keeps that server's original default. A bare array shorter than `limit`
/// is already complete.
enum KeysetPaging {
    private static let unreserved: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }

    static func fetchAll<Item: Decodable>(
        _ api: APIClient,
        path: String,
        query: String? = nil,
        limit: Int,
        options: RequestOptions? = nil,
        maxPages: Int = 100,
        as type: Item.Type
    ) async throws -> [Item] {
        var rows: [Item] = []
        var seen = Set<String>()
        var cursor: String?
        for page in 0..<maxPages {
            var params: [String] = []
            if let query { params.append(query) }
            params.append("limit=\(limit)")
            if let cursor { params.append("cursor=\(encode(cursor))") }
            let response: KeysetListOrPage<Item>
            do {
                response = try await api.get(
                    "\(path)?\(params.joined(separator: "&"))",
                    options: options,
                    as: KeysetListOrPage<Item>.self
                )
            } catch let error as APIError {
                if page == 0, case .validation(400, _) = error {
                    return try await api.get(path, options: options, as: [Item].self)
                }
                throw error
            }
            switch response {
            case .list(let items):
                guard page == 0 else { throw KeysetPagingError.listChanged }
                if items.count < limit { return items }
                return try await api.get(path, options: options, as: [Item].self)
            case .page(let body):
                rows.append(contentsOf: body.data)
                guard let next = body.nextCursor, !next.isEmpty else { return rows }
                guard seen.insert(next).inserted else { throw KeysetPagingError.repeatedPage }
                cursor = next
            }
        }
        throw KeysetPagingError.tooLong
    }
}

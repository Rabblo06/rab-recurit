/// Signs a queued offline entry with the registered device key (DESIGN §6.1–§6.2, D11): an ES256 signature over the
/// RFC 8785 canonical JSON of every field except `sig`, from a hardware-backed, non-exportable Android Keystore EC
/// P-256 key registered online through `POST /rest/v1/attendance/me/device-key`.
abstract class OfflineEntrySigner {
  /// The server's id for the registered key, or null when no key is registered on this install for this session.
  String? get deviceKeyId;

  /// True only when a registered key can sign right now. The offline queue refuses to capture anything otherwise
  /// (DESIGN §3.1: "the phone holds a valid offline ticket AND a registered device key").
  bool get isAvailable;

  /// The base64url (no padding) IEEE P1363 signature of [payload], or null when signing failed. A null result makes
  /// the capture fail closed: nothing is queued.
  Future<String?> sign(List<int> payload);
}

/// PLACEHOLDER (the device key is not available yet): the Keystore key, its platform channel and the server's
/// device-key registration route (DESIGN §13 PR 5) are not built. Until they are, no key exists, [isAvailable] is
/// false, and therefore nothing can ever be queued on a real phone, whatever the server or the build flag says. Tests
/// inject their own signer.
class UnavailableEntrySigner implements OfflineEntrySigner {
  const UnavailableEntrySigner();

  @override
  String? get deviceKeyId => null;

  @override
  bool get isAvailable => false;

  @override
  Future<String?> sign(List<int> payload) async => null;
}

import CryptoKit
import Foundation

/// The network keyring, as the app stores it: `current` encrypts, older keys only decrypt.
struct Keyring: Codable {
    let current: String
    let keys: [String: String]

    func key(_ kid: String) throws -> SymmetricKey {
        guard let b64 = keys[kid], let raw = Data(base64Encoded: b64) else { throw OmniClipError.message("This device has no key for that clip.") }
        return SymmetricKey(data: raw)
    }
}

enum OmniClipError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case let .message(m) = self { return m }
        return nil
    }
}

/// End-to-end encryption, byte for byte the same as packages/protocol/src/e2e.ts.
enum OmniClipCrypto {
    static let chunk = 64 * 1024

    /// `{ v: 1, kid, box }` with box = base64(nonce | ciphertext | tag), AAD "omniclip-clip-v1".
    static func sealJson(_ value: [String: Any], keys: Keyring) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: value)
        let box = try AES.GCM.seal(data, using: try keys.key(keys.current), authenticating: Data("omniclip-clip-v1".utf8))
        guard let combined = box.combined else { throw OmniClipError.message("Encryption failed.") }
        return ["v": 1, "kid": keys.current, "box": combined.base64EncodedString()]
    }

    /// "OCB1" | kid length | kid | nonce prefix (8) | 64 KiB chunks, nonce = prefix | counter, AAD "ocb1" + last flag.
    static func encryptBlob(_ data: Data, keys: Keyring) throws -> Data {
        let key = try keys.key(keys.current)
        let kid = Data(keys.current.utf8)
        var prefix = Data(count: 8)
        _ = prefix.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 8, $0.baseAddress!) }
        var out = Data("OCB1".utf8)
        out.append(UInt8(kid.count))
        out.append(kid)
        out.append(prefix)
        let chunks = max(1, (data.count + chunk - 1) / chunk)
        for i in 0..<chunks {
            let part = data.subdata(in: (i * chunk)..<min((i + 1) * chunk, data.count))
            var nonce = prefix
            withUnsafeBytes(of: UInt32(i).bigEndian) { nonce.append(contentsOf: $0) }
            var aad = Data("ocb1".utf8)
            aad.append(i == chunks - 1 ? 1 : 0)
            let sealed = try AES.GCM.seal(part, using: key, nonce: try AES.GCM.Nonce(data: nonce), authenticating: aad)
            out.append(sealed.ciphertext)
            out.append(sealed.tag)
        }
        return out
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

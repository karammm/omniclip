import Foundation
import Security

/// What the app shares with its extensions through the App Group (written by OmniClipPlugin.saveSession).
struct SharedSession: Codable {
    struct DeviceInfo: Codable {
        let id: String
        let name: String
        let platform: String
        let online: Bool?
    }

    let hub: String
    let token: String
    let caPem: String
    let deviceId: String
    let keys: Keyring?
    let devices: [DeviceInfo]?

    static let appGroup = "group.com.omniclip.app"

    static func load() -> SharedSession? {
        guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: "session") else { return nil }
        return try? JSONDecoder().decode(SharedSession.self, from: data)
    }
}

/// Something shared from another app.
enum ShareItem {
    case text(String)
    case file(name: String, mime: String, data: Data)
}

/// Sends to the hub over the local network, trusting only the network's own certificate authority.
final class HubClient: NSObject, URLSessionDelegate {
    private let session: SharedSession
    private let anchor: SecCertificate?
    private lazy var urlSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

    init(session: SharedSession) {
        self.session = session
        let b64 = session.caPem
            .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines).joined()
        anchor = Data(base64Encoded: b64).flatMap { SecCertificateCreateWithData(nil, $0 as CFData) }
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust, let anchor
        else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func send(_ item: ShareItem, to deviceId: String?) async throws {
        var comps = URLComponents(string: session.hub + "/api/clips")!
        var query = [URLQueryItem(name: "sensitive", value: "0")]
        if let deviceId { query.append(URLQueryItem(name: "to", value: deviceId)) }
        comps.queryItems = query
        var req = URLRequest(url: comps.url!, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        let keys = session.keys
        if keys != nil { req.setValue("1", forHTTPHeaderField: "x-omniclip-e2e") }

        switch item {
        case let .text(text):
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any]
            if let keys {
                let payload: [String: Any] = ["text": text, "hash": OmniClipCrypto.sha256Hex(Data(text.utf8))]
                body = ["enc": try OmniClipCrypto.sealJson(payload, keys: keys), "size": Data(text.utf8).count]
            } else {
                body = ["text": text]
            }
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        case let .file(name, mime, data):
            let boundary = "omniclip-\(UUID().uuidString)"
            req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            var body = Data()
            func field(_ k: String, _ v: String) {
                body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8))
            }
            var file = data
            var fileName = name.replacingOccurrences(of: "\"", with: "_")
            var fileMime = mime
            if let keys {
                field("kind", mime.hasPrefix("image/") ? "image" : "file")
                field("size", String(data.count))
                let enc = try OmniClipCrypto.sealJson(["name": name, "mime": mime, "hash": OmniClipCrypto.sha256Hex(data)], keys: keys)
                field("enc", String(data: try JSONSerialization.data(withJSONObject: enc), encoding: .utf8)!)
                file = try OmniClipCrypto.encryptBlob(data, keys: keys)
                fileName = "blob"
                fileMime = "application/octet-stream"
            } else if !mime.hasPrefix("image/") {
                field("kind", "file")
            }
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\nContent-Type: \(fileMime)\r\n\r\n".utf8))
            body.append(file)
            body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            req.httpBody = body
        }
        let (data, res) = try await urlSession.data(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw OmniClipError.message(msg ?? "The hub refused it.")
        }
    }
}

/// Items that couldn't be sent wait in the App Group; the app sends them the next time it opens.
enum ShareQueue {
    static var folder: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedSession.appGroup)?.appendingPathComponent("Queue", isDirectory: true)
    }

    static func add(_ item: ShareItem) throws {
        guard let folder else { throw OmniClipError.message("OmniClip can't save it for later.") }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let id = UUID().uuidString
        var meta: [String: Any]
        switch item {
        case let .text(text):
            meta = ["kind": "text", "text": text]
        case let .file(name, mime, data):
            try data.write(to: folder.appendingPathComponent("\(id).bin"))
            meta = ["kind": "file", "name": name, "mime": mime, "file": "\(id).bin"]
        }
        meta["createdAt"] = Date().timeIntervalSince1970
        try JSONSerialization.data(withJSONObject: meta).write(to: folder.appendingPathComponent("\(id).json"))
    }
}

import Capacitor
import Foundation
import Security
import WebKit

/// Trusts the OmniClip network's own certificate authority, and nothing else, for HTTPS and WebSocket
/// connections to the hub. The CA is pinned by the web layer at pairing time (checked against the QR code).
@objc(OmniClipPlugin)
public class OmniClipPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OmniClipPlugin"
    public let jsName = "OmniClip"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "trustCa", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
    ]

    private static let appGroup = "group.com.omniclip.app"

    private static var anchor: SecCertificate?

    @objc func trustCa(_ call: CAPPluginCall) {
        guard let pem = call.getString("pem") else {
            call.reject("missing pem")
            return
        }
        let base64 = pem
            .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines)
            .joined()
        guard let der = Data(base64Encoded: base64), let cert = SecCertificateCreateWithData(nil, der as CFData) else {
            call.reject("invalid certificate")
            return
        }
        OmniClipPlugin.anchor = cert
        call.resolve()
    }

    /// Shares the hub address, token, CA, keyring and device list with the share extension (App Group).
    @objc func saveSession(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: OmniClipPlugin.appGroup) else {
            call.reject("App Group unavailable")
            return
        }
        if let session = call.getObject("session"), let data = try? JSONSerialization.data(withJSONObject: session) {
            defaults.set(data, forKey: "session")
        } else {
            defaults.removeObject(forKey: "session")
        }
        call.resolve()
    }

    /// Items the share extension saved for later because the hub wasn't reachable. Each is returned once.
    @objc func take(_ call: CAPPluginCall) {
        var items: [[String: Any]] = []
        let fm = FileManager.default
        if let folder = fm.containerURL(forSecurityApplicationGroupIdentifier: OmniClipPlugin.appGroup)?.appendingPathComponent("Queue", isDirectory: true),
           let names = try? fm.contentsOfDirectory(atPath: folder.path) {
            for name in names.filter({ $0.hasSuffix(".json") }).sorted() {
                let metaURL = folder.appendingPathComponent(name)
                defer { try? fm.removeItem(at: metaURL) }
                guard let data = try? Data(contentsOf: metaURL), let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                if meta["kind"] as? String == "text", let text = meta["text"] as? String {
                    items.append(["kind": "text", "text": text])
                } else if let file = meta["file"] as? String {
                    let fileURL = folder.appendingPathComponent(file)
                    defer { try? fm.removeItem(at: fileURL) }
                    guard let body = try? Data(contentsOf: fileURL) else { continue }
                    items.append(["kind": "file", "name": meta["name"] as? String ?? "file", "mime": meta["mime"] as? String ?? "application/octet-stream", "data": body.base64EncodedString()])
                }
            }
        }
        call.resolve(["items": items, "sendClipboard": false])
    }

    override public func handleWKWebViewURLAuthenticationChallenge(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) -> Bool {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let anchor = OmniClipPlugin.anchor
        else { return false }

        // Ordinary websites keep the system's normal checks.
        if SecTrustEvaluateWithError(trust, nil) { return false }

        SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
        return true
    }
}

/// Capacitor only auto-registers plugins from packages; app-local plugins are registered here.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(OmniClipPlugin())
    }
}

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
        CAPPluginMethod(name: "trustCa", returnType: CAPPluginReturnPromise)
    ]

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

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The share sheet entry: "Send to All devices / <device>", straight to the hub on the local network.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.close = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load(from: extensionContext?.inputItems as? [NSExtensionItem] ?? []) }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading, picking, sending, sent(String), queued, failed(String)
    }

    @Published var phase: Phase = .loading
    @Published var items: [ShareItem] = []
    let session = SharedSession.load()
    var close: () -> Void = {}

    var summary: String {
        let files = items.filter { if case .file = $0 { return true }; return false }.count
        if items.count == 1, case let .file(name, _, _) = items[0] { return name }
        if items.count == 1 { return "this text" }
        return files == items.count ? "\(files) files" : "\(items.count) items"
    }

    var devices: [SharedSession.DeviceInfo] {
        (session?.devices ?? []).filter { $0.id != session?.deviceId }.sorted { ($0.online ?? false) && !($1.online ?? false) }
    }

    func load(from inputs: [NSExtensionItem]) async {
        var found: [ShareItem] = []
        for provider in inputs.flatMap({ $0.attachments ?? [] }) {
            if let item = await Self.item(from: provider) { found.append(item) }
        }
        items = found
        phase = found.isEmpty ? .failed("There's nothing OmniClip can send here.") : session == nil ? .failed("Open OmniClip and pair this iPhone first.") : .picking
    }

    private static func item(from p: NSItemProvider) async -> ShareItem? {
        if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), !p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
           let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
            return .text(url.absoluteString)
        }
        if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), !p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
           let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
            return .text(text)
        }
        let type = p.registeredTypeIdentifiers.compactMap { UTType($0) }.first { $0.conforms(to: .image) } ?? p.registeredTypeIdentifiers.compactMap { UTType($0) }.first { $0.conforms(to: .data) }
        guard let type else { return nil }
        return await withCheckedContinuation { cont in
            _ = p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url, let data = try? Data(contentsOf: url), data.count <= 100 * 1024 * 1024 else { return cont.resume(returning: nil) }
                let name = p.suggestedName.map { $0 + (url.pathExtension.isEmpty ? "" : ".\(url.pathExtension)") } ?? url.lastPathComponent
                cont.resume(returning: .file(name: name, mime: type.preferredMIMEType ?? "application/octet-stream", data: data))
            }
        }
    }

    func send(to device: SharedSession.DeviceInfo?) {
        guard let session else { return }
        phase = .sending
        Task {
            let client = HubClient(session: session)
            do {
                for item in items { try await client.send(item, to: device?.id) }
                phase = .sent(device.map { "Sent to \($0.name)" } ?? "Sent to all devices")
            } catch {
                // not on the home network: keep it for the app to send when it opens
                do {
                    for item in items { try ShareQueue.add(item) }
                    phase = .queued
                } catch {
                    phase = .failed(error.localizedDescription)
                }
            }
            try? await Task.sleep(nanoseconds: 900_000_000)
            close()
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel

    private func icon(_ platform: String) -> String {
        switch platform {
        case "mac": return "laptopcomputer"
        case "windows", "linux": return "desktopcomputer"
        case "ipados": return "ipad"
        case "web": return "globe"
        default: return "iphone"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 14) {
                Capsule().fill(Color.secondary.opacity(0.3)).frame(width: 38, height: 5).frame(maxWidth: .infinity)
                switch model.phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                case .picking:
                    Text("Send \(model.summary)").font(.title3.weight(.semibold)).lineLimit(2)
                    Text("End-to-end encrypted, over your Wi-Fi.").font(.footnote).foregroundStyle(.secondary)
                    Button { model.send(to: nil) } label: {
                        Label("All devices", systemImage: "rectangle.on.rectangle")
                            .font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 50)
                            .foregroundStyle(.white)
                            .background(LinearGradient(colors: [Color(red: 0.36, green: 0.3, blue: 0.94), Color(red: 0.56, green: 0.24, blue: 1)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 14))
                    }
                    if !model.devices.isEmpty {
                        VStack(spacing: 0) {
                            ForEach(model.devices, id: \.id) { d in
                                Button { model.send(to: d) } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: icon(d.platform)).frame(width: 32, height: 32).background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9)).foregroundStyle(Color.accentColor)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(d.name).foregroundStyle(.primary)
                                            Text(d.online == true ? "Online" : "Offline").font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                    }.padding(.horizontal, 14).padding(.vertical, 10)
                                }
                                if d.id != model.devices.last?.id { Divider().padding(.leading, 58) }
                            }
                        }.background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                    }
                    Button("Cancel") { model.close() }.frame(maxWidth: .infinity, minHeight: 44).foregroundStyle(.secondary)
                case .sending:
                    VStack(spacing: 10) { ProgressView(); Text("Sending…").foregroundStyle(.secondary) }.frame(maxWidth: .infinity, minHeight: 120)
                case let .sent(text):
                    Label(text, systemImage: "checkmark.circle.fill").font(.headline).foregroundStyle(.green).frame(maxWidth: .infinity, minHeight: 120)
                case .queued:
                    VStack(spacing: 6) {
                        Label("Saved for later", systemImage: "clock.fill").font(.headline)
                        Text("Your hub isn't reachable right now. OmniClip sends it the next time you open the app.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }.frame(maxWidth: .infinity, minHeight: 120)
                case let .failed(text):
                    VStack(spacing: 10) {
                        Label(text, systemImage: "exclamationmark.triangle.fill").multilineTextAlignment(.center)
                        Button("Close") { model.close() }
                    }.frame(maxWidth: .infinity, minHeight: 120)
                }
            }
            .padding(18)
            .background(Color(.systemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
            .padding(10)
        }
        .background(Color.black.opacity(0.25).ignoresSafeArea())
    }
}

import AppIntents
import SwiftUI
import WidgetKit

// "Send clipboard" in one tap: a home-screen / lock-screen widget and, on iOS 18, a Control Center
// button. iOS only lets the app in front read the clipboard, so both open OmniClip with
// omniclip://send-clipboard; the app sends the clipboard and shows that it's done.

private let sendURL = URL(string: "omniclip://send-clipboard")!

struct SendEntry: TimelineEntry {
    let date: Date
}

struct SendProvider: TimelineProvider {
    func placeholder(in context: Context) -> SendEntry { SendEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (SendEntry) -> Void) { completion(SendEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SendEntry>) -> Void) {
        completion(Timeline(entries: [SendEntry(date: .now)], policy: .never))
    }
}

private let brand = LinearGradient(colors: [Color(red: 0.36, green: 0.3, blue: 0.94), Color(red: 0.56, green: 0.24, blue: 1)], startPoint: .topLeading, endPoint: .bottomTrailing)

struct SendClipboardView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if family == .accessoryCircular {
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "doc.on.clipboard").font(.title3.weight(.semibold))
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "doc.on.clipboard.fill").font(.system(size: 28, weight: .semibold))
                    Spacer()
                    Text("Send clipboard").font(.headline)
                    Text("to all your devices").font(.caption).opacity(0.8)
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        }
        .widgetURL(sendURL)
        .modifier(WidgetBackground(gradient: family != .accessoryCircular))
    }
}

/// iOS 17 wants `containerBackground`; earlier versions paint the background themselves.
struct WidgetBackground: ViewModifier {
    let gradient: Bool
    func body(content: Content) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            content.containerBackground(for: .widget) { gradient ? AnyView(brand) : AnyView(Color.clear) }
        } else {
            content.padding().background(gradient ? AnyView(brand) : AnyView(Color.clear))
        }
    }
}

struct SendClipboardWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SendClipboard", provider: SendProvider()) { _ in SendClipboardView() }
            .configurationDisplayName("Send clipboard")
            .description("Sends what you copied to all your devices.")
            .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}

@available(iOS 18.0, *)
struct OpenSendClipboardIntent: AppIntent {
    static let title: LocalizedStringResource = "Send clipboard"
    static let description = IntentDescription("Opens OmniClip and sends what you copied to all your devices.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(sendURL))
    }
}

@available(iOS 18.0, *)
struct SendClipboardControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.omniclip.app.SendClipboard") {
            ControlWidgetButton(action: OpenSendClipboardIntent()) {
                Label("Send clipboard", systemImage: "doc.on.clipboard")
            }
        }
        .displayName("Send clipboard")
        .description("Sends what you copied to all your devices.")
    }
}

@main
struct OmniClipWidgets: WidgetBundle {
    var body: some Widget {
        SendClipboardWidget()
        if #available(iOS 18.0, *) {
            SendClipboardControl()
        }
    }
}

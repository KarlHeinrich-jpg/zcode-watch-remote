import SwiftUI

struct RootView: View {
    @EnvironmentObject private var settings: BridgeSettings
    @EnvironmentObject private var store: SessionStore

    var body: some View {
        Group {
            if settings.isPaired {
                SessionListView()
            } else {
                PairingView()
            }
        }
        .onAppear { store.connectIfPossible() }
        .onChange(of: settings.host) { store.connectIfPossible() }
    }
}

/// Small colored status dot + label used across the app.
struct StatusBadge: View {
    let status: String
    var waiting: Bool = false

    private var color: Color {
        if waiting { return .orange }
        switch status {
        case "running": return .green
        case "waiting": return .orange
        case "stopped": return .gray
        case "failed", "error": return .red
        default: return .blue
        }
    }

    private var label: String {
        if waiting { return "approval" }
        switch status {
        case "running": return "running"
        case "waiting": return "approval"
        case "idle": return "idle"
        case "stopped": return "stopped"
        case "failed", "error": return "failed"
        default: return status
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(color)
        }
    }
}

import SwiftUI

struct PairingView: View {
    @EnvironmentObject private var settings: BridgeSettings
    @EnvironmentObject private var store: SessionStore

    @State private var host: String = ""
    @State private var pin: String = ""

    private var canPair: Bool { !host.isEmpty && pin.count == 6 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Connect to Bridge")
                    .font(.headline)

                Text("Run `npx zcode-watch-bridge` on your Mac/PC, then enter the address it prints.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)

                TextField("192.168.1.5:8788", text: $host)
                    .textContentType(.URL)
                    .autocorrectionDisabled()

                TextField("6-digit PIN", text: $pin)
                    .textContentType(.oneTimeCode)
                    .autocorrectionDisabled()

                Button {
                    store.pair(hostInput: host, pin: pin)
                } label: {
                    Label("Pair", systemImage: "link")
                        .frame(maxWidth: .infinity)
                }
                .disabled(!canPair)
                .buttonStyle(.borderedProminent)

                ConnectionStatusView()

                if let error = store.lastError {
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 4)
        }
    }
}

/// Shared connection indicator: dot + human-readable state.
struct ConnectionStatusView: View {
    @EnvironmentObject private var store: SessionStore

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.system(size: 12))
        }
        .foregroundStyle(.secondary)
    }

    private var color: Color {
        switch store.connection {
        case .connected: return .green
        case .connecting: return .yellow
        case .waitingToReconnect: return .orange
        case .failed: return .red
        case .idle: return .gray
        }
    }

    private var text: String {
        switch store.connection {
        case .connected: return "Connected"
        case .connecting: return "Connecting…"
        case .waitingToReconnect(let s): return "Retrying in \(s)s"
        case .failed(let m): return m
        case .idle: return "Not connected"
        }
    }
}

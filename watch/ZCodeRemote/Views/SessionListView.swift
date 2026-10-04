import SwiftUI

struct SessionListView: View {
    @EnvironmentObject private var settings: BridgeSettings
    @EnvironmentObject private var store: SessionStore
    @State private var showingNewSession = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ConnectionStatusView()
                    if let banner = store.banner {
                        Text(banner).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }

                if store.sessions.isEmpty {
                    Text(store.isConnected ? "No sessions yet. Start one from your computer, or tap + below." : "Waiting for the bridge…")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                ForEach(store.sessions) { session in
                    NavigationLink {
                        SessionDetailView(sessionId: session.id)
                            .onAppear { store.openSession(session.id) }
                            .onDisappear { store.closeSessionView() }
                    } label: {
                        SessionRow(session: session, unread: store.unread.contains(session.id))
                    }
                }

                Section {
                    Button {
                        showingNewSession = true
                    } label: {
                        Label("New Session", systemImage: "plus.circle")
                    }
                    Button {
                        store.refreshSessions()
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    Button(role: .destructive) {
                        store.unpair()
                    } label: {
                        Label("Unpair", systemImage: "link.badge.plus")
                    }
                }
            }
            .navigationTitle("ZCode")
            .sheet(isPresented: $showingNewSession) {
                NewSessionView()
            }
        }
    }
}

struct SessionRow: View {
    let session: SessionSummary
    let unread: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                if unread { Circle().fill(.blue).frame(width: 6, height: 6) }
                Text(session.displayTitle)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(2)
            }
            HStack(spacing: 6) {
                StatusBadge(status: session.status, waiting: session.waitingApproval)
                if !session.mode.isEmpty {
                    Text(session.mode)
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(.quaternary))
                }
                if !session.projectName.isEmpty {
                    Text(session.projectName)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if !session.lastText.isEmpty {
                Text(session.lastText)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

struct NewSessionView: View {
    @EnvironmentObject private var store: SessionStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Start a session in:").font(.headline)

                if store.projects.isEmpty {
                    Text("No projects configured. Add paths to `allowedProjects` in the bridge config on your computer.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                ForEach(store.projects) { project in
                    Button {
                        store.newSession(in: project.path)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(project.name).font(.system(size: 14, weight: .semibold))
                            Text(project.path)
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                Button("Cancel") { dismiss() }
                    .foregroundStyle(.secondary)
            }
        }
    }
}

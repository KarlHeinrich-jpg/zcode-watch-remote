import SwiftUI

/// One transcript row: text, tool call, approval, status or result.
struct EventRowView: View {
    let event: TranscriptEvent

    var body: some View {
        switch event.kind {
        case "text":
            textRow
        case "thinking":
            thinkingRow
        case "tool":
            toolRow
        case "permission":
            permissionRow
        case "question":
            questionRow
        case "result":
            resultRow
        case "error":
            errorRow
        case "status":
            statusRow
        default:
            EmptyView()
        }
    }

    private var thinkingRow: some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: "brain")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            Text(event.text ?? "")
                .font(.system(size: 11).italic())
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
    }

    private var questionRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "questionmark.bubble").font(.system(size: 10)).foregroundStyle(.blue)
            Text(event.prompt?.isEmpty == false ? (event.prompt ?? "") : "The agent asked a question")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.blue)
                .lineLimit(2)
        }
    }

    private var textRow: some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: event.symbol)
                .font(.system(size: 10))
                .foregroundStyle(event.role == "user" ? Color.accentColor : .secondary)
                .padding(.top, 2)
            Text(event.text ?? "")
                .font(.system(size: 13))
                .foregroundStyle(event.role == "user" ? .primary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 1)
    }

    private var toolRow: some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: event.symbol)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.tool ?? "tool")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                if let detail = event.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            if event.state == "done" {
                Image(systemName: "checkmark").font(.system(size: 9)).foregroundStyle(.green)
            } else {
                ProgressView().controlSize(.mini)
            }
        }
        .padding(5)
        .background(RoundedRectangle(cornerRadius: 7).fill(.quaternary.opacity(0.5)))
    }

    private var permissionRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "hand.raised.fill").font(.system(size: 10)).foregroundStyle(.orange)
            Text("Approval: \(event.tool ?? "tool")")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.orange)
        }
    }

    private var resultRow: some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: event.symbol)
                .font(.system(size: 10))
                .foregroundStyle(event.isError == true ? .red : .green)
                .padding(.top, 2)
            Text(event.text ?? "Done")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }

    private var errorRow: some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: event.symbol).font(.system(size: 10)).foregroundStyle(.red).padding(.top, 2)
            Text(event.message ?? "Error").font(.system(size: 12)).foregroundStyle(.red)
        }
    }

    private var statusRow: some View {
        Text(event.status ?? "")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.vertical, 1)
    }
}

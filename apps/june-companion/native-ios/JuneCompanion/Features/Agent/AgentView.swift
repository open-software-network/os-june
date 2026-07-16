import SwiftUI

struct AgentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        NavigationStack {
            ZStack {
                Color(.systemBackground).ignoresSafeArea()
                VStack(spacing: 0) {
                    if model.messages.isEmpty {
                        emptyState
                    } else {
                        conversation
                    }
                }
            }
            .navigationTitle(currentTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) { composer }
        }
        .accessibilityIdentifier("agent-screen")
    }

    private var currentTitle: String {
        model.snapshot.agentSessions.first(where: { $0.id == model.selectedSessionID })?.title ?? "June"
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Spacer()
            Text("What should we work through?")
                .font(JuneFont.hero)
                .accessibilityAddTraits(.isHeader)
            Text("The agent runs on your Mac. This device receives only the encrypted conversation.")
                .font(JuneFont.body)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 24)
        .juneReadableColumn()
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(model.messages) { message in
                        MessageRow(message: message)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 24)
                .juneReadableColumn()
            }
            .onChange(of: model.messages.count) {
                guard let last = model.messages.last else { return }
                withAnimation(JuneMotion.state) { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if model.snapshot.connection == .offline {
                Text("Your Mac is offline. Messages will not be queued.")
                    .font(JuneFont.footnote)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message June", text: $model.draft, axis: .vertical)
                    .font(JuneFont.body)
                    .lineLimit(1...6)
                    .padding(.leading, 16)
                    .padding(.vertical, 12)
                    .accessibilityIdentifier("agent-composer")

                if isRunning {
                    Button(action: model.cancelAgent) {
                        Image(systemName: "stop.fill")
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Cancel agent run")
                } else {
                    Button(action: model.sendMessage) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(canSend ? Color(.systemBackground) : .secondary)
                            .frame(width: 44, height: 44)
                            .background(canSend ? Color.primary : Color(.secondarySystemFill), in: Circle())
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                }
            }
            .padding(.trailing, 4)
            .juneComposerSurface()
        }
        .padding(.horizontal, 24)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.bar)
    }

    private var isRunning: Bool {
        model.snapshot.agentSessions.first(where: { $0.id == model.selectedSessionID })?.status == .running
    }

    private var canSend: Bool {
        model.snapshot.connection == .ready
            && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.isWorking
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button("New chat", action: model.startNewChat)
                if !model.snapshot.agentSessions.isEmpty {
                    Section("Recent") {
                        ForEach(model.snapshot.agentSessions) { session in
                            Button {
                                model.openAgentSession(session)
                            } label: {
                                Label(session.title, systemImage: session.status.systemImage)
                            }
                        }
                    }
                }
            } label: {
                Image(systemName: "sidebar.left")
            }
            .accessibilityLabel("Open conversation history")
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            ConnectionLabel(state: model.snapshot.connection)
            Button(action: model.focusMac) {
                Image(systemName: "arrow.up.forward.app")
            }
            .disabled(model.snapshot.connection != .ready)
            .accessibilityLabel("Open on Mac")
        }
    }
}

private struct MessageRow: View {
    let message: AgentMessageModel

    var body: some View {
        HStack {
            if message.role == "user" { Spacer(minLength: 44) }
            VStack(alignment: .leading, spacing: 6) {
                Text(message.text)
                    .font(JuneFont.body)
                    .textSelection(.enabled)
                if message.streaming {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityLabel("June is responding")
                }
            }
            .padding(message.role == "user" ? 14 : 0)
            .background(
                message.role == "user" ? Color(.secondarySystemBackground) : .clear,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            if message.role != "user" { Spacer(minLength: 44) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.role == "user" ? "You" : "June"): \(message.text)")
    }
}

private extension AgentStatusModel {
    var systemImage: String {
        switch self {
        case .running: "circle.dotted"
        case .waitingForUser: "person.crop.circle.badge.questionmark"
        case .completed: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .cancelled: "xmark.circle"
        case .idle: "circle"
        }
    }
}

import SwiftUI

struct AgentView: View {
    @ObservedObject var model: AppModel
    let openNavigation: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visibleMessageID: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color(.systemBackground).ignoresSafeArea()
                VStack(spacing: 0) {
                    if !model.messages.isEmpty {
                        conversation
                    } else {
                        Spacer()
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
        model.snapshot.agentSessions.first(where: { $0.id == model.selectedStoredSessionID })?.title ?? "June"
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    if model.hasEarlierMessages {
                        Button("Load earlier messages", action: model.loadEarlierMessages)
                            .font(JuneFont.subheadline)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.isWorking)
                    }
                    ForEach(model.messages) { message in
                        MessageRow(message: message)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
                .juneReadableColumn()
                .scrollTargetLayout()
            }
            .scrollPosition(id: $visibleMessageID)
            .onChange(of: model.messages.last?.id) {
                guard let last = model.messages.last else { return }
                withAnimation(JuneMotion.animation(.response, reduceMotion: reduceMotion)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
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
                TextField("Ask June", text: $model.draft, axis: .vertical)
                    .font(JuneFont.body)
                    .lineLimit(1...6)
                    .padding(.leading, 16)
                    .padding(.vertical, 12)
                    .accessibilityIdentifier("agent-composer")

                if isRunning {
                    Button(action: model.cancelAgent) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color(.systemBackground))
                            .frame(width: 36, height: 36)
                            .background(Color(.label), in: Circle())
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(JunePressButtonStyle())
                    .accessibilityLabel("Cancel agent run")
                } else {
                    Button(action: model.sendMessage) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(canSend ? Color(.systemBackground) : .secondary)
                            .frame(width: 36, height: 36)
                            .background(canSend ? Color.primary : Color(.secondarySystemFill), in: Circle())
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(JunePressButtonStyle())
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                }
            }
            .padding(.trailing, 4)
            .juneComposerSurface()
        }
        .padding(.horizontal, 32)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    private var isRunning: Bool {
        model.snapshot.agentSessions.first(where: { $0.id == model.selectedStoredSessionID })?.status == .running
    }

    private var canSend: Bool {
        model.snapshot.connection == .ready
            && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.isWorking
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if let openNavigation {
            ToolbarItem(placement: .topBarLeading) {
              Button(action: openNavigation) {
                Image(systemName: "sidebar.left")
                    .frame(width: 44, height: 44)
              }
              .buttonStyle(JunePressButtonStyle())
              .accessibilityLabel("Open navigation")
            }
        }
        ToolbarItem(placement: .principal) {
            JuneBrandLockup(compact: true)
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button(action: model.startNewChat) {
                Image(systemName: "square.and.pencil")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(JunePressButtonStyle())
            .disabled(model.isWorking)
            .accessibilityLabel("New chat")
            Button(action: model.focusMac) {
                Image(systemName: "arrow.up.forward.app")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(JunePressButtonStyle())
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

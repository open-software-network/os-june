import SwiftUI

private enum CompanionSheet: String, Identifiable {
  case notes
  case settings

  var id: String { rawValue }
}

struct RootView: View {
  @ObservedObject var model: AppModel

  @AppStorage("companion.appearance") private var storedAppearance = JuneAppearance.system.rawValue
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var presentedSheet: CompanionSheet?
  @State private var isHistoryOpen = false
  @State private var historyDrag: CGFloat = 0
  @State private var edgeDrag: CGFloat = 0

  var body: some View {
    content
      .font(JuneFont.body)
      .tint(.primary)
      .preferredColorScheme(selectedAppearance.colorScheme)
      .sheet(item: $presentedSheet) { sheet in
        switch sheet {
        case .notes:
          NotesView(model: model, openNavigation: nil)
        case .settings:
          SettingsView(model: model, openNavigation: nil)
        }
      }
      .overlay(alignment: .top) {
        if let error = model.errorMessage {
          ErrorBanner(message: error, dismiss: model.clearError)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
      }
      .animation(
        JuneMotion.animation(.content, reduceMotion: reduceMotion),
        value: model.errorMessage
      )
  }

  private var selectedAppearance: JuneAppearance {
    JuneAppearance(rawValue: storedAppearance) ?? .system
  }

  @ViewBuilder
  private var content: some View {
    if model.isStarting {
      ProgressStateView(title: "Opening June", detail: "Restoring this device securely.")
    } else {
      switch model.snapshot.connection {
      case .unpaired, .revoked:
        PairingView(model: model)
      case .locked:
        LockView(model: model)
      case .connecting:
        ProgressStateView(title: "Connecting securely", detail: "Verifying your Mac and this device.")
          .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.isPairing {
              Button("Cancel pairing", action: model.cancelPairing)
                .buttonStyle(JuneSecondaryButtonStyle())
                .padding(20)
                .accessibilityIdentifier("cancel-pairing")
            }
          }
      case .error:
        FailureStateView(model: model)
      case .ready, .offline:
        companionExperience
      }
    }
  }

  private var companionExperience: some View {
    GeometryReader { geometry in
      let width = min(380, geometry.size.width - 44)
      let visible = isHistoryOpen || edgeDrag > 0
      let progress = historyVisibility(width: width)

      ZStack(alignment: .leading) {
        AgentView(model: model, openNavigation: openHistory)
          .allowsHitTesting(!visible)
          .accessibilityHidden(visible)

        Color.black.opacity(0.14 * progress)
          .ignoresSafeArea()
          .contentShape(Rectangle())
          .onTapGesture(perform: closeHistory)
          .allowsHitTesting(visible)
          .accessibilityHidden(true)

        HistorySidebar(
          model: model,
          close: closeHistory,
          openNotes: { openSheet(.notes) },
          openSettings: { openSheet(.settings) }
        )
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Color(.systemBackground))
        .shadow(color: .black.opacity(0.12 * progress), radius: 24, x: 8)
        .offset(x: historyOffset(width: width))
        .gesture(historyDragGesture(width: width))
        .accessibilityHidden(!visible)
      }
      .clipped()
      .simultaneousGesture(edgeSwipe(width: width))
    }
  }

  private func openHistory() {
    withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
      isHistoryOpen = true
    }
  }

  private func closeHistory() {
    withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
      isHistoryOpen = false
      historyDrag = 0
      edgeDrag = 0
    }
  }

  private func openSheet(_ sheet: CompanionSheet) {
    closeHistory()
    presentedSheet = sheet
  }

  private func historyVisibility(width: CGFloat) -> Double {
    guard width > 0 else { return 0 }
    if isHistoryOpen { return Double(max(0, 1 + historyDrag / width)) }
    return Double(min(1, edgeDrag / width))
  }

  private func historyOffset(width: CGFloat) -> CGFloat {
    if isHistoryOpen { return historyDrag }
    return -width + min(width, edgeDrag)
  }

  private func historyDragGesture(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 8)
      .onChanged { value in
        guard isHistoryOpen else { return }
        historyDrag = min(0, value.translation.width)
      }
      .onEnded { value in
        guard isHistoryOpen else { return }
        if value.translation.width < -(width * 0.24)
          || value.predictedEndTranslation.width < -(width * 0.32)
        {
          closeHistory()
        } else {
          withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
            historyDrag = 0
          }
        }
      }
  }

  private func edgeSwipe(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 16)
      .onChanged { value in
        guard !isHistoryOpen, value.startLocation.x <= 24, value.translation.width > 0 else {
          return
        }
        edgeDrag = min(width, value.translation.width)
      }
      .onEnded { value in
        guard !isHistoryOpen, edgeDrag > 0 else { return }
        let shouldOpen = value.translation.width >= width * 0.24
          || value.predictedEndTranslation.width >= width * 0.32
        withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
          isHistoryOpen = shouldOpen
          edgeDrag = 0
        }
      }
  }
}

private struct HistorySidebar: View {
  @ObservedObject var model: AppModel
  let close: () -> Void
  let openNotes: () -> Void
  let openSettings: () -> Void

  var body: some View {
    NavigationStack {
      List {
        Section {
          Button {
            model.startNewChat()
            close()
          } label: {
            Label("New chat", systemImage: "square.and.pencil")
          }
          .disabled(model.isWorking)
        }

        if !model.snapshot.agentSessions.isEmpty {
          Section("Recent chats") {
            ForEach(model.snapshot.agentSessions.prefix(30)) { session in
              Button {
                model.openAgentSession(session)
                close()
              } label: {
                HStack(spacing: 10) {
                  Image(systemName: session.status.systemImage)
                    .foregroundStyle(.secondary)
                  Text(session.title)
                    .lineLimit(1)
                  Spacer(minLength: 0)
                }
              }
              .foregroundStyle(.primary)
              .disabled(model.isWorking)
            }
          }
        }

        Section {
          Button(action: openNotes) {
            Label("Notes", systemImage: "note.text")
          }
          Button(action: openSettings) {
            Label("Settings", systemImage: "gearshape")
          }
        }
      }
      .listStyle(.sidebar)
      .navigationTitle("June")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(action: close) {
            Image(systemName: "xmark")
          }
          .accessibilityLabel("Close history")
        }
      }
      .safeAreaInset(edge: .bottom) {
        HStack(spacing: 10) {
          VStack(alignment: .leading, spacing: 2) {
            Text("June Desktop")
              .font(JuneFont.subheadline)
              .lineLimit(1)
            ConnectionLabel(state: model.snapshot.connection)
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.bar)
      }
    }
    .accessibilityIdentifier("history-sidebar")
  }
}

private struct ProgressStateView: View {
  let title: String
  let detail: String

  var body: some View {
    ZStack {
      Color(.systemBackground).ignoresSafeArea()
      VStack(spacing: 16) {
        ProgressView()
          .controlSize(.small)
        Text(title)
          .font(JuneFont.title)
        Text(detail)
          .font(JuneFont.body)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      .padding(24)
    }
  }
}

private struct FailureStateView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    ContentUnavailableView {
      Label("June is unavailable", systemImage: "exclamationmark.triangle")
    } description: {
      Text(model.snapshot.message ?? "Try connecting again.")
    } actions: {
      Button("Try again") { Task { await model.refresh() } }
        .buttonStyle(.borderedProminent)
    }
    .padding(24)
  }
}

private struct ErrorBanner: View {
  let message: String
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "exclamationmark.circle")
        .accessibilityHidden(true)
      Text(message)
        .font(JuneFont.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button(action: dismiss) {
        Image(systemName: "xmark")
          .frame(width: JuneMetrics.minimumTapTarget, height: JuneMetrics.minimumTapTarget)
      }
      .buttonStyle(JunePressButtonStyle())
      .accessibilityLabel("Dismiss error")
    }
    .padding(.leading, 16)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .shadow(color: .black.opacity(0.1), radius: 16, y: 6)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isStaticText)
  }
}

extension AgentStatusModel {
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

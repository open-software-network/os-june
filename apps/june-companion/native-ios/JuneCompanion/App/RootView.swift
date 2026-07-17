import SwiftUI

struct RootView: View {
  @ObservedObject var model: AppModel

  @AppStorage("companion.appearance") private var storedAppearance = JuneAppearance.system.rawValue
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @State private var isNavigationOpen = false
  @State private var navigationDrag: CGFloat = 0
  @State private var edgeDrag: CGFloat = 0

  var body: some View {
    content
      .font(JuneFont.body)
      .tint(.primary)
      .preferredColorScheme(selectedAppearance.colorScheme)
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
    switch model.snapshot.connection {
    case .signedOut, .unpaired:
      OnboardingView(model: model)
    case .revoked:
      PairingView(model: model)
    case .locked:
      LockView(model: model)
    case .connecting:
      ProgressStateView(title: "Connecting securely", detail: "Verifying your Mac and this device.")
    case .error:
      FailureStateView(model: model)
    case .ready, .offline:
      companionExperience
    }
  }

  @ViewBuilder
  private var companionExperience: some View {
    if horizontalSizeClass == .regular {
      NavigationSplitView {
        CompanionNavigationSidebar(
          model: model,
          close: nil,
          select: select
        )
        .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
      } detail: {
        destination(for: model.selection, openNavigation: nil)
      }
    } else {
      compactExperience
    }
  }

  private var compactExperience: some View {
    GeometryReader { geometry in
      let width = min(380, geometry.size.width - 44)
      let visible = isNavigationOpen || edgeDrag > 0
      let progress = navigationVisibility(width: width)

      ZStack(alignment: .leading) {
        destination(for: model.selection) {
          withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
            isNavigationOpen = true
          }
        }

        if visible {
          Color.black.opacity(0.2 * progress)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { closeNavigation() }
            .accessibilityLabel("Close navigation")
            .accessibilityAddTraits(.isButton)
        }

        CompanionNavigationSidebar(
          model: model,
          close: closeNavigation,
          select: select
        )
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Color(.systemBackground))
        .shadow(color: .black.opacity(0.16 * progress), radius: 24, x: 8)
        .offset(x: navigationOffset(width: width))
        .gesture(
          DragGesture(minimumDistance: 8)
            .onChanged { value in
              guard isNavigationOpen else { return }
              navigationDrag = min(0, value.translation.width)
            }
            .onEnded { value in
              guard isNavigationOpen else { return }
              if value.translation.width < -(width * 0.24)
                || value.predictedEndTranslation.width < -(width * 0.32)
              {
                closeNavigation()
              } else {
                withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
                  navigationDrag = 0
                }
              }
            }
        )
        .accessibilityHidden(!visible)
      }
      .clipped()
      .simultaneousGesture(edgeSwipe(width: width))
    }
  }

  private func edgeSwipe(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 16)
      .onChanged { value in
        guard !isNavigationOpen, value.startLocation.x <= 24, value.translation.width > 0 else {
          return
        }
        edgeDrag = min(width, value.translation.width)
      }
      .onEnded { value in
        guard !isNavigationOpen, edgeDrag > 0 else { return }
        let shouldOpen = value.translation.width >= width * 0.24
          || value.predictedEndTranslation.width >= width * 0.32
        withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
          isNavigationOpen = shouldOpen
          edgeDrag = 0
        }
      }
  }

  private func navigationVisibility(width: CGFloat) -> Double {
    guard width > 0 else { return 0 }
    if isNavigationOpen { return Double(max(0, 1 + navigationDrag / width)) }
    return Double(min(1, edgeDrag / width))
  }

  private func navigationOffset(width: CGFloat) -> CGFloat {
    if isNavigationOpen { return navigationDrag }
    return -width + min(width, edgeDrag)
  }

  private func closeNavigation() {
    withAnimation(JuneMotion.animation(.presentation, reduceMotion: reduceMotion)) {
      isNavigationOpen = false
      navigationDrag = 0
      edgeDrag = 0
    }
  }

  private func select(_ section: AppSection) {
    model.selection = section
    closeNavigation()
  }

  @ViewBuilder
  private func destination(for section: AppSection, openNavigation: (() -> Void)?) -> some View {
    switch section {
    case .agent:
      AgentView(model: model, openNavigation: openNavigation)
    case .notes:
      NotesView(model: model, openNavigation: openNavigation)
    case .settings:
      SettingsView(model: model, openNavigation: openNavigation)
    }
  }
}

private struct CompanionNavigationSidebar: View {
  @ObservedObject var model: AppModel
  let close: (() -> Void)?
  let select: (AppSection) -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        JuneBrandLockup(compact: true)
        Spacer()
        if let close {
          Button(action: close) {
            Image(systemName: "xmark")
              .font(.system(size: 15, weight: .medium))
              .frame(width: JuneMetrics.minimumTapTarget, height: JuneMetrics.minimumTapTarget)
          }
          .buttonStyle(JunePressButtonStyle())
          .accessibilityLabel("Close navigation")
        }
      }
      .padding(.horizontal, 18)
      .padding(.top, 12)

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          Button {
            model.startNewChat()
            select(.agent)
          } label: {
            Label("New chat", systemImage: "square.and.pencil")
              .font(JuneFont.subheadline.weight(.medium))
              .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
              .padding(.horizontal, 14)
              .background(
                Color(.secondarySystemFill),
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
              )
          }
          .foregroundStyle(.primary)
          .buttonStyle(JunePressButtonStyle())
          .disabled(model.isWorking)

          VStack(spacing: 4) {
            ForEach(AppSection.allCases) { section in
              Button { select(section) } label: {
                HStack(spacing: 12) {
                  Image(systemName: section.systemImage)
                    .frame(width: 22)
                  Text(section.title)
                  Spacer()
                }
                .font(JuneFont.subheadline)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(
                  model.selection == section ? Color(.secondarySystemFill) : Color.clear,
                  in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
              }
              .foregroundStyle(.primary)
              .buttonStyle(.plain)
              .accessibilityAddTraits(model.selection == section ? .isSelected : [])
            }
          }

          if !model.snapshot.agentSessions.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
              Text("Recent chats")
                .font(JuneFont.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 12)

              ForEach(model.snapshot.agentSessions.prefix(12)) { session in
                Button {
                  model.openAgentSession(session)
                  select(.agent)
                } label: {
                  HStack(spacing: 10) {
                    Image(systemName: session.status.systemImage)
                      .foregroundStyle(.secondary)
                    Text(session.title)
                      .lineLimit(1)
                    Spacer(minLength: 0)
                  }
                  .font(JuneFont.subheadline)
                  .padding(.horizontal, 12)
                  .frame(minHeight: 46)
                  .contentShape(Rectangle())
                }
                .foregroundStyle(.primary)
                .buttonStyle(.plain)
                .disabled(model.isWorking)
              }
            }
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 16)
      }

      VStack(alignment: .leading, spacing: 7) {
        Divider()
        ConnectionLabel(state: model.snapshot.connection)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 18)
      .padding(.bottom, 14)
      .background(.bar)
    }
    .accessibilityIdentifier("companion-navigation")
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

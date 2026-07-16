import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
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
        .font(JuneFont.body)
        .tint(.primary)
        .overlay(alignment: .top) {
            if let error = model.errorMessage {
                ErrorBanner(message: error, dismiss: model.clearError)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(JuneMotion.state, value: model.errorMessage)
    }

    @ViewBuilder
    private var companionExperience: some View {
        if horizontalSizeClass == .regular {
            NavigationSplitView {
                List {
                    ForEach(AppSection.allCases) { section in
                        Button {
                            model.selection = section
                        } label: {
                            Label(section.title, systemImage: section.systemImage)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(
                            model.selection == section ? Color(.secondarySystemBackground) : Color.clear
                        )
                        .accessibilityAddTraits(model.selection == section ? .isSelected : [])
                    }
                }
                .navigationTitle("June")
                .safeAreaInset(edge: .bottom) {
                    ConnectionLabel(state: model.snapshot.connection)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(.bar)
                }
            } detail: {
                destination(for: model.selection)
            }
        } else {
            TabView(selection: $model.selection) {
                destination(for: .agent)
                    .tabItem { Label("Agent", systemImage: AppSection.agent.systemImage) }
                    .tag(AppSection.agent)
                destination(for: .notes)
                    .tabItem { Label("Notes", systemImage: AppSection.notes.systemImage) }
                    .tag(AppSection.notes)
                destination(for: .settings)
                    .tabItem { Label("Settings", systemImage: AppSection.settings.systemImage) }
                    .tag(AppSection.settings)
            }
        }
    }

    @ViewBuilder
    private func destination(for section: AppSection) -> some View {
        switch section {
        case .agent: AgentView(model: model)
        case .notes: NotesView(model: model)
        case .settings: SettingsView(model: model)
        }
    }
}

private struct ProgressStateView: View {
    let title: String
    let detail: String

    var body: some View {
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
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Dismiss error")
        }
        .padding(.leading, 16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(0.1), radius: 16, y: 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

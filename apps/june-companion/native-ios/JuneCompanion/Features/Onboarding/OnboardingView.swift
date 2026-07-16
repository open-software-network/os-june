import SwiftUI

struct OnboardingView: View {
    @ObservedObject var model: AppModel

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @State private var showsManualPairing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    JuneBrandLockup()

                    VStack(alignment: .leading, spacing: 14) {
                        Text("Connect to June on your Mac")
                            .font(JuneFont.hero)
                            .accessibilityAddTraits(.isHeader)
                        Text("Scan a pairing code from your signed-in desktop app. No separate account sign-in is needed here.")
                            .font(JuneFont.body)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(spacing: 0) {
                        OnboardingFact(
                            systemImage: "desktopcomputer",
                            title: "Start on your Mac",
                            detail: "Open Settings, then Linked devices"
                        )
                        Divider()
                        OnboardingFact(
                            systemImage: "lock",
                            title: "Approved by your Mac",
                            detail: "Every linked device has its own revocable key"
                        )
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 36)
                .padding(.bottom, 28)
                .juneReadableColumn()
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared || reduceMotion ? 0 : 10)
                .juneAnimation(JuneMotion.presentation, value: appeared, reduceMotion: reduceMotion)
            }
            .safeAreaInset(edge: .bottom) {
                VStack {
                    VStack(spacing: 10) {
                        Button(action: model.scanAndPair) {
                            JunePrimaryButtonLabel(title: "Scan pairing code", systemImage: "qrcode.viewfinder")
                        }
                        .buttonStyle(JuneSolidButtonStyle())
                        .disabled(model.isWorking)
                        .accessibilityIdentifier("scan-pairing-code")

#if targetEnvironment(simulator)
                        Button("Enter code for simulator") { showsManualPairing = true }
                            .buttonStyle(JuneSecondaryButtonStyle())
#endif

                        Text("Your Mac authorizes this device without sharing its account session.")
                            .font(JuneFont.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 14)
                    .padding(.bottom, 8)
                    .juneReadableColumn()
                }
                .frame(maxWidth: .infinity)
                .background(.bar)
            }
            .task { appeared = true }
        }
        .sheet(isPresented: $showsManualPairing) {
            ManualPairingSheet { payload in
                model.pair(pastedPayload: payload)
                showsManualPairing = false
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        .accessibilityIdentifier("onboarding-screen")
    }
}

private struct OnboardingFact: View {
    let systemImage: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 26)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(JuneFont.headline)
                Text(detail).font(JuneFont.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }
}

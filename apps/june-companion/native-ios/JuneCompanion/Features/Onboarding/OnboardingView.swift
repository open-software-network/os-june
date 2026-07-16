import SwiftUI

struct OnboardingView: View {
  @ObservedObject var model: AppModel

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var appeared = false
  @State private var showsManualPairing = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 32) {
          JuneBrandLockup()

          VStack(alignment: .leading, spacing: 14) {
            Text("Your June, nearby.")
              .font(JuneFont.hero)
              .accessibilityAddTraits(.isHeader)
            Text("Connect this device to the June app already signed in on your Mac.")
              .font(JuneFont.body)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(alignment: .leading, spacing: 20) {
            OnboardingStatement(
              systemImage: "desktopcomputer",
              title: "Start on your Mac",
              detail: "Open Settings, then Linked devices, and show a new pairing code."
            )
            OnboardingStatement(
              systemImage: "qrcode.viewfinder",
              title: "Scan and approve",
              detail: "Scan the code here, then confirm this device on your Mac."
            )
            OnboardingStatement(
              systemImage: "lock",
              title: "A key for this device",
              detail: "Your Mac account session is never copied. This device gets its own revocable key."
            )
          }
        }
        .padding(.horizontal, 24)
        .padding(.top, 36)
        .padding(.bottom, 28)
        .juneReadableColumn()
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared || reduceMotion ? 0 : 10)
        .juneAnimation(.presentation, value: appeared, reduceMotion: reduceMotion)
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 10) {
          Button(action: model.scanAndPair) {
            JunePrimaryButtonLabel(
              title: model.isWorking ? "Connecting" : "Scan pairing code",
              systemImage: model.isWorking ? nil : "qrcode.viewfinder"
            )
          }
          .buttonStyle(JuneSolidButtonStyle())
          .disabled(model.isWorking)
          .accessibilityIdentifier("scan-pairing-code")

#if targetEnvironment(simulator)
          Button("Enter code for simulator") { showsManualPairing = true }
            .buttonStyle(JuneSecondaryButtonStyle())
#endif

          Text("No separate sign-in. Your Mac authorizes this device for its signed-in account.")
            .font(JuneFont.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 24)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .juneReadableColumn()
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

private struct OnboardingStatement: View {
  let systemImage: String
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: systemImage)
        .font(.system(size: 17, weight: .regular))
        .foregroundStyle(.secondary)
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(JuneFont.headline)
        Text(detail)
          .font(JuneFont.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

import SwiftUI

struct OnboardingView: View {
  @ObservedObject var model: AppModel

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var appeared = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          JuneBrandLockup()

          VStack(alignment: .leading, spacing: 14) {
            Text("Your June, wherever you are.")
              .font(JuneFont.hero)
              .accessibilityAddTraits(.isHeader)
            Text("Sign in with OS Accounts, then link the June app on your Mac.")
              .font(JuneFont.body)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(spacing: 0) {
            AccountFact(
              systemImage: "person.crop.circle",
              title: "Your account",
              detail: "The system browser handles sign-in"
            )
            Divider()
            AccountFact(
              systemImage: "desktopcomputer",
              title: "Your Mac approves",
              detail: "Sign-in alone cannot control June Desktop"
            )
            Divider()
            AccountFact(
              systemImage: "lock",
              title: "End-to-end encrypted",
              detail: "The relay cannot read notes or chats"
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
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 10) {
          Button(action: model.signIn) {
            JunePrimaryButtonLabel(
              title: model.isWorking ? "Opening OS Accounts" : "Continue with OS Accounts",
              systemImage: model.isWorking ? nil : "arrow.up.right"
            )
          }
          .buttonStyle(JuneSolidButtonStyle())
          .disabled(model.isWorking || !model.isAccountSignInConfigured)
          .accessibilityIdentifier("os-accounts-sign-in")

          if !model.isAccountSignInConfigured {
            Text("This build needs its June Companion OAuth client ID.")
              .font(JuneFont.footnote)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }
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
    .accessibilityIdentifier("onboarding-screen")
  }
}

private struct AccountFact: View {
  let systemImage: String
  let title: String
  let detail: String

  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: systemImage)
        .font(.system(size: 17, weight: .regular))
        .frame(width: 26)
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(JuneFont.headline)
        Text(detail)
          .font(JuneFont.subheadline)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 16)
    .accessibilityElement(children: .combine)
  }
}

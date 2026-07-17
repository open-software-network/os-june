import SwiftUI

struct PairingView: View {
    @ObservedObject var model: AppModel
    @State private var showsManualPairing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    JuneBrandLockup()
                    VStack(alignment: .leading, spacing: 14) {
                        Text(model.snapshot.connection == .revoked ? "Connect June again" : "Connect to June on your Mac")
                            .font(JuneFont.hero)
                            .accessibilityAddTraits(.isHeader)
                        Text("Scan or enter a code from a signed-in June Desktop. Your Mac will approve this device and grant only companion access.")
                            .font(JuneFont.body)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(alignment: .leading, spacing: 18) {
                        PairingStep(number: "1", text: "Open Settings, then Linked devices on your Mac")
                        PairingStep(number: "2", text: "Show a new pairing code, then scan or enter it here")
                        PairingStep(number: "3", text: "Approve this device on your Mac")
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 36)
                .padding(.bottom, 28)
                .juneReadableColumn()
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 10) {
                    if model.isWorking {
                        Button("Cancel pairing", action: model.cancelPairing)
                            .buttonStyle(JuneSecondaryButtonStyle())
                            .accessibilityIdentifier("cancel-pairing")
                    } else {
                        Button(action: model.scanAndPair) {
                            JunePrimaryButtonLabel(title: "Scan pairing code", systemImage: "qrcode.viewfinder")
                        }
                        .buttonStyle(JuneSolidButtonStyle())
                        .accessibilityIdentifier("scan-pairing-code")

                        Button("Enter pairing code") { showsManualPairing = true }
                            .buttonStyle(JuneSecondaryButtonStyle())
                            .accessibilityIdentifier("enter-pairing-code")
                    }
                    Text("The code expires after five minutes. Your Mac must approve this device before it can connect.")
                        .font(JuneFont.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)
                .padding(.top, 14)
                .padding(.bottom, 8)
                .juneReadableColumn()
                .frame(maxWidth: .infinity)
                .background(.bar)
            }
            .sheet(isPresented: $showsManualPairing) {
                ManualPairingSheet { pairingCode in
                    model.pair(pairingCode: pairingCode)
                    showsManualPairing = false
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
        }
        .accessibilityIdentifier("pairing-screen")
    }
}

private struct PairingStep: View {
    let number: String
    let text: String

    var body: some View {
        HStack(spacing: 14) {
            Text(number)
                .font(JuneFont.mono)
                .foregroundStyle(.secondary)
                .frame(width: 26, height: 26)
                .background(Color(.secondarySystemFill), in: Circle())
            Text(text).font(JuneFont.body)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

struct ManualPairingSheet: View {
    let submit: (String) -> Void
    @State private var pairingCode = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Enter or paste the pairing code shown by June Desktop.")
                    .foregroundStyle(.secondary)
                TextEditor(text: $pairingCode)
                    .font(JuneFont.mono)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .padding(12)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Pairing code")
                    .accessibilityIdentifier("manual-pairing-code")
                Button("Pair this device") { submit(pairingCode) }
                    .buttonStyle(JuneSolidButtonStyle())
                    .disabled(pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(24)
            .navigationTitle("Enter pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

struct LockView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock")
                .font(.system(size: 30, weight: .regular))
                .accessibilityHidden(true)
            Text("June is locked")
                .font(JuneFont.title)
            Text("Unlock to decrypt the latest data from your Mac.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: model.unlock) {
                JunePrimaryButtonLabel(title: "Unlock", systemImage: "faceid")
            }
            .buttonStyle(JuneSolidButtonStyle())
            .disabled(model.isWorking)
        }
        .padding(24)
        .juneReadableColumn()
        .accessibilityIdentifier("lock-screen")
    }
}

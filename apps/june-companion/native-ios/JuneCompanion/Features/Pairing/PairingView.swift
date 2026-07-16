import SwiftUI

struct PairingView: View {
    @ObservedObject var model: AppModel
    @State private var showsManualPairing = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 28) {
                JuneBrandLockup()
                VStack(alignment: .leading, spacing: 12) {
                    Text(model.snapshot.connection == .revoked ? "Link this device again" : "Link this device")
                        .font(JuneFont.hero)
                        .accessibilityAddTraits(.isHeader)
                    Text("On your Mac, open June Settings, choose Linked devices, and show a pairing code.")
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 0) {
                    PairingStep(number: "1", text: "Show a pairing code on your Mac")
                    Divider()
                    PairingStep(number: "2", text: "Scan it with this device")
                    Divider()
                    PairingStep(number: "3", text: "Review and approve the device on your Mac")
                }

                Spacer(minLength: 20)

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

            }
            .padding(24)
            .juneReadableColumn()
            .sheet(isPresented: $showsManualPairing) {
                ManualPairingSheet { payload in
                    model.pair(pastedPayload: payload)
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
                .background(Color(.secondarySystemBackground), in: Circle())
            Text(text).font(JuneFont.body)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }
}

struct ManualPairingSheet: View {
    let submit: (String) -> Void
    @State private var payload = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Paste the pairing payload shown by your local test Mac.")
                    .foregroundStyle(.secondary)
                TextEditor(text: $payload)
                    .font(JuneFont.mono)
                    .padding(12)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                Button("Pair this simulator") { submit(payload) }
                    .buttonStyle(JuneSecondaryButtonStyle())
                    .disabled(payload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(24)
            .navigationTitle("Simulator pairing")
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

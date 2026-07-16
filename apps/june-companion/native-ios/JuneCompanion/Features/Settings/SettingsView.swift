import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var confirmsRevoke = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    LabeledContent("June Desktop") {
                        ConnectionLabel(state: model.snapshot.connection)
                    }
                    Button("Open June on Mac", action: model.focusMac)
                        .disabled(model.snapshot.connection != .ready)
                }

                if let settings = model.snapshot.safeSettings {
                    Section {
                        Picker("Dictation style", selection: dictationStyleBinding) {
                            Text("Standard").tag("standard")
                            Text("Casual lowercase").tag("casualLowercase")
                            Text("Formal").tag("formal")
                        }
                        Toggle("Safer image handling", isOn: imageSafeModeBinding)
                    } header: {
                        Text("Safe settings")
                    } footer: {
                        Text("Only this allowlisted subset can be changed from a companion device.")
                    }
                    .disabled(model.snapshot.connection != .ready || model.isWorking)
                    .id(settings.dictationStyle + String(settings.imageSafeMode))
                }

                if let recording = model.snapshot.activeRecording {
                    Section {
                        LabeledContent("Status", value: recording.state.capitalized)
                        if recording.state == "paused" {
                            Button("Resume recording") { model.controlRecording("resume") }
                        } else {
                            Button("Pause recording") { model.controlRecording("pause") }
                        }
                        Button("Stop recording", role: .destructive) { model.controlRecording("stop") }
                    } header: {
                        Text("Active recording")
                    } footer: {
                        Text("A companion can control an existing recording, but it cannot start one.")
                    }
                    .disabled(model.snapshot.connection != .ready || model.isWorking)
                }

                Section {
                    if let device = model.snapshot.device {
                        LabeledContent("Name", value: device.displayName)
                        LabeledContent("Linked", value: device.linkedAt)
                        if let lastSeen = device.lastSeenAt {
                            LabeledContent("Last seen", value: lastSeen)
                        }
                        LabeledContent("Device ID") {
                            Text(device.deviceId)
                                .font(JuneFont.mono)
                                .textSelection(.enabled)
                        }
                    } else {
                        Text("Device details are available when your Mac is online.")
                            .foregroundStyle(.secondary)
                    }
                    Button("Revoke this device", role: .destructive) { confirmsRevoke = true }
                } header: {
                    Text("This linked device")
                } footer: {
                    Text("Revoking removes this device's key without signing out your other devices.")
                }
            }
            .navigationTitle("Settings")
            .refreshable { await model.refresh() }
            .alert("Revoke this device?", isPresented: $confirmsRevoke) {
                Button("Revoke", role: .destructive, action: model.revokeThisDevice)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You will need a new pairing code from your Mac to link this device again.")
            }
        }
        .accessibilityIdentifier("settings-screen")
    }

    private var dictationStyleBinding: Binding<String> {
        Binding(
            get: { model.snapshot.safeSettings?.dictationStyle ?? "standard" },
            set: { style in
                model.updateSafeSettings(
                    style: style,
                    imageSafeMode: model.snapshot.safeSettings?.imageSafeMode ?? false
                )
            }
        )
    }

    private var imageSafeModeBinding: Binding<Bool> {
        Binding(
            get: { model.snapshot.safeSettings?.imageSafeMode ?? false },
            set: { enabled in
                model.updateSafeSettings(
                    style: model.snapshot.safeSettings?.dictationStyle ?? "standard",
                    imageSafeMode: enabled
                )
            }
        )
    }
}

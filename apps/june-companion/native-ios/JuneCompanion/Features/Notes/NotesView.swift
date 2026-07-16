import SwiftUI

struct NotesView: View {
    @ObservedObject var model: AppModel
    let openNavigation: (() -> Void)?
    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                if filteredNotes.isEmpty {
                    ContentUnavailableView {
                        Label(query.isEmpty ? "No notes yet" : "No matching notes", systemImage: "note.text")
                    } description: {
                        Text(query.isEmpty ? "Notes from your Mac will appear here." : "Try another search.")
                    }
                } else {
                    List(filteredNotes) { note in
                        Button { model.openNote(note) } label: {
                            NoteSummaryRow(note: note)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("note-\(note.id)")
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Notes")
            .searchable(text: $query, prompt: "Search notes")
            .refreshable { await model.refresh() }
            .toolbar {
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
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionLabel(state: model.snapshot.connection)
                }
            }
            .sheet(item: $model.selectedNote) { note in
                NoteEditorView(model: model, note: note)
            }
        }
        .accessibilityIdentifier("notes-screen")
    }

    private var filteredNotes: [NoteSummaryModel] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return model.snapshot.notes }
        return model.snapshot.notes.filter {
            $0.title.localizedCaseInsensitiveContains(term)
                || $0.preview.localizedCaseInsensitiveContains(term)
        }
    }
}

private struct NoteSummaryRow: View {
    let note: NoteSummaryModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(note.title.isEmpty ? "Untitled note" : note.title)
                .font(JuneFont.headline)
                .lineLimit(1)
            Text(note.preview)
                .font(JuneFont.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Text(note.updatedAt)
                .font(JuneFont.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

private struct NoteEditorView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var content: String

    init(model: AppModel, note: NoteRecordModel) {
        self.model = model
        _title = State(initialValue: note.title)
        _content = State(initialValue: note.editedContent)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextField("Note title", text: $title)
                    .font(JuneFont.title)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                Divider()
                TextEditor(text: $content)
                    .font(JuneFont.body)
                    .padding(16)
                    .accessibilityLabel("Note content")
            }
            .navigationTitle("Edit note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Button {
                        model.focusMac()
                    } label: {
                        Image(systemName: "arrow.up.forward.app")
                    }
                    .disabled(model.snapshot.connection != .ready)
                    .accessibilityLabel("Open note on Mac")
                    Button("Save") {
                        model.saveNote(title: title, content: content)
                    }
                    .disabled(model.snapshot.connection != .ready || model.isWorking)
                }
            }
            .alert("This note changed on your Mac", isPresented: conflictBinding) {
                Button("Use latest Mac version") {
                    model.useLatestConflict()
                    if let latest = model.selectedNote {
                        title = latest.title
                        content = latest.editedContent
                    }
                }
                Button("Keep editing", role: .cancel) { model.noteConflict = nil }
            } message: {
                Text("Your edit was not overwritten. Review the latest version before saving again.")
            }
        }
        .interactiveDismissDisabled(model.isWorking)
        .accessibilityIdentifier("note-editor")
    }

    private var conflictBinding: Binding<Bool> {
        Binding(
            get: { model.noteConflict != nil },
            set: { if !$0 { model.noteConflict = nil } }
        )
    }
}

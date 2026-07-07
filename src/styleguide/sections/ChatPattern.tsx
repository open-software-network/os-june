export function ChatPattern() {
  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Chat</h1>
      <p className="sg-section-intro">
        The agent chat turn is the app's richest surface: prose and markdown, tool and reasoning
        disclosures, approval / clarify / secret prompts, generated files and images, and error
        states.
      </p>

      <div className="sg-card">
        <div className="sg-eyebrow">Rendered in the app, not here</div>
        <p className="sg-note" style={{ marginTop: 0 }}>
          The turn renderer (`AgentChatTurnRow`) is an internal, unexported function inside
          `src/components/agent/AgentWorkspace.tsx`, a ~9,800 line module that imports
          `@tauri-apps/api/event` and `@tauri-apps/plugin-dialog` at module scope. Pulling it into
          this dev page would drag its whole graph in and load-time Tauri imports, which the null
          bridge doesn't guard (it only intercepts calls, not imports). So there is no live specimen
          here.
        </p>
        <p className="sg-note">
          Instead, view the full gallery inside the running app: open the browser console and run{" "}
          <code>__agentGallery(true)</code> (and <code>__agentErrors(true)</code> for the error
          surfaces). It renders every part type and status through the real `AgentChatTurnRow`,
          exactly what ships. The fixtures live in `src/lib/agent-chat-gallery.ts`. Close with{" "}
          <code>__agentGallery(false)</code>.
        </p>
      </div>
    </div>
  );
}

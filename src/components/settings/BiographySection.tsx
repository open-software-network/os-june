import { IconSparkle } from "central-icons/IconSparkle";
import { useEffect, useState } from "react";
import { AGENT_OPEN_EVENT } from "../../lib/agent-events";
import { biographyPrompt, extractBiographyMarkdown } from "../../lib/connectors";
import { messageFromError } from "../../lib/errors";
import { biographyDelete, biographyGet, biographySet, type Biography } from "../../lib/tauri";
import { markAgentNewSessionPending } from "../agent/AgentWorkspace";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/Toaster";

/**
 * The "Here's what I already know" card: a locally stored profile June builds
 * from your notes, mail, and calendar through a one-shot agent run. The
 * profile never leaves this Mac — it lives in a single app-data file the
 * agent's soul can read at spawn.
 *
 * "Build my profile" hands the generation prompt to a fresh agent session
 * (the same pending-marker handoff the routines describe bar uses) and
 * navigates to the agent view via the AGENT_OPEN_EVENT window event App.tsx
 * already listens for, so no new shell wiring is needed. Back here, the
 * editor saves the result (pasting the agent's fenced markdown block works
 * as-is: the fence is stripped on save).
 */
export function BiographySection() {
  const [biography, setBiography] = useState<Biography | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    biographyGet()
      .then((stored) => {
        if (cancelled) return;
        setBiography(stored);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function buildProfile() {
    markAgentNewSessionPending(biographyPrompt());
    window.dispatchEvent(new CustomEvent(AGENT_OPEN_EVENT, { detail: {} }));
  }

  function startEditing() {
    setDraft(biography?.markdown ?? "");
    setEditing(true);
  }

  async function save() {
    const text = draft.trim();
    if (!text || saving) return;
    // Pasting the agent's whole reply is the expected flow; unwrap a fenced
    // markdown block so the stored profile is the content, not the fence.
    const markdown = extractBiographyMarkdown(text) ?? text;
    setSaving(true);
    try {
      const stored = await biographySet({ markdown });
      setBiography(stored);
      setEditing(false);
      toast.success("Profile saved");
    } catch (err) {
      toast.error(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await biographyDelete();
    setBiography(null);
    setEditing(false);
    toast.success("Profile deleted");
  }

  return (
    <section className="settings-group" aria-labelledby="biography-heading">
      <h2 id="biography-heading" className="settings-group-heading">
        Your profile
      </h2>
      <p className="settings-group-description">
        Here's what I already know, and it never left your Mac. June can build a short profile of
        you from your notes, mail, and calendar, stored only on this device.
      </p>
      <div className="settings-card">
        {!loaded ? (
          <p className="settings-status">Loading profile…</p>
        ) : editing ? (
          <div className="biography-editor">
            <textarea
              className="biography-textarea"
              value={draft}
              aria-label="Profile"
              placeholder="Paste or write your profile in markdown…"
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <div className="biography-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-action primary-solid"
                disabled={!draft.trim() || saving}
                aria-busy={saving || undefined}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save profile"}
              </button>
            </div>
          </div>
        ) : biography ? (
          <div className="biography-view">
            <pre className="biography-content">{biography.markdown}</pre>
            <div className="biography-actions">
              <button type="button" className="btn btn-ghost" onClick={startEditing}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-ghost destructive"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
              <button type="button" className="btn btn-secondary" onClick={buildProfile}>
                <IconSparkle size={13} aria-hidden />
                Regenerate
              </button>
            </div>
          </div>
        ) : (
          <div className="biography-empty">
            <p className="settings-row-description">
              No profile yet. June reads your notes plus the connected mail and calendar (read
              only), writes a short profile, and brings it back here for you to review and save.
            </p>
            <div className="biography-actions">
              <button type="button" className="primary-action primary-solid" onClick={buildProfile}>
                <IconSparkle size={13} aria-hidden />
                Build my profile
              </button>
              <button type="button" className="btn btn-ghost" onClick={startEditing}>
                Write it myself
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title="Delete your profile?"
        description="June forgets the stored profile. You can build it again any time."
        confirmLabel="Delete"
        destructive
      />
    </section>
  );
}

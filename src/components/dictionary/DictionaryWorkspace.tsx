import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import { useEffect, useMemo, useState } from "react";
import {
  createDictionaryEntry,
  deleteDictionaryEntry,
  listDictionaryEntries,
  updateDictionaryEntry,
} from "../../lib/tauri";
import type { DictionaryEntryDto } from "../../lib/tauri";

type Draft = {
  phrase: string;
};

const EMPTY_DRAFT: Draft = {
  phrase: "",
};

export function DictionaryWorkspace() {
  const [entries, setEntries] = useState<DictionaryEntryDto[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    void refreshEntries();
  }, []);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return entries;
    return entries.filter((entry) =>
      entry.phrase.toLowerCase().includes(normalized),
    );
  }, [entries, query]);

  async function refreshEntries() {
    try {
      setEntries(await listDictionaryEntries());
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function saveEntry() {
    const phrase = draft.phrase.trim();
    if (!phrase) {
      setStatus("Add a word or phrase first.");
      return;
    }
    const input = {
      phrase,
    };
    try {
      const entry = editingId
        ? await updateDictionaryEntry({ entryId: editingId, ...input })
        : await createDictionaryEntry(input);
      setEntries((current) =>
        editingId
          ? current.map((item) => (item.id === entry.id ? entry : item))
          : [...current, entry].sort(compareEntries),
      );
      setDraft(EMPTY_DRAFT);
      setEditingId(undefined);
      setStatus(
        editingId ? "Dictionary entry updated." : "Dictionary entry added.",
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function removeEntry(entryId: string) {
    try {
      await deleteDictionaryEntry(entryId);
      setEntries((current) => current.filter((entry) => entry.id !== entryId));
      if (editingId === entryId) {
        setDraft(EMPTY_DRAFT);
        setEditingId(undefined);
      }
      setStatus("Dictionary entry removed.");
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  function startEditing(entry: DictionaryEntryDto) {
    setEditingId(entry.id);
    setDraft({
      phrase: entry.phrase,
    });
  }

  return (
    <div className="dictionary-page">
      <header className="dictionary-header">
        <div>
          <h1 className="dictionary-title">Dictionary</h1>
          <p className="dictionary-description">
            Custom words and phrases to prefer during transcription.
          </p>
        </div>
        <input
          className="dictionary-search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search"
          aria-label="Search dictionary"
        />
      </header>

      {status ? <p className="dictionary-status">{status}</p> : null}

      <section className="dictionary-card" aria-label="Add dictionary entry">
        <div className="dictionary-form dictionary-form-simple">
          <label>
            <span>Word or phrase</span>
            <input
              value={draft.phrase}
              onChange={(event) => {
                const phrase = event.currentTarget.value;
                setDraft((current) => ({
                  ...current,
                  phrase,
                }));
              }}
              placeholder="Junho Hong"
            />
          </label>
          <div className="dictionary-actions">
            {editingId ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setDraft(EMPTY_DRAFT);
                  setEditingId(undefined);
                }}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void saveEntry()}
            >
              <IconPlusMedium size={14} />
              {editingId ? "Save" : "Add"}
            </button>
          </div>
        </div>
      </section>

      <section className="dictionary-list" aria-label="Dictionary entries">
        {filteredEntries.length > 0 ? (
          filteredEntries.map((entry) => (
            <article key={entry.id} className="dictionary-entry">
              <div className="dictionary-entry-main">
                <h2>{entry.phrase}</h2>
              </div>
              <div className="dictionary-entry-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${entry.phrase}`}
                  onClick={() => startEditing(entry)}
                >
                  <IconPencilLine size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button destructive-icon"
                  aria-label={`Delete ${entry.phrase}`}
                  onClick={() => void removeEntry(entry.id)}
                >
                  <IconTrashCanSimple size={14} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="dictionary-empty">
            {entries.length === 0 ? "No dictionary entries yet" : "No matches"}
          </div>
        )}
      </section>
    </div>
  );
}

function compareEntries(left: DictionaryEntryDto, right: DictionaryEntryDto) {
  return left.phrase.localeCompare(right.phrase, undefined, {
    sensitivity: "base",
  });
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

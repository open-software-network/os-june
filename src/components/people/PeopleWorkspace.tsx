import { IconArchive } from "central-icons/IconArchive";
import { IconCalendarSearch } from "central-icons/IconCalendarSearch";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPeople } from "central-icons/IconPeople";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconScanVoice } from "central-icons/IconScanVoice";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  archivePersona,
  createPersonaCommitment,
  deletePersona,
  deletePersonaCommitment,
  getPersona,
  listPersonas,
  restorePersona,
  retryPersonaDossierJob,
  scrubDeletedPersonaFromNotes,
  type PersonaCommitmentDto,
  type PersonaDetailDto,
  type PersonaSummaryDto,
  updatePersona,
  updatePersonaCommitment,
} from "../../lib/tauri";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog, DialogField } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { InlineNotice } from "../ui/InlineNotice";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";

type PeopleFilter = "active" | "archived";

type PersonaDossierJob = {
  id: string;
  status: string;
  lastError?: string;
};

type PeopleDetail = PersonaDetailDto & {
  dossierJobs?: PersonaDossierJob[];
};

type DeleteReceipt = {
  deletionBatchId: string;
  affectedTranscriptCount: number;
  affectedNoteIds: string[];
};

export type PeopleWorkspaceProps = {
  selectedPersonaId?: string;
  onSelectPersona: (id?: string) => void;
  onOpenNote: (noteId: string, personaId: string) => void;
  onPrepare: (personaId: string) => Promise<void> | void;
  returnTarget?: {
    label: string;
    onBack: () => void;
  };
};

const FILTER_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
] as const;

const COMMITMENT_DIRECTIONS = [
  { value: "personaOwesUser", label: "They owe you" },
  { value: "userOwesPersona", label: "You owe them" },
];

const COMMITMENT_STATUSES = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];

export function PeopleWorkspace({
  selectedPersonaId,
  onSelectPersona,
  onOpenNote,
  onPrepare,
  returnTarget,
}: PeopleWorkspaceProps) {
  const [filter, setFilter] = useState<PeopleFilter>("active");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PersonaSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadVersion, setReloadVersion] = useState(0);

  const reloadPeople = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    void reloadVersion;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void listPersonas({ filter, query: query.trim() || undefined })
      .then((response) => {
        if (cancelled) return;
        setPeople(personaItems(response).filter((persona) => !persona.isSelf));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageFromError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, query, reloadVersion]);

  if (selectedPersonaId) {
    return (
      <PersonaDetail
        personaId={selectedPersonaId}
        returnTarget={returnTarget}
        onBack={() => onSelectPersona(undefined)}
        onDeleted={() => onSelectPersona(undefined)}
        onMutated={reloadPeople}
        onOpenNote={onOpenNote}
        onPrepare={onPrepare}
      />
    );
  }

  return (
    <section className="people-workspace" aria-labelledby="people-page-title">
      <header className="people-header">
        <div className="people-heading">
          <h1 id="people-page-title">People June knows</h1>
          <p>People June can recognize, remember, and help you prepare to meet.</p>
        </div>
      </header>

      <div className="people-controls">
        <label className="folders-search people-search">
          <IconMagnifyingGlass size={14} aria-hidden />
          <input
            type="search"
            aria-label="Search people"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <SegmentedControl
          className="people-filter"
          aria-label="Filter people"
          value={filter}
          options={FILTER_OPTIONS}
          onValueChange={setFilter}
        />
      </div>

      {loading ? (
        <div className="people-loading">
          <Spinner aria-label="Loading people" />
        </div>
      ) : error ? (
        <InlineNotice
          tone="destructive"
          role="alert"
          eyebrow="People unavailable"
          body={error}
          actions={
            <button type="button" className="primary-action" onClick={reloadPeople}>
              Retry
            </button>
          }
        />
      ) : people.length > 0 ? (
        <ul
          className="people-grid"
          aria-label={filter === "active" ? "Active people" : "Archived people"}
        >
          {people.map((persona) => (
            <PersonaCard
              key={persona.id}
              persona={persona}
              onOpen={() => onSelectPersona(persona.id)}
            />
          ))}
        </ul>
      ) : query.trim() ? (
        <EmptyState
          className="empty-state-compact"
          label="No matching people"
          icon={<IconPeople size={28} />}
          title="No people match your search"
          description="Try a different name or relationship."
        />
      ) : filter === "archived" ? (
        <EmptyState
          label="No archived people"
          icon={<IconArchive size={28} />}
          title="No archived people"
          description="People you archive stay here with their dossier and meeting history."
        />
      ) : (
        <EmptyState
          label="No known people"
          icon={<IconPeople size={28} />}
          title="Tag a voice to get started"
          description="Open a finished note, choose Transcription, and tag a voice. June will remember that person here."
        />
      )}
    </section>
  );
}

function PersonaCard({ persona, onOpen }: { persona: PersonaSummaryDto; onOpen: () => void }) {
  const relationship = persona.relationship?.trim();
  const label = relationship ? `Open ${persona.name}, ${relationship}` : `Open ${persona.name}`;
  return (
    <li className="people-card">
      <button type="button" className="people-card-main" aria-label={label} onClick={onOpen}>
        <span className="people-card-icon" aria-hidden>
          <IconPeople size={14} />
        </span>
        <span className="people-card-body">
          <span className="people-card-name">{persona.name}</span>
          <span className="people-card-relationship">
            {relationship || "No relationship added"}
          </span>
          <span className="people-card-meta">
            <span>
              {persona.voiceprintCount}{" "}
              {persona.voiceprintCount === 1 ? "voiceprint" : "voiceprints"}
            </span>
            <span className="metadata-dot" aria-hidden />
            <span>
              {persona.lastSeenAt
                ? `Last seen ${formatRelative(persona.lastSeenAt)}`
                : "Not seen yet"}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

function PersonaDetail({
  personaId,
  returnTarget,
  onBack,
  onDeleted,
  onMutated,
  onOpenNote,
  onPrepare,
}: {
  personaId: string;
  returnTarget?: PeopleWorkspaceProps["returnTarget"];
  onBack: () => void;
  onDeleted: () => void;
  onMutated: () => void;
  onOpenNote: PeopleWorkspaceProps["onOpenNote"];
  onPrepare: PeopleWorkspaceProps["onPrepare"];
}) {
  const [persona, setPersona] = useState<PeopleDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReceipt, setDeleteReceipt] = useState<DeleteReceipt>();
  const [addCommitmentOpen, setAddCommitmentOpen] = useState(false);
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [dossier, setDossier] = useState("");
  const nameId = useId();
  const relationshipId = useId();
  const dossierId = useId();

  const reloadDetail = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    void reloadVersion;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void getPersona(personaId)
      .then((next) => {
        if (cancelled) return;
        const loaded = next as PeopleDetail;
        const detail: PeopleDetail = {
          ...loaded,
          commitments: loaded.commitments ?? [],
          meetings: loaded.meetings ?? [],
          dossierJobs: loaded.dossierJobs ?? [],
        };
        setPersona(detail);
        setName(detail.name);
        setRelationship(detail.relationship ?? "");
        setDossier(detail.dossier ?? "");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageFromError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [personaId, reloadVersion]);

  useEffect(() => {
    if (
      !persona?.dossierJobs?.some((job) => job.status === "pending" || job.status === "running")
    ) {
      return;
    }
    const timer = window.setTimeout(reloadDetail, 1_500);
    return () => window.clearTimeout(timer);
  }, [persona?.dossierJobs, reloadDetail]);

  const runMutation = useCallback(
    async (mutation: () => Promise<unknown>, rethrow = false) => {
      setError(undefined);
      try {
        await mutation();
        onMutated();
        reloadDetail();
      } catch (cause) {
        setError(messageFromError(cause));
        if (rethrow) throw cause;
      }
    },
    [onMutated, reloadDetail],
  );

  if (loading && !persona) {
    return (
      <section className="people-detail" aria-label="Loading person">
        <BreadcrumbBar
          backLabel={returnTarget?.label ?? "Back to people"}
          onBack={returnTarget?.onBack ?? onBack}
          items={[{ label: "People" }, { label: "Loading" }]}
        />
        <div className="people-detail-loading">
          <Spinner aria-label="Loading person" />
        </div>
      </section>
    );
  }

  if (!persona) {
    return (
      <section className="people-detail" aria-label="Person unavailable">
        <BreadcrumbBar
          backLabel={returnTarget?.label ?? "Back to people"}
          onBack={returnTarget?.onBack ?? onBack}
          items={[{ label: "People", onClick: onBack }, { label: "Unavailable" }]}
        />
        <div className="people-detail-content">
          <InlineNotice
            tone="destructive"
            role="alert"
            eyebrow="Person unavailable"
            body={error ?? "This person could not be loaded."}
            actions={
              <button type="button" className="primary-action" onClick={reloadDetail}>
                Retry
              </button>
            }
          />
        </div>
      </section>
    );
  }

  const dirty =
    name.trim() !== persona.name ||
    relationship.trim() !== (persona.relationship ?? "") ||
    dossier.trim() !== (persona.dossier ?? "");
  const failedJobs = (persona.dossierJobs ?? []).filter((job) => job.status === "failed");
  const personaArchived = persona.archivedAt !== undefined;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !dirty) return;
    setSaving(true);
    try {
      await runMutation(() =>
        updatePersona({
          personaId,
          name: name.trim(),
          relationship: relationship.trim() || undefined,
          dossier: dossier.trim(),
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handlePrepare() {
    setPreparing(true);
    setError(undefined);
    try {
      await onPrepare(personaId);
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setPreparing(false);
    }
  }

  async function handleArchiveToggle() {
    setLifecycleBusy(true);
    try {
      await runMutation(() =>
        personaArchived ? restorePersona(personaId) : archivePersona(personaId),
      );
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleDelete() {
    setLifecycleBusy(true);
    setError(undefined);
    try {
      const receipt = (await deletePersona(personaId)) as DeleteReceipt;
      setDeleteReceipt(receipt);
      onMutated();
      if (receipt.affectedTranscriptCount === 0) onDeleted();
    } catch (cause) {
      setError(messageFromError(cause));
      throw cause;
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleScrub() {
    if (!deleteReceipt) return;
    setError(undefined);
    try {
      await scrubDeletedPersonaFromNotes(deleteReceipt.deletionBatchId);
    } catch (cause) {
      setError(messageFromError(cause));
      throw cause;
    }
  }

  return (
    <section className="people-detail" aria-label={persona.name}>
      <BreadcrumbBar
        backLabel={returnTarget?.label ?? "Back to people"}
        onBack={returnTarget?.onBack ?? onBack}
        items={[{ label: "People", onClick: onBack }, { label: persona.name }]}
      />

      <div className="people-detail-content">
        <header className="people-detail-header">
          <div>
            <h1>{persona.name}</h1>
            <p className="people-detail-relationship">
              {persona.relationship?.trim() || "No relationship added"}
            </p>
            <p className="people-detail-meta">
              <span className="people-detail-meta-icon" aria-hidden>
                <IconScanVoice size={13} />
              </span>
              {persona.voiceprintCount}{" "}
              {persona.voiceprintCount === 1 ? "voiceprint" : "voiceprints"}
              <span className="metadata-dot" aria-hidden />
              {persona.lastSeenAt ? `Last seen ${formatDate(persona.lastSeenAt)}` : "Not seen yet"}
              {persona.archivedAt ? (
                <>
                  <span className="metadata-dot" aria-hidden />
                  <span className="people-archived-label">Archived</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="people-detail-actions">
            {!persona.archivedAt && !persona.isSelf ? (
              <button
                type="button"
                className="primary-action primary-solid"
                disabled={preparing || lifecycleBusy}
                aria-busy={preparing || undefined}
                onClick={() => void handlePrepare()}
              >
                <IconCalendarSearch size={14} />
                {preparing ? "Preparing..." : "Prepare for meeting"}
              </button>
            ) : null}
            {!persona.isSelf ? (
              <>
                <button
                  type="button"
                  className="primary-action"
                  disabled={lifecycleBusy}
                  onClick={() => void handleArchiveToggle()}
                >
                  <IconArchive size={14} />
                  {persona.archivedAt ? "Restore" : "Archive"}
                </button>
                <button
                  type="button"
                  className="primary-action primary-destructive"
                  disabled={lifecycleBusy}
                  onClick={() => setDeleteOpen(true)}
                >
                  <IconTrashCan size={14} />
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </header>

        {error ? <InlineNotice tone="destructive" role="alert" body={error} /> : null}

        {failedJobs.map((job) => (
          <InlineNotice
            key={job.id}
            tone="warning"
            role="status"
            eyebrow="Dossier update needs attention"
            body={job.lastError ?? "June could not update this dossier."}
            actions={
              <button
                type="button"
                className="primary-action"
                onClick={() => void runMutation(() => retryPersonaDossierJob(job.id))}
              >
                Retry
              </button>
            }
          />
        ))}

        <form
          className="people-edit-form"
          aria-label={`Edit ${persona.name}`}
          onSubmit={handleSave}
        >
          <section className="people-section" aria-labelledby={`${nameId}-heading`}>
            <div className="people-section-heading">
              <div>
                <h2 id={`${nameId}-heading`}>Identity</h2>
                <p>How this person appears across June.</p>
              </div>
            </div>
            <div className="people-fields">
              <label htmlFor={nameId}>
                Name
                <input
                  id={nameId}
                  className="people-input"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                  disabled={saving}
                  required
                />
              </label>
              <label htmlFor={relationshipId}>
                Relationship
                <input
                  id={relationshipId}
                  className="people-input"
                  value={relationship}
                  onChange={(event) => setRelationship(event.currentTarget.value)}
                  disabled={saving}
                  placeholder="How you know them"
                />
              </label>
            </div>
          </section>

          <section className="people-section" aria-labelledby={`${dossierId}-heading`}>
            <div className="people-section-heading">
              <div>
                <h2 id={`${dossierId}-heading`}>Dossier</h2>
                <p>
                  June keeps this memory current after trusted meetings. You can edit it anytime.
                </p>
              </div>
            </div>
            <label className="people-dossier-label" htmlFor={dossierId}>
              What June remembers
              <textarea
                id={dossierId}
                className="people-dossier-input"
                value={dossier}
                onChange={(event) => setDossier(event.currentTarget.value)}
                disabled={saving}
                placeholder="Nothing remembered yet."
              />
            </label>
          </section>

          <div className="people-save-row">
            <button
              type="submit"
              className="primary-action primary-solid"
              disabled={saving || !dirty || !name.trim()}
              aria-busy={saving || undefined}
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>

        <CommitmentsSection
          persona={persona}
          onAdd={() => setAddCommitmentOpen(true)}
          onOpenNote={onOpenNote}
          onMutation={runMutation}
        />

        <MeetingsSection persona={persona} onOpenNote={onOpenNote} />
      </div>

      <AddCommitmentDialog
        open={addCommitmentOpen}
        onClose={() => setAddCommitmentOpen(false)}
        onCreate={(input) =>
          runMutation(() => createPersonaCommitment({ personaId, ...input }), true)
        }
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title={`Delete ${persona.name}?`}
        description="June will forget this person, their voiceprints, dossier, and commitments. Past transcripts keep their name unless you choose to scrub it next."
        confirmLabel="Delete person"
        confirmBusyLabel="Deleting..."
        destructive
      />

      <ConfirmDialog
        open={deleteReceipt !== undefined && deleteReceipt.affectedTranscriptCount > 0}
        onClose={() => {
          setDeleteReceipt(undefined);
          onDeleted();
        }}
        onConfirm={handleScrub}
        title={`Remove ${persona.name} from past transcripts?`}
        description={`${deleteReceipt?.affectedTranscriptCount ?? 0} transcript ${
          deleteReceipt?.affectedTranscriptCount === 1 ? "turn keeps" : "turns keep"
        } the name. Scrubbing replaces it with the original anonymous speaker label.`}
        confirmLabel="Scrub past transcripts"
        confirmBusyLabel="Scrubbing..."
        cancelLabel="Keep past names"
        destructive
      />
    </section>
  );
}

function CommitmentsSection({
  persona,
  onAdd,
  onOpenNote,
  onMutation,
}: {
  persona: PeopleDetail;
  onAdd: () => void;
  onOpenNote: PeopleWorkspaceProps["onOpenNote"];
  onMutation: (mutation: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <section className="people-section" aria-labelledby="people-commitments-heading">
      <div className="people-section-heading">
        <div>
          <h2 id="people-commitments-heading">Commitments</h2>
          <p>Promises in either direction, with their source note.</p>
        </div>
        <button type="button" className="primary-action" onClick={onAdd}>
          <IconPlusMedium size={14} />
          Add commitment
        </button>
      </div>
      {persona.commitments.length > 0 ? (
        <ul className="people-commitment-list">
          {persona.commitments.map((commitment) => (
            <CommitmentRow
              key={commitment.id}
              commitment={commitment}
              personaId={persona.id}
              onOpenNote={onOpenNote}
              onMutation={onMutation}
            />
          ))}
        </ul>
      ) : (
        <p className="people-section-empty">No commitments yet.</p>
      )}
    </section>
  );
}

function CommitmentRow({
  commitment,
  personaId,
  onOpenNote,
  onMutation,
}: {
  commitment: PersonaCommitmentDto;
  personaId: string;
  onOpenNote: PeopleWorkspaceProps["onOpenNote"];
  onMutation: (mutation: () => Promise<unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const direction = commitmentDirectionLabel(commitment.direction);
  const sourceNoteId = commitment.sourceNoteId;

  async function mutate(mutation: () => Promise<unknown>) {
    setBusy(true);
    try {
      await onMutation(mutation);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="people-commitment" data-status={commitment.status} aria-busy={busy || undefined}>
      <div className="people-commitment-main">
        <div className="people-commitment-copy">
          <span className="people-commitment-direction">{direction}</span>
          <p>{commitment.text}</p>
          <div className="people-commitment-meta">
            {commitment.dueValue ? (
              <span>Due {formatDate(commitment.dueValue)}</span>
            ) : (
              <span>No due date</span>
            )}
            {sourceNoteId ? (
              <>
                <span className="metadata-dot" aria-hidden />
                <button
                  type="button"
                  className="people-note-link"
                  onClick={() => onOpenNote(sourceNoteId, personaId)}
                >
                  <IconNoteText size={13} />
                  {commitment.sourceNoteTitle?.trim() || "Open source note"}
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="people-commitment-actions">
          <Select
            value={commitment.status}
            options={COMMITMENT_STATUSES}
            placeholder="Status"
            ariaLabel={`Status for ${commitment.text}`}
            onChange={(status) =>
              void mutate(() =>
                updatePersonaCommitment({
                  commitmentId: commitment.id,
                  direction: commitment.direction,
                  text: commitment.text,
                  due: commitment.dueValue,
                  status: status as PersonaCommitmentDto["status"],
                }),
              )
            }
          />
          <button
            type="button"
            className="people-icon-button people-icon-button-destructive"
            aria-label={`Delete commitment: ${commitment.text}`}
            disabled={busy}
            onClick={() => void mutate(() => deletePersonaCommitment(commitment.id))}
          >
            <IconTrashCan size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}

function MeetingsSection({
  persona,
  onOpenNote,
}: {
  persona: PeopleDetail;
  onOpenNote: PeopleWorkspaceProps["onOpenNote"];
}) {
  return (
    <section className="people-section" aria-labelledby="people-meetings-heading">
      <div className="people-section-heading">
        <div>
          <h2 id="people-meetings-heading">Meeting history</h2>
          <p>Notes where this person is a confirmed participant.</p>
        </div>
      </div>
      {persona.meetings.length > 0 ? (
        <ul className="people-meeting-list">
          {persona.meetings.map((meeting) => (
            <li key={meeting.noteId}>
              <button
                type="button"
                className="people-meeting-row"
                onClick={() => onOpenNote(meeting.noteId, persona.id)}
              >
                <span className="people-meeting-icon" aria-hidden>
                  <IconNoteText size={14} />
                </span>
                <span className="people-meeting-body">
                  <span className="people-meeting-title">{meeting.title.trim() || "New note"}</span>
                  <span className="people-meeting-date">{formatDate(meeting.lastSeenAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="people-section-empty">No confirmed meetings yet.</p>
      )}
    </section>
  );
}

function AddCommitmentDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: {
    direction: PersonaCommitmentDto["direction"];
    text: string;
    due?: string;
  }) => Promise<void>;
}) {
  const [direction, setDirection] = useState<PersonaCommitmentDto["direction"]>("personaOwesUser");
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const textId = useId();
  const dueId = useId();

  useEffect(() => {
    if (!open) return;
    setDirection("personaOwesUser");
    setText("");
    setDue("");
    setError(undefined);
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onCreate({ direction, text: text.trim(), due: due || undefined });
      onClose();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setSaving(false);
    }
  }

  const footer: ReactNode = (
    <>
      <button type="button" className="primary-action" disabled={saving} onClick={onClose}>
        Cancel
      </button>
      <button
        type="submit"
        form="people-add-commitment-form"
        className="primary-action primary-solid"
        disabled={saving || !text.trim()}
        aria-busy={saving || undefined}
      >
        {saving ? "Adding..." : "Add commitment"}
      </button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Add commitment"
      description="Record a promise and who owes it."
      footer={footer}
      initialFocusSelector={`#${cssEscape(textId)}`}
    >
      <form id="people-add-commitment-form" className="people-dialog-form" onSubmit={handleSubmit}>
        <DialogField label="Direction">
          <Select
            value={direction}
            options={COMMITMENT_DIRECTIONS}
            placeholder="Choose direction"
            ariaLabel="Commitment direction"
            onChange={(value) => setDirection(value as PersonaCommitmentDto["direction"])}
          />
        </DialogField>
        <DialogField label="Commitment" htmlFor={textId}>
          <textarea
            id={textId}
            className="dialog-textarea"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            disabled={saving}
            required
          />
        </DialogField>
        <DialogField label="Due date (optional)" htmlFor={dueId}>
          <input
            id={dueId}
            type="date"
            className="dialog-input"
            value={due}
            onChange={(event) => setDue(event.currentTarget.value)}
            disabled={saving}
          />
        </DialogField>
        {error ? <InlineNotice tone="destructive" role="alert" body={error} /> : null}
      </form>
    </Dialog>
  );
}

function commitmentDirectionLabel(direction: PersonaCommitmentDto["direction"]): string {
  return direction === "userOwesPersona" ? "You owe them" : "They owe you";
}

function personaItems(response: unknown): PersonaSummaryDto[] {
  if (Array.isArray(response)) return response as PersonaSummaryDto[];
  if (!response || typeof response !== "object") return [];
  const items = (response as { items?: unknown }).items;
  return Array.isArray(items) ? (items as PersonaSummaryDto[]) : [];
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
  if (Math.abs(days) < 1) return "today";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return formatter.format(months, "month");
  return formatter.format(Math.round(months / 12), "year");
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

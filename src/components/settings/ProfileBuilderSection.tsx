import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconRobot2 } from "central-icons/IconRobot2";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  canActivateProfile,
  canCreateProfile,
  canRemoveProfile,
  describeProfile,
  nextCopyProfileName,
  nextNumberedProfileName,
  orderProfiles,
  slugifyProfileName,
  useProfileCreator,
  useProfileManager,
  validateProfileName,
  type HermesAdminMode,
  type HermesCreateProfilePayload,
  type ProfileManagerState,
} from "../../lib/hermes-admin";
import {
  deleteProfileModelOverrides,
  profileModelOverrides,
  setProfileModelOverrides,
} from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { EmptyState as EmptyStateSurface } from "../ui/EmptyState";
import { SettingsPageHeader } from "./AppSettings";

type ProfileBuilderSectionProps = {
  /** The write-access mode whose runtime profiles are managed. */
  mode?: HermesAdminMode;
};

export type CreateProfile = (payload: HermesCreateProfilePayload) => Promise<void>;

export function ProfileBuilderSection({ mode = "sandboxed" }: ProfileBuilderSectionProps) {
  const managerState = useProfileManager(mode);
  const createProfile = useProfileCreator(mode);
  return (
    <ProfilesSurfaceView managerState={managerState} createProfile={createProfile} mode={mode} />
  );
}

export function ProfilesSurfaceView({
  managerState,
  createProfile,
  mode = "sandboxed",
}: {
  managerState: ProfileManagerState;
  createProfile: CreateProfile;
  mode?: HermesAdminMode;
}) {
  return <ProfilesListView state={managerState} createProfile={createProfile} mode={mode} />;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error.";
}

function ProfilesListView({
  state,
  createProfile,
  mode,
}: {
  state: ProfileManagerState;
  createProfile: CreateProfile;
  mode: HermesAdminMode;
}) {
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<"new" | "copy" | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [refreshSpins, setRefreshSpins] = useState(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasProfiles = state.profiles.length > 0;
  const profiles = useMemo(() => orderProfiles(state.profiles), [state.profiles]);

  useEffect(() => {
    if (createMode) nameInputRef.current?.focus();
  }, [createMode]);

  useEffect(() => {
    const pendingName = state.pendingRemoval?.name;
    if (!pendingName) return;
    const profile = state.profiles.find((candidate) => candidate.name === pendingName);
    if (!profile) {
      state.cancelRemoval();
      return;
    }
    const guard = canRemoveProfile(pendingName, state.activeName, state.activeConfirmed);
    if (!guard.ok) state.cancelRemoval();
  }, [
    state.activeConfirmed,
    state.activeName,
    state.cancelRemoval,
    state.pendingRemoval,
    state.profiles,
  ]);

  const cleanupProfile = useCallback((profileName: string) => {
    setCleanupError(null);
    deleteProfileModelOverrides(profileName).catch((error: unknown) => {
      setCleanupError(
        `Deleted "${profileName}", but its model override cleanup failed: ${messageFromError(error)}`,
      );
    });
  }, []);

  function beginCreate(modeToOpen: "new" | "copy") {
    setCreateError(null);
    setCreateMode(modeToOpen);
    setName(
      modeToOpen === "new"
        ? nextNumberedProfileName(state.profiles)
        : nextCopyProfileName(state.activeName, state.profiles),
    );
  }

  function cancelCreate() {
    if (creating) return;
    setCreateMode(null);
    setCreateError(null);
  }

  async function submitCreate() {
    if (!createMode || creating) return;
    const validationError = validateProfileName(name, state.profiles);
    if (validationError || !canCreateProfile(name, state.profiles)) {
      setCreateError(validationError ?? "Choose another profile name.");
      return;
    }

    const slug = slugifyProfileName(name);
    const payload: HermesCreateProfilePayload = {
      name: slug,
      clone_from_default: true,
    };
    if (createMode === "copy") {
      const activeProfile = state.profiles.find((profile) => profile.name === state.activeName);
      if (activeProfile?.provider) payload.provider = activeProfile.provider;
      if (activeProfile?.model) payload.model = activeProfile.model;
    }

    setCreating(true);
    setCreateError(null);
    try {
      await createProfile(payload);
      state.refresh();
      setCreateMode(null);

      // The default profile has no per-profile overrides to copy (it uses the
      // global model settings, which a fresh clone already follows), and the
      // overrides command rejects "default".
      if (createMode === "copy" && state.activeName !== "default") {
        try {
          const overrides = await profileModelOverrides(state.activeName);
          if (overrides) await setProfileModelOverrides(slug, overrides);
        } catch (error) {
          setCreateError(
            `Created "${slug}", but copying model settings failed: ${messageFromError(error)}`,
          );
        }
      }
    } catch (error) {
      setCreateError(messageFromError(error));
    } finally {
      setCreating(false);
    }
  }

  if (isUnavailable) {
    return (
      <ProfilesShell mode={mode} showModeNote={false}>
        <EmptyState title="Hermes is not running" description="Start Hermes to manage profiles." />
      </ProfilesShell>
    );
  }

  return (
    <ProfilesShell mode={mode} showModeNote>
      <div className="profiles-actions">
        <button
          type="button"
          className="icon-button profiles-refresh"
          aria-label="Refresh profiles"
          aria-busy={isLoadingFirst}
          disabled={isLoadingFirst}
          title="Refresh profiles"
          onClick={() => {
            setRefreshSpins((spins) => spins + 1);
            state.refresh();
          }}
        >
          <IconArrowRotateClockwise
            size={14}
            ariaHidden
            className="balance-refresh-icon"
            style={{ transform: `rotate(${refreshSpins * 360}deg)` }}
          />
        </button>
      </div>
      <div className="settings-card profiles-card">
        {(state.error || cleanupError || createError) && hasProfiles ? (
          <p className="settings-row-error profiles-inline-error" role="alert">
            <IconExclamationCircle size={14} ariaHidden />
            {createError ?? state.error ?? cleanupError}
          </p>
        ) : null}

        {isErrored && !hasProfiles ? (
          <ErrorState
            message={state.error ?? "Could not load profiles."}
            retryable
            onRetry={state.refresh}
          />
        ) : isLoadingFirst ? (
          <EmptyState title="Loading profiles" description="June is reading the profile list." />
        ) : (
          <ul className="profiles-list" aria-label="Profiles">
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.name}
                profile={profile}
                activeName={state.activeName}
                activeConfirmed={state.activeConfirmed}
                pending={state.pendingAction}
                pendingRemoval={state.pendingRemoval}
                onActivate={state.activate}
                onDelete={async (profileName) => {
                  const deleted = await state.beginRemove(profileName);
                  if (deleted) cleanupProfile(profileName);
                }}
              />
            ))}
          </ul>
        )}

        {!isErrored && !isLoadingFirst ? (
          <footer className="profiles-footer">
            {createMode ? (
              <form
                className="profiles-create-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCreate();
                }}
              >
                <label className="profiles-create-label" htmlFor="profile-name">
                  Profile name
                </label>
                <div className="profiles-create-controls">
                  <input
                    id="profile-name"
                    type="text"
                    ref={nameInputRef}
                    value={name}
                    disabled={creating}
                    onChange={(event) => {
                      setName(event.currentTarget.value);
                      setCreateError(null);
                    }}
                  />
                  <button
                    type="submit"
                    className="primary-action primary-solid"
                    disabled={creating}
                  >
                    {creating ? "Creating" : "Create"}
                  </button>
                  <button
                    type="button"
                    className="primary-action"
                    disabled={creating}
                    onClick={cancelCreate}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="profiles-footer-actions">
                <button
                  type="button"
                  className="primary-action primary-solid profiles-add"
                  onClick={() => beginCreate("new")}
                >
                  <IconPlusMedium size={14} ariaHidden />
                  New profile
                </button>
                <button
                  type="button"
                  className="primary-action"
                  disabled={!state.activeConfirmed}
                  onClick={() => beginCreate("copy")}
                >
                  Copy current settings
                </button>
              </div>
            )}
          </footer>
        ) : null}
      </div>

      <ProfileDataRemovalDialog
        pendingRemoval={state.pendingRemoval}
        error={state.error}
        busy={
          state.pendingAction?.kind === "remove" &&
          state.pendingAction.name === state.pendingRemoval?.name
        }
        onCancel={state.cancelRemoval}
        onMove={async () => {
          const profileName = state.pendingRemoval?.name;
          if (!profileName) return false;
          const deleted = await state.confirmRemoval("move");
          if (deleted) cleanupProfile(profileName);
          return deleted;
        }}
        onDelete={async () => {
          const profileName = state.pendingRemoval?.name;
          if (!profileName) return false;
          const deleted = await state.confirmRemoval("delete");
          if (deleted) cleanupProfile(profileName);
          return deleted;
        }}
      />
    </ProfilesShell>
  );
}

function ProfilesShell({
  mode,
  showModeNote,
  children,
}: {
  mode: HermesAdminMode;
  showModeNote: boolean;
  children: ReactNode;
}) {
  return (
    <section className="settings-group profile-builder" aria-labelledby="profile-builder-heading">
      <SettingsPageHeader
        id="profile-builder-heading"
        title="Profiles"
        blurb={
          <>
            Manage profiles with their own settings. Their notes, note transcriptions, dictation
            history, memory entries, and sessions stay separate.{" "}
            {showModeNote ? <ModeNote mode={mode} /> : null}
          </>
        }
      />
      {children}
    </section>
  );
}

function ModeNote({ mode }: { mode: HermesAdminMode }) {
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return <span className="profile-builder-mode-note">Showing the {modeLabel} runtime.</span>;
}

function ProfileRow({
  profile,
  activeName,
  activeConfirmed,
  pending,
  pendingRemoval,
  onActivate,
  onDelete,
}: {
  profile: ProfileManagerState["profiles"][number];
  activeName: string;
  activeConfirmed: boolean;
  pending: ProfileManagerState["pendingAction"];
  pendingRemoval: ProfileManagerState["pendingRemoval"];
  onActivate: (name: string) => Promise<boolean>;
  onDelete: (name: string) => Promise<void>;
}) {
  const activateGuard = canActivateProfile(profile.name, activeName, activeConfirmed);
  const removeGuard = canRemoveProfile(profile.name, activeName, activeConfirmed);
  const isActive = profile.name === activeName;
  const pendingThisRow = pending?.name === profile.name || pendingRemoval?.name === profile.name;
  const activating = pendingThisRow && pending?.kind === "activate";
  const removing = pendingThisRow && pending?.kind === "remove";

  return (
    <li className="profile-row">
      <div className="profile-row-main">
        <div className="profile-row-headline">
          <span className="profile-row-name">{profile.name}</span>
          {isActive ? <span className="profile-row-active">In use</span> : null}
        </div>
        <p className="profile-row-description">{describeProfile(profile)}</p>
      </div>
      <div className="profile-row-actions">
        {!isActive ? (
          <button
            type="button"
            className="profile-row-activate"
            disabled={!activateGuard.ok || pendingThisRow}
            title={!activateGuard.ok ? activateGuard.reason : undefined}
            onClick={() => void onActivate(profile.name)}
          >
            {activating ? "Using" : "Use"}
          </button>
        ) : null}
        {profile.name !== "default" && !isActive ? (
          <button
            type="button"
            className="profile-row-delete"
            aria-label={`Delete ${profile.name}`}
            disabled={!removeGuard.ok || pendingThisRow}
            title={!removeGuard.ok ? removeGuard.reason : "Delete profile"}
            onClick={() => void onDelete(profile.name)}
          >
            <IconTrashCan size={14} ariaHidden />
            {removing ? "Deleting" : "Delete"}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function ProfileDataRemovalDialog({
  pendingRemoval,
  error,
  busy,
  onCancel,
  onMove,
  onDelete,
}: {
  pendingRemoval: ProfileManagerState["pendingRemoval"];
  error?: string | null;
  busy: boolean;
  onCancel: () => void;
  onMove: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [submitting, setSubmitting] = useState<"move" | "delete" | null>(null);
  const isBusy = busy || submitting !== null;
  const name = pendingRemoval?.name;

  useEffect(() => {
    setConfirmingDelete(false);
    setSubmitting(null);
    if (!name) return;
  }, [name]);

  async function runMove() {
    if (isBusy) return;
    setSubmitting("move");
    try {
      await onMove();
    } finally {
      setSubmitting(null);
    }
  }

  async function runDelete() {
    if (isBusy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSubmitting("delete");
    try {
      await onDelete();
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Dialog
      open={Boolean(pendingRemoval)}
      onClose={() => {
        if (!isBusy) onCancel();
      }}
      title={name ? `Delete "${name}"?` : "Delete profile?"}
      description={pendingRemoval ? profileDataSummaryText(pendingRemoval.summary) : undefined}
      width={460}
      footer={
        <>
          <button type="button" className="primary-action" onClick={onCancel} disabled={isBusy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid primary-destructive"
            onClick={() => void runDelete()}
            disabled={isBusy && submitting !== "delete"}
            aria-busy={submitting === "delete" || undefined}
          >
            {submitting === "delete"
              ? "Deleting"
              : confirmingDelete
                ? "Confirm delete"
                : "Delete permanently"}
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void runMove()}
            disabled={isBusy && submitting !== "move"}
            aria-busy={submitting === "move" || undefined}
          >
            {submitting === "move" ? "Moving" : "Move to default"}
          </button>
        </>
      }
    >
      <div className="profile-data-removal-body">
        <p>Choose what to do with the data before June deletes the profile.</p>
        {confirmingDelete ? (
          <p className="profile-data-removal-warning">
            This can't be undone. Confirm delete to permanently remove this profile's data.
          </p>
        ) : null}
        {error ? (
          <p className="settings-row-error profiles-inline-error" role="alert">
            <IconExclamationCircle size={14} ariaHidden />
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function profileDataSummaryText(
  summary: NonNullable<ProfileManagerState["pendingRemoval"]>["summary"],
) {
  return `This profile has ${countLabel(summary.notes, "note")}, ${countLabel(
    summary.sessions,
    "session",
  )}, ${countLabel(summary.dictation, "dictation")}, ${countLabel(
    summary.folders,
    "project",
  )}, ${countLabel(summary.memories, "memory", "memories")}.`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <EmptyStateSurface
      className="empty-state-compact"
      icon={<IconRobot2 size={22} />}
      title={title}
      description={description}
    />
  );
}

function ErrorState({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="settings-card profile-builder-empty" role="alert">
      <span className="profile-builder-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="profile-builder-empty-title">Couldn't load profiles</p>
      <p className="profile-builder-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="primary-action primary-solid" onClick={onRetry}>
          <IconArrowRotateClockwise size={14} ariaHidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}

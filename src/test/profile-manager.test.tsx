import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteHermesSession: vi.fn(),
  deleteProfileData: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  listSessionProfiles: vi.fn(),
  moveProfileDataToDefault: vi.fn(),
  profileDataSummary: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  deleteProfileData: mocks.deleteProfileData,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  listSessionProfiles: mocks.listSessionProfiles,
  moveProfileDataToDefault: mocks.moveProfileDataToDefault,
  profileDataSummary: mocks.profileDataSummary,
}));

vi.mock("../lib/hermes-adapter", () => ({
  deleteHermesSession: mocks.deleteHermesSession,
}));

import {
  ProfileManagerController,
  canActivateProfile,
  canMutateProfiles,
  canRemoveProfile,
  orderProfiles,
  parseActiveProfile,
  useProfileManagerController,
  type ProfileManagerEngine,
} from "../lib/hermes-admin";
import {
  getActiveHermesProfileName,
  PROFILE_DATA_CHANGED_EVENT,
  resetActiveHermesProfileForTests,
  type ProfileDataChangedDetail,
} from "../lib/active-hermes-profile";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

const EMPTY_SUMMARY = { notes: 0, dictation: 0, folders: 0, sessions: 0, memories: 0 };

// ---------------------------------------------------------------------------
// Schema parsing.
// ---------------------------------------------------------------------------

describe("profile manager - active profile parsing", () => {
  it("falls back to default for missing or empty fields", () => {
    expect(parseActiveProfile({})).toEqual({ active: "default", current: "default" });
    expect(parseActiveProfile({ active: "", current: "" })).toEqual({
      active: "default",
      current: "default",
    });
    expect(parseActiveProfile(null)).toEqual({ active: "default", current: "default" });
  });

  it("reads active and current independently", () => {
    expect(parseActiveProfile({ active: "research", current: "default" })).toEqual({
      active: "research",
      current: "default",
    });
  });
});

// ---------------------------------------------------------------------------
// Pure view helpers.
// ---------------------------------------------------------------------------

describe("profile manager - view helpers", () => {
  it("orders default first, then names alphabetically", () => {
    const ordered = orderProfiles([
      { name: "zeta", raw: {} },
      { name: "default", raw: {} },
      { name: "alpha", raw: {} },
    ]);
    expect(ordered.map((profile) => profile.name)).toEqual(["default", "alpha", "zeta"]);
  });

  it("blocks activating the already-active profile", () => {
    expect(canActivateProfile("default", "default", true)).toEqual({
      ok: false,
      reason: "This profile is already active.",
    });
    expect(canActivateProfile("research", "default", true)).toEqual({ ok: true });
    expect(canActivateProfile("research", "default", false)).toEqual({
      ok: false,
      reason: "Can't confirm which profile is active. Refresh and try again.",
    });
  });

  it("blocks deleting default and active profiles", () => {
    expect(canRemoveProfile("default", "research", true)).toEqual({
      ok: false,
      reason: "The default profile can't be deleted.",
    });
    expect(canRemoveProfile("research", "research", true)).toEqual({
      ok: false,
      reason: "Switch to another profile before deleting this one.",
    });
    expect(canRemoveProfile("writing", "research", true)).toEqual({ ok: true });
    expect(canRemoveProfile("writing", "research", false)).toEqual({
      ok: false,
      reason: "Can't confirm which profile is active. Refresh and try again.",
    });
  });

  it("blocks mutations when the active profile is unconfirmed", () => {
    expect(canMutateProfiles(false)).toEqual({
      ok: false,
      reason: "Can't confirm which profile is active. Refresh and try again.",
    });
    expect(canMutateProfiles(true)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Hook and controller flows.
// ---------------------------------------------------------------------------

describe("profile manager - hook flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileDataSummary.mockResolvedValue(EMPTY_SUMMARY);
    mocks.moveProfileDataToDefault.mockResolvedValue(undefined);
    mocks.deleteProfileData.mockResolvedValue(undefined);
    mocks.listSessionProfiles.mockResolvedValue([]);
    mocks.deleteHermesSession.mockResolvedValue(undefined);
  });

  it("loads the list and active profile from separate endpoints", async () => {
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "research",
    });
    const { result } = renderHook(() =>
      useProfileManagerController(harness as ProfileManagerEngine),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.profiles.map((profile) => profile.name)).toEqual(["default", "research"]);
    expect(result.current.activeName).toBe("research");
    expect(result.current.activeConfirmed).toBe(true);
  });

  it("activate success updates activeName after reloading", async () => {
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
    });
    const { result } = renderHook(() =>
      useProfileManagerController(harness as ProfileManagerEngine),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.activate("research");
    });

    expect(result.current.activeName).toBe("research");
    expect(result.current.activeConfirmed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("activate 404 surfaces an error and does not change activeName", async () => {
    const harness = makeAdminHarness({
      profiles: [{ name: "default", active: true }],
    });
    const { result } = renderHook(() =>
      useProfileManagerController(harness as ProfileManagerEngine),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      const ok = await result.current.activate("missing");
      expect(ok).toBe(false);
    });

    expect(result.current.activeName).toBe("default");
    expect(result.current.activeConfirmed).toBe(true);
    expect(result.current.error).toBe("That Hermes resource was not found.");
  });

  it("remove success drops the profile from the list", async () => {
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
        { name: "writing", active: false },
      ],
    });
    const { result } = renderHook(() =>
      useProfileManagerController(harness as ProfileManagerEngine),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.beginRemove("research");
    });

    expect(result.current.profiles.map((profile) => profile.name)).toEqual(["default", "writing"]);
    expect(mocks.profileDataSummary).toHaveBeenCalledWith("research");
    expect(mocks.moveProfileDataToDefault).not.toHaveBeenCalled();
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
  });

  it("begin remove with owned data opens pending removal and does not delete Hermes profile", async () => {
    mocks.profileDataSummary.mockResolvedValue({
      notes: 2,
      dictation: 3,
      folders: 4,
      sessions: 1,
      memories: 5,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();

    const ok = await controller.beginRemove("research");

    expect(ok).toBe(false);
    expect(controller.getSnapshot().pendingRemoval).toEqual({
      name: "research",
      summary: { notes: 2, dictation: 3, folders: 4, sessions: 1, memories: 5 },
    });
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("treats a memory-only profile as data-owning", async () => {
    mocks.profileDataSummary.mockResolvedValue({
      notes: 0,
      dictation: 0,
      folders: 0,
      sessions: 0,
      memories: 1,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();

    const ok = await controller.beginRemove("research");

    expect(ok).toBe(false);
    expect(controller.getSnapshot().pendingRemoval?.summary.memories).toBe(1);
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("confirm removal with move retags data before deleting the Hermes profile", async () => {
    mocks.profileDataSummary.mockResolvedValue({
      notes: 1,
      dictation: 0,
      folders: 0,
      sessions: 1,
      memories: 0,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();
    await controller.beginRemove("research");
    const dataChanged = vi.fn();
    const handleDataChanged = (event: Event) => {
      dataChanged((event as CustomEvent<ProfileDataChangedDetail>).detail);
    };
    window.addEventListener(PROFILE_DATA_CHANGED_EVENT, handleDataChanged);

    const ok = await controller.confirmRemoval("move");

    expect(ok).toBe(true);
    expect(dataChanged).toHaveBeenCalledWith({ profile: "default" });
    window.removeEventListener(PROFILE_DATA_CHANGED_EVENT, handleDataChanged);
    expect(mocks.moveProfileDataToDefault).toHaveBeenCalledWith("research");
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(true);
    expect(controller.getSnapshot().pendingRemoval).toBeNull();
    controller.dispose();
  });

  it("confirm removal with delete deletes data before deleting the Hermes profile", async () => {
    mocks.profileDataSummary.mockResolvedValue({
      notes: 0,
      dictation: 1,
      folders: 0,
      sessions: 2,
      memories: 0,
    });
    // Hermes owns the chat transcripts: delete-permanently must remove the
    // profile's sessions themselves, not just June's mapping rows — an
    // unmapped session would resurface under default.
    mocks.listSessionProfiles.mockResolvedValue([
      { sessionId: "chat-1", profile: "research" },
      { sessionId: "chat-2", profile: "research" },
      { sessionId: "chat-3", profile: "other" },
    ]);
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();
    await controller.beginRemove("research");

    const ok = await controller.confirmRemoval("delete");

    expect(ok).toBe(true);
    expect(mocks.deleteHermesSession).toHaveBeenCalledTimes(2);
    expect(mocks.deleteHermesSession).toHaveBeenCalledWith("chat-1");
    expect(mocks.deleteHermesSession).toHaveBeenCalledWith("chat-2");
    expect(mocks.deleteProfileData).toHaveBeenCalledWith("research");
    expect(mocks.moveProfileDataToDefault).not.toHaveBeenCalled();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(true);
    expect(controller.getSnapshot().pendingRemoval).toBeNull();
    controller.dispose();
  });

  it("aborts permanent removal when a Hermes chat delete fails", async () => {
    mocks.profileDataSummary.mockResolvedValue({
      notes: 0,
      dictation: 0,
      folders: 0,
      sessions: 1,
      memories: 0,
    });
    mocks.listSessionProfiles.mockResolvedValue([{ sessionId: "chat-1", profile: "research" }]);
    mocks.deleteHermesSession.mockRejectedValue(new Error("session delete failed"));
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();
    await controller.beginRemove("research");

    const ok = await controller.confirmRemoval("delete");

    // The mapping rows and profile survive so a retry can converge — the
    // pinned runtime treats deleting an already-absent session as success.
    expect(ok).toBe(false);
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(false);
    expect(controller.getSnapshot().error).toContain("session delete failed");
    controller.dispose();
  });

  it("cancel removal clears pending removal without deleting anything", async () => {
    mocks.profileDataSummary.mockResolvedValue({
      notes: 1,
      dictation: 1,
      folders: 1,
      sessions: 1,
      memories: 0,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();
    await controller.beginRemove("research");

    controller.cancelRemoval();

    expect(controller.getSnapshot().pendingRemoval).toBeNull();
    expect(mocks.moveProfileDataToDefault).not.toHaveBeenCalled();
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("remove guard for the active profile never issues the HTTP call", async () => {
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: false },
        { name: "research", active: true },
      ],
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();

    const ok = await controller.beginRemove("research");

    expect(ok).toBe(false);
    expect(controller.getSnapshot().error).toBe(
      "Switch to another profile before deleting this one.",
    );
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("rechecks the sticky active profile before deleting", async () => {
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();
    expect(controller.getSnapshot().activeName).toBe("default");

    Object.assign(harness.server, { activeProfile: "research" });
    const ok = await controller.beginRemove("research");

    expect(ok).toBe(false);
    expect(controller.getSnapshot().activeName).toBe("research");
    expect(controller.getSnapshot().activeConfirmed).toBe(true);
    expect(controller.getSnapshot().error).toBe(
      "Switch to another profile before deleting this one.",
    );
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("keeps a successful action true but blocks later writes when reload cannot confirm active", async () => {
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
        { name: "writing", active: false },
      ],
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);
    await controller.load();
    expect(controller.getSnapshot().activeConfirmed).toBe(true);

    harness.server.setProfileActiveError({
      status: 503,
      code: "unavailable",
      error: "not available",
    });
    const activated = await controller.activate("research");

    expect(activated).toBe(true);
    expect(controller.getSnapshot().activeName).toBe("default");
    expect(controller.getSnapshot().activeConfirmed).toBe(false);

    const removed = await controller.beginRemove("writing");

    expect(removed).toBe(false);
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/writing",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("fails closed when the active profile cannot be confirmed", async () => {
    const profiles = [
      { name: "default", active: false },
      { name: "research", active: true },
    ];
    const harness = makeAdminHarness({
      profiles,
      activeProfile: "research",
      profileActiveError: { status: 503, code: "unavailable", error: "not available" },
    });
    harness.cache.set("profiles", profiles);
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);

    await controller.load();

    expect(controller.getSnapshot().status).toBe("ready");
    expect(controller.getSnapshot().activeName).toBe("default");
    expect(controller.getSnapshot().activeConfirmed).toBe(false);

    const ok = await controller.beginRemove("research");

    expect(ok).toBe(false);
    expect(controller.getSnapshot().error).toBe(
      "Can't confirm which profile is active. Refresh and try again.",
    );
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/research",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("feeds the app-global store from a confirmed active read on load", async () => {
    resetActiveHermesProfileForTests();
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: false },
        { name: "research", active: true },
      ],
      activeProfile: "research",
    });
    const controller = new ProfileManagerController(harness as ProfileManagerEngine);

    await controller.load();

    expect(getActiveHermesProfileName()).toBe("research");
    controller.dispose();
    resetActiveHermesProfileForTests();
  });
});

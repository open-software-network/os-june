import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  resetActiveHermesProfileForTests,
} from "../lib/active-hermes-profile";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

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
      await result.current.remove("research");
    });

    expect(result.current.profiles.map((profile) => profile.name)).toEqual(["default", "writing"]);
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

    const ok = await controller.remove("research");

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

    const removed = await controller.remove("writing");

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

    const ok = await controller.remove("research");

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
